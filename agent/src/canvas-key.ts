/**
 * Meeting-canvas access key. The canvas page runs inside the Recall bot's browser, which cannot
 * send the owner's Bearer token, so `/canvas-token` (a LiveKit listener credential: it hears every
 * broadcast in the room) is gated by a random per-meeting key carried in the page's own URL.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { isThisMachine } from './agent-store.js'

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
  return r.bearerOk || !!r.lineOk || secretMatches(r.key, r.k) || (!r.origin && isThisMachine(r))
}

const OWN_API_ROUTES = new Set(['/canvas', '/tts', '/noise-cancel'])
const JSON_HEADER = /^content-type:[ \t]*application\/json$/i

/** Splits one shell line into words exactly as bash would, or null when it uses anything but plain
 *  words, '…' (literal, newlines included) and "…" with no expansion. Outside quotes `\'` and `\"` are
 *  literal characters; a backslash-newline is accepted only between words (bash deletes it, so inside
 *  a word it would join the neighbours). Inside "…" only `\"` and `\\` are escapes. Any other
 *  backslash, a newline or CR outside single quotes, or a shell metacharacter refuses. */
function plainShellWords(cmd: string): string[] | null {
  const words: string[] = []
  let cur: string | null = null
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1)
      if (end < 0) return null
      cur = (cur ?? '') + cmd.slice(i + 1, end)
      i = end
    } else if (c === '"') {
      let body = ''
      for (i++; i < cmd.length && cmd[i] !== '"'; i++) {
        const d = cmd[i]
        if (d === '\\') {
          if (cmd[i + 1] !== '"' && cmd[i + 1] !== '\\') return null
          body += cmd[++i]
        } else if (/[$`!\r\n]/.test(d)) return null
        else body += d
      }
      if (i >= cmd.length) return null
      cur = (cur ?? '') + body
    } else if (c === '\\' && (cmd[i + 1] === "'" || cmd[i + 1] === '"')) {
      cur = (cur ?? '') + cmd[++i]
    } else if (c === '\\' && cmd[i + 1] === '\n' && cur === null) {
      i++
    } else if (c === ' ' || c === '\t') {
      if (cur !== null) { words.push(cur); cur = null }
    } else if (/[A-Za-z0-9_./:@%=+,-]/.test(c)) {
      cur = (cur ?? '') + c
    } else return null
  }
  if (cur !== null) words.push(cur)
  return words
}

/** True only for one curl to a localhost port (any port, not necessarily the agent's own) at /canvas, /tts or /noise-cancel with inline JSON
 *  and no way to read or write a file, reach another host or run anything else. Anything unsure
 *  is false, so the command goes through the normal approval. */
export function isOwnApiCurl(cmd: string): boolean {
  const words = plainShellWords(cmd)
  if (!words || words[0] !== 'curl') return false
  let urls = 0
  for (let i = 1; i < words.length; i++) {
    const w = words[i]
    if (w === '-s' || w === '-S' || w === '-sS' || w === '-Ss' || w === '--silent' || w === '--show-error') continue
    if (w === '-X') { if (words[++i] !== 'POST') return false; continue }
    if (w === '-H') { if (!JSON_HEADER.test(words[++i] ?? '')) return false; continue }
    if (w === '--max-time' || w === '-m') { if (!/^\d{1,3}$/.test(words[++i] ?? '')) return false; continue }
    if (w === '-d' || w === '--data' || w === '--data-raw' || w === '--data-binary') {
      const body = words[++i]
      if (body === undefined || body.startsWith('@')) return false
      try { JSON.parse(body) } catch { return false }
      continue
    }
    if (w.startsWith('-')) return false
    if (++urls > 1 || !ownApiUrl(w)) return false
  }
  return urls === 1
}

function ownApiUrl(raw: string): boolean {
  if (/[[\]{}#]|[^\x21-\x7e]/.test(raw)) return false  // curl expands [1-99999] and {a,b} into many requests; no fragment, whitespace or control characters
  if (!/^http:\/\/(localhost|127\.0\.0\.1):\d{1,5}\//.test(raw) || /%|\\|\.\./.test(raw.split('?')[0])) return false
  try {
    const u = new URL(raw)
    return !u.username && !u.password && !u.hash && OWN_API_ROUTES.has(u.pathname)
  } catch { return false }
}
