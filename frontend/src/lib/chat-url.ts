// ============================================================
// /chat URL <-> live session (#71) — pure, client-safe
// ============================================================
// Reloading or re-entering /chat must land back in the same session. The chat
// page resumes whatever `?session=` (+ `?workingDirectory=`, the project the
// agent needs to find the session's JSONL) the URL carries, so the URL has to
// follow the live session: set as soon as a new session gets its id, and
// rewritten when the user switches sessions.

const SESSION_ID_RE = /^[A-Za-z0-9_-]{6,128}$/
// One-shot launch params: consumed on first load; must not survive a reload.
const ONE_SHOT_PARAMS = ['prompt', 'seed']

/**
 * The /chat URL (path + query + hash, same origin) that pins `sessionId`, or
 * null when the URL already pins it (or the id is not a real session id).
 * `cwd`, when known, replaces `workingDirectory`; otherwise it is kept.
 */
export function chatUrlForSession(href: string, sessionId: string, cwd?: string | null): string | null {
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return null
  let url: URL
  try { url = new URL(href, 'http://localhost') } catch { return null }
  const p = url.searchParams
  const sameSession = p.get('session') === sessionId
  const sameCwd = !cwd || p.get('workingDirectory') === cwd
  const hasOneShot = ONE_SHOT_PARAMS.some((k) => p.has(k))
  if (sameSession && sameCwd && !hasOneShot) return null
  p.set('session', sessionId)
  if (cwd) p.set('workingDirectory', cwd)
  for (const k of ONE_SHOT_PARAMS) p.delete(k)
  const qs = p.toString()
  return `${url.pathname}${qs ? `?${qs}` : ''}${url.hash}`
}

/** Session + project currently pinned by a `location.search` string. */
export function sessionParamsFromSearch(search: string): { sessionId: string | null; workingDirectory: string } {
  const p = new URLSearchParams(search || '')
  return { sessionId: p.get('session') || null, workingDirectory: p.get('workingDirectory') || '' }
}

/** Query string for the agent's /session-messages read (S8): the session's
 * own cwd rides along so sessions outside the agent's boot project hydrate. */
export function sessionMessagesQuery(sessionId: string, cwd?: string | null, limit = 50): string {
  const p = new URLSearchParams({ session: sessionId, limit: String(limit) })
  if (cwd) p.set('workingDirectory', cwd)
  return `?${p.toString()}`
}

/**
 * The cwd to pin in the URL for the live session (S11): the agent-reported
 * cwd (current_session / session_switched) when it is about THIS session —
 * a fresh session isn't in the session list yet — else the list's routing cwd.
 */
export function pinnedSessionCwd(
  sessionId: string | null,
  reported: { sessionId: string; cwd?: string | null } | null,
  sessions: Array<{ sessionId: string; cwd?: string }>,
): string | undefined {
  if (!sessionId) return undefined
  if (reported && reported.sessionId === sessionId && reported.cwd) return reported.cwd
  return sessions.find((s) => s.sessionId === sessionId)?.cwd
}
