/**
 * Speaking timeline (#581). Pure state fed from the session events: when the
 * newest user turn was committed and whether the user started talking again
 * after it (a mid-thought pause: the first chunk became a turn, the rest is
 * still coming). It only records; holding reply blocks and the prompt note act
 * on it only with OSBORN_SPEECH_TIMELINE_HOLD on (default off). Nothing here
 * waits, and no endpointing value changes.
 */
import { envFlagOn } from './env-keys.js'

/** Post-commit speech younger than this still counts as "the thought continues". */
export const CONTINUATION_WINDOW_MS = 6_000
/** A transcript needs this many words to count as speech: echo and noise show up as 1-2 word fragments (index.ts user_input_transcribed). */
const MIN_WORDS = 3

/** OSBORN_SPEECH_TIMELINE_HOLD=on|1|true: hold reply blocks while the user continues, and note it in the next turn. */
export const speechTimelineHold = (env: NodeJS.ProcessEnv = process.env): boolean => envFlagOn(env.OSBORN_SPEECH_TIMELINE_HOLD)

export class SpeechTimeline {
  #agentSpeaking = false
  #lastTurnCommitAt: number | null = null
  #spokeAfterAt: number | null = null

  onAgentState(speaking: boolean): void { this.#agentSpeaking = speaking }

  /** A user transcript (interim or final) of `words` words. Not counted under 3 words or while the agent speaks (its own echo). */
  onTranscript(words: number, now = Date.now()): void {
    if (this.#agentSpeaking || words < MIN_WORDS) return
    if (this.#lastTurnCommitAt !== null && now > this.#lastTurnCommitAt) this.#spokeAfterAt = now
  }

  /** A user turn reached the agent. Returns how long after the PREVIOUS commit the user kept talking, or null. */
  onTurnCommit(now = Date.now()): { continuedAfterMs: number } | null {
    const prev = this.#lastTurnCommitAt !== null && this.#spokeAfterAt !== null
      ? { continuedAfterMs: this.#spokeAfterAt - this.#lastTurnCommitAt } : null
    this.#lastTurnCommitAt = now
    this.#spokeAfterAt = null
    return prev
  }

  /** The user spoke after the newest commit, within the window: that turn was a fragment. */
  awaitingContinuation(now = Date.now()): boolean {
    return this.#spokeAfterAt !== null && now - this.#spokeAfterAt < CONTINUATION_WINDOW_MS
  }

  /** Hold a reply block (and its replay) for the continuation: only with the flag on. */
  shouldHold(now = Date.now(), on = speechTimelineHold()): boolean {
    return on && this.awaitingContinuation(now)
  }
}

export const speechTimeline = new SpeechTimeline()
