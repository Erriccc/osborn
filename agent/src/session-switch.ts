/**
 * Session-switch decision (#74) — pure, no I/O.
 *
 * Decides which Claude session the NEXT user message runs in, given what the
 * persistent query is running now, any armed/pending switch, and whether a turn
 * is in flight. Also says what happens to the session being left.
 *
 * Why this exists: a switch used to only ARM a resume target
 * (setResumeSessionId). While a persistent query was live, pushMessage's fast
 * path kept pushing into it, so the next turn ran in the OLD session and init
 * then reported session_resume_failed {requested: new, actual: old}. Any caller
 * that is about to push a message (or that handles an explicit switch request)
 * asks this function first; 'switch' means the live query must be rebuilt on
 * `runIn` before the message is delivered.
 *
 * Owner decision (2026-11-10): the session being left KEEPS WORKING in the
 * background until its current turn finishes — it is never aborted. So a busy
 * session is never 'close'd here; it is 'background'.
 */

export interface SessionSwitchState {
  /** Session id the live query reported via SDK init (null until the first init). */
  liveSessionId: string | null
  /** The `resume` id the live query was spawned with (null = started fresh / no query). */
  queryResumeTarget: string | null
  /** The currently armed resume target (setResumeSessionId / opts.resumeSessionId). */
  resumeTarget: string | null
  /** Explicit switch request (switch_session / Rooms click). Wins over resumeTarget. */
  requestedTarget?: string | null
  /** A persistent query (subprocess) is alive. */
  hasLiveQuery: boolean
  /** A turn (or work it started) is still running in the live query. */
  turnInFlight: boolean
}

export type SessionSwitchAction =
  /** Deliver into the live query — it is already running `runIn`. */
  | 'push'
  /** No live query: the next message cold-starts (resuming `runIn`, or new when null). */
  | 'cold-start'
  /** The live query runs a different session: rebuild it on `runIn` first. */
  | 'switch'

export type LeftSessionFate =
  /** Nothing is being left. */
  | 'none'
  /** The left session is idle — closing its subprocess loses nothing. */
  | 'close'
  /** The left session has work in flight — keep it running in the background. */
  | 'background'

export interface SessionSwitchDecision {
  action: SessionSwitchAction
  /** Session the next message runs in (null = a brand-new session). */
  runIn: string | null
  leave: LeftSessionFate
}

const norm = (v: string | null | undefined): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

export function decideNextSession(state: SessionSwitchState): SessionSwitchDecision {
  const liveId = norm(state.liveSessionId)
  const spawnedFor = norm(state.queryResumeTarget)
  const armed = norm(state.resumeTarget)
  const requested = norm(state.requestedTarget)

  if (!state.hasLiveQuery) {
    return { action: 'cold-start', runIn: requested ?? armed ?? liveId, leave: 'none' }
  }

  // What the live query is actually running. Before its first init the id is
  // unknown, but a query spawned with `resume: X` is running X.
  const running = liveId ?? spawnedFor

  // An armed target counts as a pending switch only if this query was not
  // already spawned for it. If it was (and init reported a different id), the
  // resume was attempted and the SDK fell back — rebuilding again on every turn
  // would loop, so that case stays on the live query.
  const pending = armed && armed !== spawnedFor && armed !== running ? armed : null
  const target = requested ?? pending

  if (!target || target === running) {
    return { action: 'push', runIn: running, leave: 'none' }
  }

  return { action: 'switch', runIn: target, leave: state.turnInFlight ? 'background' : 'close' }
}

// ── Executor plan (S3): what to DO with a decision, given live context ────────
//
// Interim behaviour until true background-on-leave ships (demoteSupported):
// FINISH-THEN-SWITCH. A switch requested while the current session is busy is
// deferred until it goes idle (its turn finishes normally), unless the user
// forces it ("Switch now" — today's behaviour: the old session's work stops).
// A pending permission is never queued silently: the user answers it or forces.

