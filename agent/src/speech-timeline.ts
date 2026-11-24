/**
 * Speaking timeline (#581). Pure state fed from the existing session events:
 * who is talking, what the user said last, when the last turn was committed,
 * and whether the user started talking again after that commit (a mid-thought
 * pause: the first chunk became a turn, the rest is still coming).
 *
 * Reads are synchronous and cheap; nothing here waits, so a single-chunk turn
 * costs nothing extra.
 */

/** Post-commit speech younger than this still counts as "the thought continues". */
export const CONTINUATION_WINDOW_MS = 6_000
/** A fragment must have at least this many words to count as speech (echo and coughs do not). */
const MIN_WORDS = 2
/** The ramble hold applies only past this much continuous talking. */
export const RAMBLE_MIN_MS = 20_000
const RAMBLE_MAX_HOLD_MS = 3_000

const wordCount = (t: string): number => t.trim().split(/\s+/).filter(Boolean).length

export class SpeechTimeline {
  userSpeaking = false
  userSpeakingSince: number | null = null
  userLastSpokeAt: number | null = null
  userLastWords = ''
  /** Length of the user's most recent stretch of speech. */
  lastTalkedMs = 0
  agentSpeaking = false
  lastAgentBlockAt: number | null = null
  lastTurnCommitAt: number | null = null
  /** The user said 2+ words after the newest commit. */
  #spokeAfterCommit = false
  #spokeAfterAt: number | null = null

  onUserState(speaking: boolean, now = Date.now()): void {
    if (speaking && !this.userSpeaking) this.userSpeakingSince = now
    if (!speaking && this.userSpeaking) { this.userLastSpokeAt = now; this.lastTalkedMs = this.userSpeakingSince !== null ? now - this.userSpeakingSince : 0 }
    this.userSpeaking = speaking
  }

  onTranscript(text: string, isFinal: boolean, now = Date.now()): void {
    if (wordCount(text) < MIN_WORDS) return
    this.userLastSpokeAt = now
    if (isFinal) this.userLastWords = text.trim()
    if (this.lastTurnCommitAt !== null && now > this.lastTurnCommitAt) { this.#spokeAfterCommit = true; this.#spokeAfterAt = now }
  }

  onAgentState(speaking: boolean): void { this.agentSpeaking = speaking }
  onAgentBlock(now = Date.now()): void { this.lastAgentBlockAt = now }

  /**
   * A user turn reached the model. Returns how long ago the user kept talking
   * after the PREVIOUS commit (ms), or null; the next prompt carries it as a note.
   */
  onTurnCommit(now = Date.now()): { continuedAfterMs: number } | null {
    const prev = this.lastTurnCommitAt !== null && this.#spokeAfterCommit
      ? { continuedAfterMs: Math.max(0, (this.#spokeAfterAt ?? now) - this.lastTurnCommitAt) } : null
    this.lastTurnCommitAt = now
    this.#spokeAfterCommit = false
    this.#spokeAfterAt = null
    return prev
  }

  /** The user spoke after the newest commit and has not been silent for long: that commit is a fragment. */
  awaitingContinuation(now = Date.now()): boolean {
    return this.#spokeAfterCommit && this.#spokeAfterAt !== null && now - this.#spokeAfterAt < CONTINUATION_WINDOW_MS
  }

  /** Hold a reply block instead of speaking it: the user is talking, or kept talking after this turn was committed. */
  shouldHoldBlock(now = Date.now()): boolean {
    return this.userSpeaking || this.awaitingContinuation(now)
  }

  /** How long the user has been talking without a break (0 when quiet). */
  talkedForMs(now = Date.now()): number {
    return this.userSpeaking && this.userSpeakingSince !== null ? now - this.userSpeakingSince : 0
  }

  reset(): void { Object.assign(this, new SpeechTimeline()) }
}

export const speechTimeline = new SpeechTimeline()

/** The prompt note for a turn the user kept talking after; empty when they did not. */
export function continuationNote(c: { continuedAfterMs: number } | null): string {
  if (!c) return ''
  const s = Math.max(1, Math.round(c.continuedAfterMs / 1000))
  return `[The user kept talking about ${s}s after your previous turn started: this message continues that thought. Answer the whole thing; anything you said in reply to the earlier part may not have been heard.]`
}

/** Ramble hold (#581): default off; never changes an endpointing value. */
export const rambleHoldEnabled = (): boolean => process.env.OSBORN_RAMBLE_HOLD === 'on'

/** Wait for a follow-on after a long monologue: 0 for anything under 20 s, else talkedFor/10 capped at 3 s. */
export function rambleHoldMs(talkedForMs: number, enabled = rambleHoldEnabled()): number {
  if (!enabled || talkedForMs < RAMBLE_MIN_MS) return 0
  return Math.min(Math.round(talkedForMs / 10), RAMBLE_MAX_HOLD_MS)
}
