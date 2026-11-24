/**
 * Drops speech from a turn the user already cut off (#456). A barge-in flushes
 * the queued say() handles, but the interrupted turn can still emit later text
 * blocks (they share one messageId) once the user stops talking; without this
 * gate they play over the new answer. Blocks without a messageId always pass.
 */
export class StaleTurnGate {
  #stale = new Set<string>()
  constructor(private readonly max = 64) {}

  markStale(messageId?: string | null): void {
    if (!messageId) return
    this.#stale.delete(messageId)
    this.#stale.add(messageId)
    if (this.#stale.size > this.max) this.#stale.delete(this.#stale.values().next().value as string)
  }

  isStale(messageId?: string | null): boolean {
    return !!messageId && this.#stale.has(messageId)
  }
}
