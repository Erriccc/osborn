// ============================================================
// SESSION-LIST HYGIENE (#107) — pure, client-safe (no React, no Node imports)
// ============================================================
// One shared, testable core for the two human-facing session lists (the Rooms
// rail in /chat and the dashboard Projects panel). It turns the raw session
// list — which on a busy machine is ~95% auto-spawned sub-agent/verifier runs
// and carries the SAME session id under several slug folders (1092 duplicate
// ids on the owner's machine, the "three identical Rooms rows" complaint) —
// into a clean list:
//
//   1. dedupeSessions   — collapse rows that share a sessionId into one,
//                         keeping the copy `--resume` actually opens.
//   2. collapseForks    — group forked sessions (different id, same first turn)
//                         under one row with an "N forks" count.
//   3. isSystemSession  — recognise internal/auto sessions (meeting/bot/system
//                         markers, sub-agent / verifier / tester prompts) so a
//                         toggle can hide them from the human list.
//   4. sessionMatchesQuery — free-text search over title / preview / project.
//
// `prepareSessions` runs the whole pipeline and is what both surfaces call.
// Everything here is a pure function of its inputs so it can be unit-tested
// without a browser (tests/session-list.test.ts).

import {
  deriveSessionTitle,
  prettySessionPreview,
  sessionActivityTime,
  UNTITLED_SESSION,
  type SessionListFields,
} from './sessions'

/** The shape the hygiene helpers read. Every extra field is optional so the
 * dashboard's SessionInfo, the rail's RoomSessionInput and partial shapes all
 * satisfy it. */
export interface SessionListItem extends SessionListFields {
  sessionId: string
  messageCount?: number
  /** Slug-derived cwd — where Claude Code's `--resume` looks the session up. */
  cwd?: string
  /** Original cwd from the JSONL content (display / project grouping). */
  projectPath?: string
  firstTs?: string | null
}

// ── 3. System / auto-spawned session detection ────────────────────────────
// The owner's machine is dominated by sessions the agent spawns for itself:
// reasoner/reviewer sub-agents ("Use the reasoner sub-agent…") and
// verify/test runs ("Run tests and verify…"). These, plus the machine-tagged
// meeting/task/system sessions, are what the "Show system sessions" toggle
// hides. We match on the agent-supplied title AND the raw last-message preview
// (either can hold the first user turn, depending on agent version). The
// patterns are deliberately anchored to agent-internal phrasings so a human's
// own conversation is not caught — a person does not normally open a chat with
// "Use the reasoner sub-agent to …".
// Conservative on purpose: anchored to agent-internal phrasings so a human's
// own task ("verify the invoice total") is NOT caught. The dominant noise is
// sub-agent / verifier / tester runs, which these cover.
export const SYSTEM_PROMPT_PATTERNS: RegExp[] = [
  /\bsub-?agents?\b/i, // reasoner / reviewer / researcher / writer sub-agent
  /^\s*use the\b[^.]*\bagent\b/i, // "Use the <role> agent to …"
  /^\s*run tests? and verify\b/i, // the cited auto verify-run prompt
  /\b(verifier|tester)\b/i, // dispatched role names
  /^\s*\[system\]/i, // explicit system marker that isn't a meeting
]

/**
 * True when a session is internal/auto-spawned rather than a human
 * conversation: a tagged meeting or background task, or a prompt that matches
 * the agent's own sub-agent / verify / test phrasings. Each candidate field
 * (the agent-cleaned title and the raw preview) is tested on its own so the
 * `^`-anchored patterns see the real start of the text.
 */
export function isSystemSession(s: SessionListItem): boolean {
  const kind = prettySessionPreview(s).kind
  if (kind === 'meeting' || kind === 'task') return true
  const fields = [typeof s.title === 'string' ? s.title : '', s.lastMessage || '']
  return fields.some((text) => text && SYSTEM_PROMPT_PATTERNS.some((re) => re.test(text)))
}

// ── 1. Dedupe copies (same session id across slug folders) ─────────────────
function activityMs(s: SessionListFields): number {
  const ms = new Date(sessionActivityTime(s)).getTime()
  return Number.isNaN(ms) ? 0 : ms
}

/**
 * When the same session id appears more than once (the same session filed
 * under several slug folders), keep ONE copy: the one `--resume` opens. The
 * resume target is the copy that carries a slug-derived `cwd`; among those we
 * prefer the fullest (highest message count) and then the most recently
 * active, so the surviving row has the best title/time/project. First-seen
 * order is otherwise preserved.
 */
export function dedupeSessions<T extends SessionListItem>(sessions: T[]): T[] {
  const order: string[] = []
  const best = new Map<string, T>()
  for (const s of sessions) {
    if (!s || !s.sessionId) continue
    const prev = best.get(s.sessionId)
    if (!prev) {
      best.set(s.sessionId, s)
      order.push(s.sessionId)
      continue
    }
    if (preferCopy(s, prev)) best.set(s.sessionId, s)
  }
  return order.map((id) => best.get(id)!)
}

/** Should `a` replace `b` as the kept copy of a duplicated session id? */
function preferCopy(a: SessionListItem, b: SessionListItem): boolean {
  const aCwd = !!a.cwd
  const bCwd = !!b.cwd
  if (aCwd !== bCwd) return aCwd // the copy with a resume cwd wins
  const aMsg = a.messageCount ?? 0
  const bMsg = b.messageCount ?? 0
  if (aMsg !== bMsg) return aMsg > bMsg
  return activityMs(a) > activityMs(b)
}

