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
