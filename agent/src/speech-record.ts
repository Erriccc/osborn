/**
 * Per-turn speech record (#694): what the user heard, what was held back unheard,
 * and what went stale, one line each in the session sidecar `speech.jsonl`.
 *   heard  - a chunk played to the end
 *   cut    - a barge-in stopped it: `heard` is the part that played, `unheard` the rest
 *   held   - not sent to TTS (the user was speaking or kept talking after the turn, or a barge-in flushed the queue); carried to the next prompt
 *   stale  - never spoken: a late chunk of a turn the user cut off, held text that waited past the replay limit, or text dropped at teardown (hang-up, session switch)
 */
import { appendJsonlLine } from './jsonl-sidecar.js'
import { getSidecarPath } from './session-store.js'
import { clip } from './content/lens-ingest.js'

export type SpeechOutcome = 'heard' | 'cut' | 'held' | 'stale'
export type SpeechParts = { messageId?: string; heard?: string; unheard?: string; estimate?: boolean /* `heard` came from a position or timer, not the SDK's synced transcript */ }
type SpeechRecord = { at: string; outcome: SpeechOutcome } & SpeechParts

const MAX_TEXT = 600

export function speechRecord(outcome: SpeechOutcome, p: SpeechParts, now = new Date()): SpeechRecord {
  const r: SpeechRecord = { at: now.toISOString(), outcome }
  if (p.messageId) r.messageId = p.messageId
  if (p.heard) r.heard = clip(p.heard, MAX_TEXT)
  const unheard = p.unheard?.trim()
  if (unheard) r.unheard = clip(unheard, MAX_TEXT)
  if (p.estimate) r.estimate = true
  return r
}

/** No session id yet: nothing is written. A failed write is logged, never thrown, so it never touches speech. */
export function appendSpeechRecord(sessionId: string | undefined, workingDir: string, r: SpeechRecord): void {
  if (!sessionId) return
  try { appendJsonlLine(getSidecarPath(sessionId, workingDir, 'speech.jsonl'), JSON.stringify(r)) }
  catch (e) { console.warn('speech record persist failed:', e instanceof Error ? e.message : e) }
}
