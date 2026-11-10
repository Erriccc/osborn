// ============================================================
// claude_output de-duplication (S12) — pure, client-safe
// ============================================================
// The agent emits each assistant text block as a streaming claude_output
// {isStreaming, messageId, chunkIndex}, then ONE turn-level claude_output
// {isFinal, messageId} carrying the whole turn's text. A single-block turn was
// already deduped by text; a multi-block turn rendered its chunks AND the
// joined final as a second bubble. The final is redundant when its turn's
// chunks were shown (same messageId), or — for agents that send no
// messageId — when it equals the trailing run of assistant bubbles.

export interface ClaudeOutputLike {
  text?: string
  isFinal?: boolean
  isStreaming?: boolean
  messageId?: string | null
}

const norm = (t: string) => t.replace(/\s+/g, ' ').trim()

export function isRedundantFinal(
  data: ClaudeOutputLike,
  ctx: { seenMessageIds: ReadonlySet<string>; trailingAssistantTexts: string[] },
): boolean {
  if (!data?.isFinal) return false
  if (data.messageId) return ctx.seenMessageIds.has(data.messageId)
  if (!data.text || ctx.trailingAssistantTexts.length === 0) return false
  return norm(ctx.trailingAssistantTexts.join(' ')) === norm(data.text)
}