export interface SwitchPlanContext {
  /** A permission prompt is waiting on the user in the current session. */
  permissionPending: boolean
  /** A Recall meeting bot is live (its transcript feeds the current session). */
  meetingActive: boolean
  /** The target already runs as a background slot: none / idle / busy. */
  targetSlot: 'none' | 'idle' | 'busy'
  /** User chose "Switch now". */
  force: boolean
  /** Phase 2: a busy session can be demoted to the background instead of closed. */
  demoteSupported: boolean
}

export type SwitchPlanKind = 'noop' | 'execute' | 'defer' | 'reject'
export type SwitchPlanReason =
  | 'already_live'
  | 'meeting_active'
  | 'target_busy_in_background'
  | 'needs_you'
  | 'busy'
  | 'forced'
  | 'idle'
  | 'no_live_query'
  | 'demote'

export interface SwitchPlan {
  kind: SwitchPlanKind
  reason: SwitchPlanReason
  /** What happens to the session being left when this executes. */
  leave: LeftSessionFate
  /** The target runs as an idle background slot: stop it before resuming it. */
  stopSlotFirst: boolean
}

export function planSwitch(decision: SessionSwitchDecision, ctx: SwitchPlanContext): SwitchPlan {
  const stopSlotFirst = ctx.targetSlot === 'idle'
  const plan = (kind: SwitchPlanKind, reason: SwitchPlanReason, leave: LeftSessionFate = 'none'): SwitchPlan =>
    ({ kind, reason, leave, stopSlotFirst: kind === 'execute' && stopSlotFirst })

  if (decision.action === 'push') return plan('noop', 'already_live')
  // The meeting transcript and the meeting brain belong to the current session.
  if (ctx.meetingActive) return plan('reject', 'meeting_active')
  // Never run a second process on a JSONL a busy background slot is writing.
  if (ctx.targetSlot === 'busy') return plan('reject', 'target_busy_in_background')

  if (decision.action === 'cold-start') return plan('execute', 'no_live_query')

  if (decision.leave === 'background') {
    if (ctx.demoteSupported) return plan('execute', 'demote', 'background')
    if (ctx.force) return plan('execute', 'forced', 'close')
    if (ctx.permissionPending) return plan('reject', 'needs_you')
    return plan('defer', 'busy')
  }
  return plan('execute', 'idle', decision.leave)
}

// ── Executor helpers (S4 / S7), pure ─────────────────────────────────────────

export interface SessionCwdDeps {
  /** sessionExists(id, projectPath) from config.ts. */
  exists: (sessionId: string, cwd: string) => boolean
  /** Find ONE session's project dir (scanSlugCwd), or null. */
  lookupCwd: (sessionId: string) => Promise<string | null | undefined>
}

/**
 * The project directory a session's JSONL resolves under (what `--resume`
 * needs as cwd): the client's hint if the session really lives there, else
 * the current dir, else a one-session scan of the project slugs.
 * null = the session does not exist ("Session not found"). A candidate is
 * only returned after `exists()` confirms it.
 */
export async function resolveSessionCwd(
  sessionId: string,
  hint: string | null | undefined,
  currentDir: string | null | undefined,
  deps: SessionCwdDeps,
): Promise<string | null> {
  if (!sessionId) return null
  for (const c of [hint, currentDir]) {
    if (c && deps.exists(sessionId, c)) return c
  }
  let c: string | null | undefined = null
  try { c = await deps.lookupCwd(sessionId) } catch { c = null }
  return c && deps.exists(sessionId, c) ? c : null
}

/**
 * chatCtx rebuild on switch (4.13): keep the agent's non-conversation items
 * (instructions, system/developer notes, non-message items) and drop the old
 * session's user/assistant turns so the fast brain and noise gate stop
 * reasoning over the session that was left.
 */
export function keepNonConversationItems<T extends { type?: string; role?: string }>(items: T[] | null | undefined): T[] {
  return (items ?? []).filter((it) => it?.type !== 'message' || (it.role !== 'user' && it.role !== 'assistant'))
}

