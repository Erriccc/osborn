/** Model cost of one brain call: the change in Stagehand's running totals. */
export type MetricsTotals = { totalPromptTokens?: number; totalCompletionTokens?: number; totalReasoningTokens?: number; totalInferenceTimeMs?: number }
export type ActUsage = { tokens: { prompt: number; completion: number; reasoning: number; total: number }; modelMs: number }

export const NO_USAGE: ActUsage = { tokens: { prompt: 0, completion: 0, reasoning: 0, total: 0 }, modelMs: 0 }

/** The totals now, copied: a local Stagehand's `metrics` resolves to the live object it keeps adding to. */
export async function readTotals(sh: { metrics: MetricsTotals | Promise<MetricsTotals> } | null | undefined): Promise<MetricsTotals | null> {
  try {
    const m = sh ? await sh.metrics : null
    return m ? { totalPromptTokens: m.totalPromptTokens, totalCompletionTokens: m.totalCompletionTokens, totalReasoningTokens: m.totalReasoningTokens, totalInferenceTimeMs: m.totalInferenceTimeMs } : null
  } catch { return null }
}

export function metricsDelta(before: MetricsTotals | null | undefined, after: MetricsTotals | null | undefined): ActUsage {
  if (!before || !after) return NO_USAGE
  const d = (a?: number, b?: number) => Math.max(0, (Number(a) || 0) - (Number(b) || 0))
  const prompt = d(after.totalPromptTokens, before.totalPromptTokens)
  const completion = d(after.totalCompletionTokens, before.totalCompletionTokens)
  const reasoning = d(after.totalReasoningTokens, before.totalReasoningTokens)
  return { tokens: { prompt, completion, reasoning, total: prompt + completion + reasoning }, modelMs: Math.round(d(after.totalInferenceTimeMs, before.totalInferenceTimeMs)) }
}
