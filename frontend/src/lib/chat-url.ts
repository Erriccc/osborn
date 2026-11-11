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
 * `cwd`, when known, replaces `workingDirectory`. When the cwd is unknown and
 * the session is CHANGING, the old `workingDirectory` is dropped rather than
 * carried onto the new session (#112): a stale project dir for the wrong
 * session makes a reload resume in /workspace root or the wrong conversation.
 * The agent resolves the session's real cwd from its id, so no hint is safer
 * than a wrong one. For the SAME session an unknown cwd keeps the existing one.
 */
export function chatUrlForSession(href: string, sessionId: string, cwd?: string | null): string | null {
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return null
  let url: URL
  try { url = new URL(href, 'http://localhost') } catch { return null }
  const p = url.searchParams
  const sameSession = p.get('session') === sessionId
  const dropStaleCwd = !cwd && !sameSession && p.has('workingDirectory')
  const sameCwd = !cwd || p.get('workingDirectory') === cwd
  const hasOneShot = ONE_SHOT_PARAMS.some((k) => p.has(k))
  if (sameSession && sameCwd && !hasOneShot) return null
  p.set('session', sessionId)
  if (cwd) p.set('workingDirectory', cwd)
  else if (dropStaleCwd) p.delete('workingDirectory')
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

// ── Take-over adopts the live session (S13) ──────────────────────────────────
// The active tab records the session it is live in; a standby tab that takes
// over rewrites its URL to that session BEFORE connect(), so it doesn't
// rejoin the stale session its URL was opened with.

export const LIVE_SESSION_KEY = 'vn-chat-live-session'
const LIVE_SESSION_MAX_AGE_MS = 12 * 3600 * 1000

/** Per-user storage key: a record left by one account is never adopted by another. */
export function liveSessionKey(userId: string | null | undefined): string {
  return `${LIVE_SESSION_KEY}:${userId || 'anon'}`
}

export function liveSessionRecord(sessionId: string, cwd: string | null | undefined, now: number = Date.now(), userId?: string | null): string {
  return JSON.stringify({ sessionId, cwd: cwd || undefined, at: now, userId: userId || undefined })
}

/** Remove every live-session record (all users). Called on sign-out. */
export function clearLiveSessionRecords(storage: { readonly length: number; key(i: number): string | null; removeItem(k: string): void }): void {
  const keys: string[] = []
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i)
    if (k && (k === LIVE_SESSION_KEY || k.startsWith(`${LIVE_SESSION_KEY}:`))) keys.push(k)
  }
  for (const k of keys) storage.removeItem(k)
}

/** URL to adopt on take-over, or null (first mount, same session, stale or bad record). */
export function takeoverSessionUrl(href: string, stored: string | null, prevRole: string, now: number = Date.now(), userId?: string | null): string | null {
  if (!stored || prevRole === 'probing' || prevRole === 'active') return null
  let rec: { sessionId?: unknown; cwd?: unknown; at?: unknown; userId?: unknown }
  try { rec = JSON.parse(stored) } catch { return null }
  if (typeof rec?.sessionId !== 'string' || typeof rec.at !== 'number') return null
  // Defense in depth on top of the per-user key: only adopt our own record.
  if ((rec.userId ?? null) !== (userId || null)) return null
  if (now - rec.at > LIVE_SESSION_MAX_AGE_MS) return null
  return chatUrlForSession(href, rec.sessionId, typeof rec.cwd === 'string' ? rec.cwd : null)
}
