/**
 * control-text.ts — pipeline control notices are never a "You" bubble
 * (bug 14bedf48, frontend half).
 *
 * The agent and this client inject control text into the user channel:
 * '[SYSTEM — SILENT CONTROL MESSAGE …]', '[Request interrupted by user]',
 * '[favorited]', '[liked]', '[ignored: …]', '[welcome-back]', task
 * notifications, reminders. Some of it reached the chat (live user_transcript
 * echoes, resumed history) as if the user had said it. One predicate decides,
 * shared by the live path, the history path and the bubble renderer.
 */
import { stripSessionWrappers } from './transcript-clean'

const TIME_TAG_RE = /^\s*(?:\[time:[^\]]*\]\s*)+/

// Explicit prefixes, checked on the raw text (after the time tag) so the rule
// holds even if the shared cleaner's list changes.
const CONTROL_PREFIXES: RegExp[] = [
  /^\[SYSTEM\s*[—–-]\s*SILENT CONTROL MESSAGE/i,
  // Generic '[SYSTEM]' / '[SYSTEM —|:|-' is kept on purpose (review MINOR,
  // 2026-11-07). A user who types "[SYSTEM] hi" is hidden too, but narrowing
  // this to the known agent templates here alone would not make that text
  // visible: the agent's shared sanitizer (agent/src/content/transcript-
  // sanitizer.ts, DROP_PREFIXES) and the frontend cleaner (transcript-clean.ts,
  // titles and history) drop the same generic shape, so the bubble would show
  // live and vanish on resume. "[SYSTEM design] …" (no ], :, or dash) is not
  // matched. Narrow all three together if this ever matters.
  /^\[SYSTEM(?:\]|\s*[—–:-])/,
  /^\[Request interrupted by user/,
  /^\[ignored:/,
  /^\[(?:favorited|liked|welcome-back)\]/,
  /^\[(?:EMERGENCY STOP|BACKGROUND_INIT)\]/,
  /^\[(?:SCRIPT|PROACTIVE|NOTIFICATION)\]/,
  /^<(?:task-notification|system-reminder|local-command-|command-name)/,
]

/** True when the text is a control notice (or empty), i.e. not user speech. */
export function isControlNotice(text: string | null | undefined): boolean {
  if (typeof text !== 'string') return true
  const body = text.replace(TIME_TAG_RE, '').trim()
  if (!body) return true
  if (CONTROL_PREFIXES.some((re) => re.test(body))) return true
  return stripSessionWrappers(text) === null
}

/** History rows without user-role control notices. Same array if none dropped. */
export function dropControlUserItems<T extends { role: string; content: string }>(items: T[]): T[] {
  const out = items.filter((m) => m.role !== 'user' || !isControlNotice(m.content))
  return out.length === items.length ? items : out
}
