// ============================================================
// SESSION-LIST HYGIENE (#107) — pure, client-safe (no React, no Node imports)
// ============================================================
// One shared, testable core for the two human-facing session lists (the Rooms
// rail in /chat and the dashboard Projects panel). It does two things only:
//
//   1. dedupeSessions   — collapse rows that are the SAME session (same id, or
//                         the 8-char short form of it) into one, keeping the
//                         copy `--resume` actually opens. This is the fix for
//                         the "three identical Rooms rows" complaint: 1092
//                         duplicate ids on the owner's machine, one per slug
//                         folder the session was filed under.
//   2. isSystemSession  — recognise the sessions the MACHINE wrote rather than
//                         a person: a bot meeting transcript or a background
//                         task notification. Only the markers the agent itself
//                         emits count, so an opt-in toggle can hide them.
//
// Do NOT add prompt-text classification back (it hid real sessions, and
// `lastMessage` is the LAST user turn, not the first) or fork collapse (it
// merged different sessions on a 6-word title and left no path to the one it
// dropped). `prepareSessions` runs the pass and is what both surfaces call.

import { sameSession } from './rooms'
import { prettySessionPreview, sessionActivityMs, type SessionListFields } from './sessions'

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
}

// ── System / machine-written session detection ────────────────────────────
/**
 * True when the session was written by the machine rather than opened by a
 * person: a bot meeting transcript (`[MEETING — <botId>]:`, `[SYSTEM] … in a
 * meeting`) or a background task notification (`<task-notification>`).
 *
 * This reads ONLY the markers the agent emits itself — classified by
 * `prettySessionPreview`, which is also what the row renders — so a human
 * conversation can never be caught by it. It does not try to infer intent from
 * prompt wording.
 */
function isSystemSession(s: SessionListItem): boolean {
  const kind = prettySessionPreview(s).kind
  return kind === 'meeting' || kind === 'task'
}

// ── Dedupe copies (same session under several slug folders) ────────────────
/**
 * When the same session appears more than once (the same session filed under
 * several slug folders, or once by full id and once by its 8-char short form),
 * keep ONE copy: the one `--resume` opens. The resume target is the copy that
 * carries a slug-derived `cwd`; among those we prefer the fullest (highest
 * message count) and then the most recently active, so the surviving row has
 * the best title/time/project. First-seen order is otherwise preserved.
 *
 * Identity is `sameSession` (lib/rooms), the same rule the rows use, bucketed
 * by id prefix to stay linear — so the two can't drift apart.
 */
function dedupeSessions<T extends SessionListItem>(sessions: T[]): T[] {
  const order: string[] = []
  const best = new Map<string, T>()
  const byPrefix = new Map<string, string[]>()
  for (const s of sessions) {
    if (!s || !s.sessionId) continue
    const prefix = s.sessionId.substring(0, 8)
    const bucket = byPrefix.get(prefix)
    const key = bucket?.find((k) => sameSession(k, s.sessionId))
    if (key === undefined) {
      best.set(s.sessionId, s)
      order.push(s.sessionId)
      if (bucket) bucket.push(s.sessionId)
      else byPrefix.set(prefix, [s.sessionId])
      continue
    }
    if (preferCopy(s, best.get(key)!)) best.set(key, s)
  }
  return order.map((id) => best.get(id)!)
}

/** Should `a` replace `b` as the kept copy of a duplicated session? */
function preferCopy(a: SessionListItem, b: SessionListItem): boolean {
  const aCwd = !!a.cwd
  const bCwd = !!b.cwd
  if (aCwd !== bCwd) return aCwd // the copy with a resume cwd wins
  const aMsg = a.messageCount ?? 0
  const bMsg = b.messageCount ?? 0
  if (aMsg !== bMsg) return aMsg > bMsg
  return sessionActivityMs(a) > sessionActivityMs(b)
}

// ── Search over title / preview / project ─────────────────────────────────
/** Case-insensitive match of `query` against the session's cleaned preview,
 * raw last message, project directory and id. Blank query matches all. The one
 * session-search predicate in the app (SessionBrowser's list). `lastMessage` is
 * needed because `prettySessionPreview().text` prefers the agent title, so on a
 * modern agent the message body would otherwise not be searchable at all. */
export function sessionMatchesQuery(s: SessionListItem, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const pv = prettySessionPreview(s)
  const hay = [pv.text, pv.label, s.lastMessage, s.projectPath || s.cwd, s.sessionId]
    .join(' \u0001 ')
    .toLowerCase()
  return hay.includes(q)
}

// ── Pipeline ───────────────────────────────────────────────────────────────
export interface PrepareOptions {
  /** Hide machine-written (meeting / background-task) sessions. Default FALSE:
   * nothing is hidden unless the user asks for it, so no row can disappear
   * without the user having turned the filter on. */
  hideSystem?: boolean
}

export interface PreparedList<T> {
  /** The sessions to render, deduped, after the optional system filter. */
  sessions: T[]
  /** How many machine-written sessions are (or would be) hidden — the "(N)". */
  systemCount: number
}

/** Hygiene pass shared by the rail and the dashboard: dedupe, then optionally
 * hide machine-written sessions. */
export function prepareSessions<T extends SessionListItem>(
  sessions: T[],
  opts: PrepareOptions = {},
): PreparedList<T> {
  const deduped = dedupeSessions(sessions)
  const systemCount = deduped.filter((s) => isSystemSession(s)).length
  return {
    sessions: opts.hideSystem ? deduped.filter((s) => !isSystemSession(s)) : deduped,
    systemCount,
  }
}