/**
 * Session to resume when the voice session auto-recovers (D7): the live id,
 * else the session the user switched to (B may not have had its first turn,
 * so it has no live id yet), else the connect-time id.
 */
export function recoverySessionId(ids: {
  liveSessionId: string | null | undefined
  switchedTo: string | null | undefined
  connectTime: string | null | undefined
}): string | undefined {
  return ids.liveSessionId || ids.switchedTo || ids.connectTime || undefined
}

/** Keep-warm key: the init id, else the id the live query was spawned for. */
export function warmParkKey(llm: { sessionId?: string | null; spawnedResumeId?: string | null } | null | undefined): string | null {
  return llm?.sessionId || llm?.spawnedResumeId || null
}

/**
 * Directory /session-messages reads a session's store from (S8): the
 * requested workingDirectory only when the session really lives there,
 * otherwise the agent's boot dir (today's behaviour). Never trusts the param.
 */
export function sessionMessagesDir(
  sessionId: string,
  requested: string | null | undefined,
  bootDir: string,
  exists: (sessionId: string, cwd: string) => boolean,
): string {
  if (requested && sessionId) {
    try { if (exists(sessionId, requested)) return requested } catch { /* fall through */ }
  }
  return bootDir
}

// ── Review minors ────────────────────────────────────────────────────────────

/**
 * Single-flight guard for performSessionSwitch. Only the critical section
 * (teardown + arm + session_switched) holds the guard; `after` (the spoken
 * acknowledgment) runs fire-and-forget once it is released, so a say() that
 * never resolves can't wedge every later switch. A request that arrives while
 * the guard is held returns { ran: false } — the caller must reply so the UI
 * never hangs.
 */
export function createSwitchGuard() {
  let busy = false
  return {
    get busy() { return busy },
    async run<T>(critical: () => Promise<T>, after?: (result: T) => unknown): Promise<{ ran: true; result: T } | { ran: false }> {
      if (busy) return { ran: false }
      busy = true
      let result: T
      try { result = await critical() } finally { busy = false }
      if (after) {
        try { void Promise.resolve(after(result)).catch(() => {}) } catch { /* sync throw */ }
      }
      return { ran: true, result }
    },
  }
}

/**
 * Find a session's project dir by scanning ~/.claude/projects/<slug>/<id>.jsonl
 * and decoding the slug (the same recovery resume_session has always used).
 * The decoding is lossy, so only a decoded path that EXISTS is returned — the
 * switch executor never creates directories for scan-derived paths.
 *
 * The `readCwd` fallback gets that same existence check, because an imported
 * session's JSONL can record a cwd from another machine while sessionExists()
 * only looks at the slug.
 */
export async function scanSlugCwd(
  sessionId: string,
  projectsDir: string,
  fsx: {
    readdir: (dir: string) => string[]
    exists: (path: string) => boolean
    /** slugToPath(slug) from config.ts: the lossy reverse, '' when it misses. */
    decodeSlug: (slug: string) => string
    /** extractCwd(filePath) from config.ts: the cwd the JSONL itself records. */
    readCwd: (filePath: string) => Promise<string | null | undefined>
  },
): Promise<string | null> {
  if (!sessionId || !fsx.exists(projectsDir)) return null
  let slugs: string[] = []
  try { slugs = fsx.readdir(projectsDir) } catch { return null }
  let firstMatch: string | null = null
  for (const slug of slugs) {
    const filePath = `${projectsDir}/${slug}/${sessionId}.jsonl`
    if (!fsx.exists(filePath)) continue
    if (!firstMatch) firstMatch = filePath
    const recovered = fsx.decodeSlug(slug)
    if (recovered && recovered !== '/') return recovered
  }
  if (!firstMatch) return null
  try {
    const recorded = await fsx.readCwd(firstMatch)
    return recorded && fsx.exists(recorded) ? recorded : null
  } catch { return null }
}
