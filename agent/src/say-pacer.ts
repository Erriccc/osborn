/**
 * Just-in-time speech pacing (#694). Sentence chunks wait here instead of going
 * straight to TTS; one is released only when nothing is playing, or the playing
 * one is within `leadMs` of its end (estimated from its first audio frame and
 * length), so the next starts without a gap. A barge-in then wastes at most the
 * chunk already in flight; the rest come back through `clear()` as unheard text.
 */
export const CHARS_PER_SEC = 14
export const LEAD_MS = 1500

export class SayPacer<T extends { text: string }> {
  #queue: T[] = []
  #endsAt: number | null = null  // estimated end of the playing chunk, null until its first frame

  get size() { return this.#queue.length }
  enqueue(item: T) { this.#queue.push(item) }
  take(): T | undefined { this.#endsAt = null; return this.#queue.shift() }
  /** The playing chunk's first audio frame went out. */
  started(now: number, chars: number) { this.#endsAt = now + (chars / CHARS_PER_SEC) * 1000 }
  /** Drop everything unsent and return it, oldest first. */
  clear(): T[] { const q = this.#queue; this.#queue = []; this.#endsAt = null; return q }
  /** May the head chunk go to TTS now? `inFlight` is the number of unfinished speech handles. */
  ready(now: number, inFlight: number, leadMs = LEAD_MS): boolean {
    if (!this.#queue.length) return false
    if (inFlight === 0) return true
    return inFlight === 1 && this.#endsAt !== null && this.#endsAt - now <= leadMs
  }
}
