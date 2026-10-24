/**
 * Shared text-model provider resolution for the platform-side content routes
 * (/api/content/refine, /api/content/chat). Mirrors the agent-side house demo
 * pass: Fireworks first (pay-per-use, gpt-oss-120b), z.ai GLM subscription as
 * the fallback so content ops keep working without a Fireworks key.
 * Embeddings are NOT covered — the z.ai pass has no embedding model; the agent
 * embedder stays on Fireworks.
 */
export interface TextProvider {
  url: string
  key: string
  model: string
  name: string
}

export function resolveTextProvider(): TextProvider | null {
  const fw = process.env.FIREWORKS_API_KEY
  if (fw) {
    return {
      url: 'https://api.fireworks.ai/inference/v1/chat/completions',
      key: fw,
      model: 'accounts/fireworks/models/gpt-oss-120b',
      name: 'Fireworks',
    }
  }
  const zai = process.env.Z_AI_PERSONAL_API_KEY
  if (zai) {
    return {
      url: 'https://api.z.ai/api/paas/v4/chat/completions',
      key: zai,
      model: process.env.OSBORN_DEMO_FAST_MODEL || 'glm-4.5-air',
      name: 'z.ai (house pass)',
    }
  }
  return null
}
