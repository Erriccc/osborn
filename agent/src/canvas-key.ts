/**
 * Meeting-canvas access key. The canvas page runs inside the Recall bot's browser, which cannot
 * send the owner's Bearer token, so `/canvas-token` (a LiveKit listener credential: it hears every
 * broadcast in the room) is gated by a random per-meeting key carried in the page's own URL.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { localNoBrowser } from './agent-store.js'

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

/** Signature that lets one exact line of text be fetched from /tts without a header: a phone call's
 *  spoken lines are played from a URL by LiveKit's ingress, which cannot send one. The frontend signs
 *  with the machine's sync token (phone-calls.ts has the same HMAC), so a signature only speaks that text. */
export const ttsLineSig = (secret: string, text: string): string => createHmac('sha256', secret).update(`tts:${text}`).digest('base64url')

/** Who may use the meeting-canvas routes (/canvas, /canvas-stream, /tts, /noise-cancel) and /report-bug: the owner's
 *  Bearer token, the live meeting's key (the canvas page runs in Recall's browser and sends it as `k`),
 *  a signed /tts line (`lineOk`), or this machine itself (the agent's own curl, from no browser origin).
 *  Anyone else is refused. */
export function canvasRouteAllowed(r: {
  bearerOk: boolean; lineOk?: boolean; key: string | null; k: string | null | undefined
  forwarded: boolean; host?: string; remote?: string; origin?: string
}): boolean {
  return r.bearerOk || !!r.lineOk || secretMatches(r.key, r.k) || localNoBrowser(r)
}
