// SESSION-LIST HYGIENE (#107) — pure, client-safe (no React, no Node imports).
// The shared core behind the two human-facing session lists (the Rooms rail and
// the dashboard Projects panel): fold duplicate copies of one session into one
// row, and optionally hide the rows the MACHINE wrote.
//
// Do NOT add prompt-text classification back (it hid real sessions, and
// `lastMessage` is the LAST user turn, not the first) or fork collapse (it
// merged different sessions on a 6-word title and left no path to the one it
// dropped). tests/session-list.test.ts pins both.

import { prettySessionPreview, sameSession, sessionActivityMs, type SessionListFields } from './sessions'

/** The shape the hygiene helpers read. Every extra field is optional so the
 * dashboard's SessionInfo, the rail's RoomSessionInput and partial shapes all
 * satisfy it. */
export interface SessionListItem extends SessionListFields {
  sessionId: string
  messageCount?: number
  /** Slug-derived cwd — where Claude Code's `--resume` looks the session up. */
  cwd?: string
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
 * Identity is `sameSession`, the same rule the rows use, bucketed by id prefix
 * to stay linear — so the two can't drift apart. A Map keeps insertion order
 * across overwrites, so first-seen order needs no second structure.
 */
function dedupeSessions<T extends SessionListItem>(sessions: T[]): T[] {
  const best = new Map<string, T>()
  const byPrefix = new Map<string, string[]>()
  for (const s of sessions) {
    if (!s || !s.sessionId) continue
    const prefix = s.sessionId.substring(0, 8)
    const bucket = byPrefix.get(prefix)
    const key = bucket?.find((k) => sameSession(k, s.sessionId))
    if (key === undefined) {
      best.set(s.sessionId, s)
      if (bucket) bucket.push(s.sessionId)
      else byPrefix.set(prefix, [s.sessionId])
      continue
    }
    if (preferCopy(s, best.get(key)!)) best.set(key, s)
  }
  return Array.from(best.values())
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

// ── Search over preview / message / id ────────────────────────────────────
/** Case-insensitive match of `query` against the session's cleaned preview, its
 * raw last message and its id. Blank query matches all. The one session-search
 * predicate in the app (SessionBrowser's list).
 *
 * Only fields that DISTINGUISH one session from another belong here. `pv.label`
 * is the literal "Chat" on every chat row and `cwd` shares a path prefix across
 * the whole list, so either one would make "chat" or "workspace" match every
 * row. `lastMessage` is needed because `pv.text` prefers the agent-supplied
 * title, so on a modern agent the message body would not be searchable at all. */
export function sessionMatchesQuery(s: SessionListItem, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const hay = [prettySessionPreview(s).text, s.lastMessage, s.sessionId]
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
 * hide machine-written sessions. "Machine-written" is exactly the non-`chat`
 * half of `prettySessionPreview`'s kind — a bot meeting transcript or a
 * background task notification, both recognised from markers the agent emits
 * itself. Nothing here infers intent from what the user typed. */
export function prepareSessions<T extends SessionListItem>(
  sessions: T[],
  opts: PrepareOptions = {},
): PreparedList<T> {
  const deduped = dedupeSessions(sessions)
  const kept = deduped.filter((s) => prettySessionPreview(s).kind === 'chat')
  return {
    sessions: opts.hideSystem ? kept : deduped,
    systemCount: deduped.length - kept.length,
  }
}