// ── 2. Collapse forks (different id, same first turn) ──────────────────────
/** A fork copies its parent's transcript up to the branch point, so the forks
 * share the first record's timestamp AND the derived title (the first user
 * turn). We key on both and only when `firstTs` is a real timestamp and the
 * title is not the generic "Untitled session" — distinct real sessions started
 * at different moments get different keys, so this cannot merge unrelated
 * conversations. */
function forkKey(s: SessionListItem): string | null {
  const ts = typeof s.firstTs === 'string' ? s.firstTs : ''
  if (!ts || Number.isNaN(new Date(ts).getTime())) return null
  const title = deriveSessionTitle(s)
  if (!title || title === UNTITLED_SESSION) return null
  return `${ts}\u0001${title.toLowerCase()}`
}

export interface ForkGroup<T> {
  /** The row shown — the fullest/most-recent member of the fork family. */
  primary: T
  /** Number of sibling forks collapsed under `primary` (0 when not a fork). */
  forkCount: number
  /** Session ids of the collapsed siblings (not including `primary`). */
  forkIds: string[]
}

/**
 * Collapse fork families into one representative row each. Input should be
 * deduped first. Output preserves first-seen order of the surviving primaries.
 * The primary is the fullest member (highest message count), tie-broken by
 * most recent activity, so the row you keep is the trunk of the fork family.
 */
export function collapseForks<T extends SessionListItem>(sessions: T[]): ForkGroup<T>[] {
  const groups = new Map<string, T[]>()
  const order: string[] = [] // group keys (or a unique key per non-fork), first-seen
  const singletons: T[] = []
  for (const s of sessions) {
    const key = forkKey(s)
    if (!key) {
      order.push(`@solo:${singletons.length}`)
      singletons.push(s)
      continue
    }
    if (!groups.has(key)) {
      groups.set(key, [])
      order.push(key)
    }
    groups.get(key)!.push(s)
  }
  let soloIdx = 0
  const out: ForkGroup<T>[] = []
  for (const key of order) {
    if (key.startsWith('@solo:')) {
      out.push({ primary: singletons[soloIdx++], forkCount: 0, forkIds: [] })
      continue
    }
    const members = groups.get(key)!
    if (members.length === 1) {
      out.push({ primary: members[0], forkCount: 0, forkIds: [] })
      continue
    }
    const sorted = [...members].sort((a, b) => {
      const am = a.messageCount ?? 0
      const bm = b.messageCount ?? 0
      if (am !== bm) return bm - am
      return activityMs(b) - activityMs(a)
    })
    const [primary, ...rest] = sorted
    out.push({ primary, forkCount: rest.length, forkIds: rest.map((r) => r.sessionId) })
  }
  return out
}

// ── 4. Search over title / preview / project ──────────────────────────────
function projectLeaf(s: SessionListItem): string {
  const p = s.projectPath || s.cwd || ''
  const seg = p.replace(/\/+$/, '').split('/').filter(Boolean)
  return seg.length ? seg[seg.length - 1] : ''
}

/** Case-insensitive match of `query` against the session's title, cleaned
 * preview text and project name. Blank query matches everything. */
export function sessionMatchesQuery(s: SessionListItem, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const pv = prettySessionPreview(s)
  const hay = [deriveSessionTitle(s), pv.text, pv.label, projectLeaf(s), s.projectPath || s.cwd || '']
    .join(' \u0001 ')
    .toLowerCase()
  return hay.includes(q)
}

// ── Pipeline ───────────────────────────────────────────────────────────────
export interface PrepareOptions {
  /** Free-text filter. Blank/undefined = no filter. */
  search?: string
  /** Hide internal/auto sessions. Default true (toggle shows them). */
  hideSystem?: boolean
}

export interface PreparedList<T> {
  /** The sessions to render, deduped and fork-collapsed, after filters. */
  sessions: T[]
  /** sessionId → number of forks collapsed under it (only ids with > 0). */
  forkCountById: Map<string, number>
  /** How many non-system sessions exist (for an empty-search hint). */
  visibleCount: number
  /** How many system sessions were (or would be) hidden — the toggle's "(N)". */
  systemCount: number
}

/**
 * Full hygiene pass shared by the rail and the dashboard:
 * dedupe → collapse forks → hide system (optional) → search (optional).
 */
export function prepareSessions<T extends SessionListItem>(
  sessions: T[],
  opts: PrepareOptions = {},
): PreparedList<T> {
  const hideSystem = opts.hideSystem !== false
  const deduped = dedupeSessions(sessions)
  const families = collapseForks(deduped)

  const forkCountById = new Map<string, number>()
  for (const f of families) {
    if (f.forkCount > 0) forkCountById.set(f.primary.sessionId, f.forkCount)
  }

  const primaries = families.map((f) => f.primary)
  const systemCount = primaries.filter((s) => isSystemSession(s)).length
  const visibleCount = primaries.length - systemCount

  let out = primaries
  if (hideSystem) out = out.filter((s) => !isSystemSession(s))
  if (opts.search && opts.search.trim()) {
    out = out.filter((s) => sessionMatchesQuery(s, opts.search!))
  }

  return { sessions: out, forkCountById, visibleCount, systemCount }
}
