/**
 * Speaking timeline (#581). Pure state fed from the session events: when the
 * newest user turn was committed and whether the user started talking again
 * after it (a mid-thought pause: the first chunk became a turn, the rest is
 * still coming). It only records; holding reply blocks and the prompt note act
 * on it only unless OSBORN_SPEECH_TIMELINE_HOLD is off (default on). Nothing here
 * waits, and no endpointing value changes.
 */
import { envFlagUnlessOff } from './env-keys.js'

/** Post-commit speech younger than this still counts as "the thought continues". */
export const CONTINUATION_WINDOW_MS = 6_000
/** A transcript needs this many words to count as speech: echo and noise show up as 1-2 word fragments (index.ts user_input_transcribed). */
const MIN_WORDS = 3

/** On unless OSBORN_SPEECH_TIMELINE_HOLD=off|0|false|no (kill switch): hold reply blocks while the user continues, and note it in the next turn. */
export const speechTimelineHold = (env: NodeJS.ProcessEnv = process.env): boolean => envFlagUnlessOff(env.OSBORN_SPEECH_TIMELINE_HOLD)

export class SpeechTimeline {
  #agentSpeaking = false
  #answered = false
  #lastTurnCommitAt: number | null = null
  #spokeAfterAt: number | null = null

  onAgentState(speaking: boolean): void {
    this.#agentSpeaking = speaking
    if (!speaking) return
    this.#answered = true
    this.#spokeAfterAt = null  // the agent spoke after that speech (a dropped side remark, an abandoned fragment): the next turn is not its continuation
  }

  /**
   * A user transcript (interim or final) of `words` words. Counts only within the window after the
   * newest commit and before the agent has spoken since it (later speech is a new turn, not the rest
   * of the thought); never under 3 words or while the agent speaks (its own echo).
   */
  onTranscript(words: number, now = Date.now()): void {
    if (this.#agentSpeaking || this.#answered || words < MIN_WORDS || this.#lastTurnCommitAt === null) return
    const since = now - this.#lastTurnCommitAt
    if (since > 0 && since < CONTINUATION_WINDOW_MS) this.#spokeAfterAt = now
  }

  /** A user turn reached the agent. Returns how long after the PREVIOUS commit the user kept talking, or null. */
  onTurnCommit(now = Date.now()): { continuedAfterMs: number } | null {
    const prev = this.#lastTurnCommitAt !== null && this.#spokeAfterAt !== null && now - this.#spokeAfterAt < CONTINUATION_WINDOW_MS
      ? { continuedAfterMs: this.#spokeAfterAt - this.#lastTurnCommitAt } : null
    this.#lastTurnCommitAt = now
    this.#spokeAfterAt = null
    this.#answered = false
    return prev
  }

  /** Forget everything (session switch, hang-up, re-attach): nothing pending carries over. */
  reset(): void {
    this.#answered = false
    this.#lastTurnCommitAt = null
    this.#spokeAfterAt = null
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

const LONG_TURN_WORDS = 20
const OVERLAP_TURN_WORDS = 12
/** Words no finished sentence ends on: a period after one is the STT closing a cut-off turn. */
const DANGLING = new Set(['and', 'but', 'or', 'because', 'the', 'a', 'an', 'my', 'our', 'your', 'if'])

/**
 * A spoken turn that probably lost its tail (#687): a long turn with no closing punctuation or ending on
 * a dangling word, or a turn spoken over the agent (`overlapped`) that stops without closing. Returns the
 * last words heard, or null. Text starting with a `[` tag is not a raw transcript (a typed turn carries
 * `[time:`, injected notes `[SYSTEM`/`[MEETING`/`[NOTIFICATION`) and is never flagged.
 * A heuristic: a false hit costs one confirming question.
 */
export function truncatedInput(text: string, overlapped = false): { lastWords: string } | null {
  const t = text.trim()
  if (t.startsWith('[')) return null
  const words = t.split(/\s+/).filter(Boolean)
  if (words.length < (overlapped ? OVERLAP_TURN_WORDS : LONG_TURN_WORDS)) return null
  const closed = /[.?!…]["')\]]*$/.test(t)
  const last = (words[words.length - 1] || '').toLowerCase().replace(/[^a-z']/g, '')
  if (closed && !DANGLING.has(last)) return null
  return { lastWords: words.slice(-8).join(' ') }
}
