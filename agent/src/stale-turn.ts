/**
 * Stale-turn rule (#456). A barge-in only makes the cut-off turn stale once the
 * pipeline consumes the interruption context (it then interrupts the turn, so
 * its late text blocks must not play over the reply). A barge-in that never
 * becomes a turn (side talk, a phone voice action) leaves the turn live.
 * One id is enough: ids never repeat and a stale turn ends before the next
 * one is marked. Blocks without a messageId always pass.
 */
export function staleIdOnConsume(
  ctx: { spokenText: string; messageId?: string } | null,
  current: string | null,
): string | null {
  return ctx && ctx.spokenText && ctx.messageId ? ctx.messageId : current
}

export function isStaleBlock(staleId: string | null, messageId?: string | null): boolean {
  return !!messageId && messageId === staleId
}

/**
 * Turn ids retired by a successful interrupt (#539 D). The SDK may emit no
 * `result` for an interrupted turn, so its id would otherwise be reused by the
 * next reply and the stale gate would drop every block of the real answer.
 * Leftover blocks of the old turn keep the retired id (still dropped); the next
 * pushed user message gets a fresh one.
 */
export function retireTurnId(retired: Set<string>, current: string | null): void {
  if (current) retired.add(current)
}

/** The id to keep as current when a new user message is pushed: a retired one is dropped. */
export function currentIdOnPush(retired: Set<string>, current: string | null): string | null {
  return current && retired.has(current) ? null : current
}

/** A block is stale when its turn was consumed as interrupted (#456) or retired by a successful interrupt. */
export function isStaleOrRetired(
  staleId: string | null,
  retired: { has(id: string): boolean } | null | undefined,
  messageId?: string | null,
): boolean {
  return isStaleBlock(staleId, messageId) || (!!messageId && !!retired?.has(messageId))
}

/**
 * Suppressed-text replay (#539 A). Spoken when the user has stayed quiet and no
 * new turn took the buffered text, even while the agent is 'thinking', but never
 * while the noise gate holds a barge-in utterance (its turn will consume the
 * context) and never over the agent's own speech.
 */
export type ReplayInput = {
  hasSession: boolean
  userListening: boolean
  sameInterruption: boolean   // lastInterruption is still the object captured when the timer armed
  hasText: boolean
  agentSpeaking: boolean
  gateTriaging: boolean
}
export function replayDecision(i: ReplayInput): { replay: boolean; reason?: string } {
  if (!i.hasSession) return { replay: false, reason: 'no session' }
  if (!i.userListening) return { replay: false, reason: 'user speaking' }
  if (!i.sameInterruption) return { replay: false, reason: 'replaced or consumed by a new turn' }
  if (!i.hasText) return { replay: false, reason: 'nothing buffered' }
  if (i.gateTriaging) return { replay: false, reason: 'noise gate triaging' }
  if (i.agentSpeaking) return { replay: false, reason: 'agent speaking' }
  return { replay: true }
}

/**
 * When an uninterrupted say finishes (#539 C): the old interruption context is
 * done with, but text buffered after that say started was never covered by it,
 * so it stays pending. Returns the context to keep, or null.
 */
export function settleAfterSay<T extends { suppressedText: string; timestamp: number }>(
  li: (T & { spokenText: string; recentMessages: string }) | null,
): { spokenText: string; recentMessages: string; suppressedText: string; timestamp: number } | null {
  if (!li || !li.suppressedText) return null
  return { spokenText: '', recentMessages: '', suppressedText: li.suppressedText, timestamp: li.timestamp }
}
