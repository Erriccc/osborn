// Gemini brain model choice. A retired model answers 404; only that moves on to the next model.
// An env override is tried first, then the default, then the fallbacks.
export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite'
const GEMINI_FALLBACK_MODELS = ['gemini-3.1-flash-lite', 'gemini-3.8-flash']

const geminiCandidates = (env: Record<string, string | undefined> = process.env): string[] =>
  [...new Set([env.OSBORN_ENGINE_GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL, DEFAULT_GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS])]

// `probe` returns the HTTP status (200 = ok, null = network). Key and billing errors (401/402/429) and
// network errors stop at once; the caller moves to the next provider.
export async function pickGeminiModel(
  probe: (model: string) => Promise<number | null>,
  env: Record<string, string | undefined> = process.env,
): Promise<{ model: string | null; tried: string[] }> {
  const tried: string[] = []
  for (const model of geminiCandidates(env)) {
    const status = await probe(model)
    if (status === 200) return { model, tried }
    tried.push(`gemini ${status ?? 'network'} (${model})`)
    if (status !== 404) break
  }
  return { model: null, tried }
}
