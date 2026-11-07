/**
 * chat-echo.ts — typed-message echo dedupe and user bubble text (bug d9bb78b2).
 *
 * A typed message is shown at once (optimistic bubble) and the agent echoes it
 * back as `user_transcript`. The old dedupe compared raw text against the last
 * five user lines, so a reworded echo (time tag, attachments) doubled the
 * bubble and a deliberate repeat ("yes", "yes") was swallowed. Now each send
 * carries a clientMsgId the agent returns on the echo (agent PR #18); id-less
 * echoes from older agents fall back to a cleaned-text match against this
 * tab's pending typed messages. Pure; the caller holds the pending list.
 */
import { cleanSessionText, stripSessionWrappers } from './transcript-clean'

export const TYPED_ECHO_WINDOW_MS = 2 * 60 * 1000
const MAX_PENDING = 20

export interface PendingTyped {
  clientMsgId: string
  /** echoMatchKey of the typed text (null when it was notice-only). */
  key: string | null
  at: number
}

let counter = 0
export function newClientMsgId(): string {
  try {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
    if (c?.randomUUID) return c.randomUUID()
  } catch { /* fall through */ }
  counter = (counter + 1) % 1_000_000
  return `cm-${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

const ATTACHMENT_LINE_RE = /\n*\[(?:Image|File)(?: attached)?:[^\]]*\](?:\([^)]*\))?[\s\S]*$/

/** Comparable form of a user turn: cleaned of pipeline wrappers and
 *  attachment markers, lower-cased, whitespace collapsed. Null = notice-only. */
export function echoMatchKey(text: string | null | undefined): string | null {
  const cleaned = stripSessionWrappers(text)
  if (cleaned === null) return null
  const body = cleaned.replace(ATTACHMENT_LINE_RE, '')
  const key = body.replace(/\s+/g, ' ').trim().toLowerCase()
  return key || null
}

function prune(pending: readonly PendingTyped[], now: number): PendingTyped[] {
  return pending.filter((p) => now - p.at <= TYPED_ECHO_WINDOW_MS)
}

/** Record a message this tab just typed and sent. */
export function rememberTyped(pending: readonly PendingTyped[], m: { clientMsgId: string; text: string; now: number }): PendingTyped[] {
  const next = [...prune(pending, m.now), { clientMsgId: m.clientMsgId, key: echoMatchKey(m.text), at: m.now }]
  return next.length > MAX_PENDING ? next.slice(next.length - MAX_PENDING) : next
}

/** Is this user_transcript the echo of a message we already show? Returns the
 *  verdict and the pending list with the matched entry consumed. */
export function takeTypedEcho(
  pending: readonly PendingTyped[],
  echo: { text: string; clientMsgId?: string | null },
  now: number,
): { duplicate: boolean; pending: PendingTyped[] } {
  const live = prune(pending, now)
  if (echo.clientMsgId) {
    const i = live.findIndex((p) => p.clientMsgId === echo.clientMsgId)
    if (i < 0) return { duplicate: false, pending: live }
    return { duplicate: true, pending: [...live.slice(0, i), ...live.slice(i + 1)] }
  }
  const key = echoMatchKey(echo.text)
  if (key === null) return { duplicate: false, pending: live }
  const i = live.findIndex((p) => p.key !== null && p.key === key)
  if (i < 0) return { duplicate: false, pending: live }
  return { duplicate: true, pending: [...live.slice(0, i), ...live.slice(i + 1)] }
}

/** Text for a "You" bubble: the shared display cleaner, or null to hide the
 *  bubble when nothing the user actually said remains. */
export function userBubbleText(text: string | null | undefined): string | null {
  if (stripSessionWrappers(text) === null) return null
  return cleanSessionText(text)
}
