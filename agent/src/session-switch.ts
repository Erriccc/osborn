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
