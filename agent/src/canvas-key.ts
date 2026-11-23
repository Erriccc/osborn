/**
 * Meeting-canvas access key. The canvas page runs inside the Recall bot's browser, which cannot
 * send the owner's Bearer token, so `/canvas-token` (a LiveKit listener credential: it hears every
 * broadcast in the room) is gated by a random per-meeting key carried in the page's own URL.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'

export const newCanvasKey = (): string => randomBytes(18).toString('hex')

/** The cast URL with the meeting key set when it is the meeting-canvas page (which sends it to
 *  /canvas-token), whoever built the URL; any other page is cast as given, without the key. */
export function withCanvasKey(castUrl: string | undefined, key: string): string | undefined {
  try {
    const u = new URL(castUrl || '')
    if (!/^\/meeting-canvas\/?$/.test(u.pathname)) return castUrl
    u.searchParams.set('k', key)
    return u.toString()
  } catch { return castUrl }
}

/** True only when a secret exists and `got` equals it (constant time). Also checks the /editor token. */
export function secretMatches(expected: string | null, got: string | null | undefined): boolean {
  if (!expected || !got || got.length !== expected.length) return false
  try { return timingSafeEqual(Buffer.from(got), Buffer.from(expected)) } catch { return false }
}
