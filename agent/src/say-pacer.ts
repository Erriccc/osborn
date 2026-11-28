/**
 * Just-in-time speech pacing (#694). Sentence chunks wait here instead of going
 * straight to TTS; the head is released when nothing is in flight, or when the one
 * in flight has its first audio frame out. So at most one chunk is synthesized
 * ahead of what plays, and a barge-in wastes at most that one; the rest come back
 * through `clear()` as unheard text.
 */
export class SayPacer<T extends { text: string }> {
  #queue: T[] = []
  #playing = false  // the in-flight chunk's first audio frame is out

  get size() { return this.#queue.length }
  enqueue(item: T) { this.#queue.push(item) }
  take(): T | undefined { this.#playing = false; return this.#queue.shift() }
  /** The in-flight chunk's first audio frame went out. */
  started() { this.#playing = true }
  /** Drop everything unsent and return it, oldest first. */
  clear(): T[] { const q = this.#queue; this.#queue = []; this.#playing = false; return q }
  /** May the head chunk go to TTS now? `inFlight` is the number of unfinished speech handles. */
  ready(inFlight: number): boolean {
    return this.#queue.length > 0 && (inFlight === 0 || (inFlight === 1 && this.#playing))
  }
}
