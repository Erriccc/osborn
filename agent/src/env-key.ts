/**
 * env-key.ts — model keys and the z.ai Coding Plan settings, read from the
 * environment. Dependency-free so the content workers can share it with
 * claude-auth.ts (which pulls in node-pty) and pipeline-fastbrain.ts.
 */

/** Trim whitespace and strip one layer of surrounding quotes from an env value. */
export function cleanEnvKey(value: string | undefined | null): string {
  if (!value) return ''
  let v = value.trim()
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    v = v.slice(1, -1).trim()
  }
  return v
}

/** The z.ai GLM Coding Plan key: Z_AI_PERSONAL_API_KEY, then ZAI_API_KEY. Empty when neither is set. */
export function zaiApiKey(env: NodeJS.ProcessEnv = process.env): string {
  return cleanEnvKey(env.Z_AI_PERSONAL_API_KEY) || cleanEnvKey(env.ZAI_API_KEY)
}

/** The Coding Plan's OpenAI-compatible endpoint; the plain /api/paas/v4 bills the pay-as-you-go wallet instead. */
export const ZAI_CODING_BASE = 'https://api.z.ai/api/coding/paas/v4'
/** The plan's main model: OSBORN_DEMO_MODEL, default glm-5.3 (docs.z.ai/devpack/overview). */
export const zaiModel = (): string => (process.env.OSBORN_DEMO_MODEL || '').trim() || 'glm-5.3'
/** GLM-5.3 / GLM-5.3-Flash: 1M-token context (docs.z.ai/guides/llm/glm-5.3, …/glm-5.3-flash). */
export const ZAI_CONTEXT_LENGTH = 1_000_000
