/**
 * Per-turn speech record (#694): what the user heard, what was held back unheard,
 * and what went stale, one line each in the session sidecar `speech.jsonl`.
 *   heard  - a chunk played to the end
 *   cut    - a barge-in stopped it: `heard` is the part that played, `unheard` the rest
 *   held   - not sent to TTS (the user was speaking, or a barge-in flushed the queue); carried to the next prompt
 *   stale  - dropped for good: its turn was interrupted, or it waited past the replay limit
 */
import { appendJsonlLine, readJsonlLines } from './jsonl-sidecar.js'
import { getSidecarPath } from './session-store.js'

export type SpeechOutcome = 'heard' | 'cut' | 'held' | 'stale'
export interface SpeechRecord {
  at: string
  outcome: SpeechOutcome
  messageId?: string
  heard?: string
  unheard?: string
  estimate?: boolean  // `heard` came from a position or timer, not the SDK's synced transcript
}

const MAX_TEXT = 600

const cap = (s?: string) => (s && s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '…' : s)

export function speechRecord(outcome: SpeechOutcome, p: { messageId?: string; heard?: string; unheard?: string; estimate?: boolean }, now = new Date()): SpeechRecord {
  const r: SpeechRecord = { at: now.toISOString(), outcome }
  if (p.messageId) r.messageId = p.messageId
  if (p.heard) r.heard = cap(p.heard)
  const unheard = p.unheard?.trim()
  if (unheard) r.unheard = cap(unheard)
  if (p.estimate) r.estimate = true
  return r
}

export function getSpeechLogPath(sessionId: string, workingDir: string): string {
  return getSidecarPath(sessionId, workingDir, 'speech.jsonl')
}

export function appendSpeechRecord(sessionId: string, workingDir: string, r: SpeechRecord): void {
  appendJsonlLine(getSpeechLogPath(sessionId, workingDir), JSON.stringify(r))
}

export function readSpeechRecords(sessionId: string, workingDir: string): SpeechRecord[] {
  return readJsonlLines(getSpeechLogPath(sessionId, workingDir)).filter((o: any): o is SpeechRecord =>
    !!o && typeof o.at === 'string' && ['heard', 'cut', 'held', 'stale'].includes(o.outcome))
}
