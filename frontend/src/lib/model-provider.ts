/** Text-model provider for the content routes: Fireworks first, the z.ai house pass as the fallback. */
export interface TextProvider {
  url: string
  key: string
  model: string
  name: string
}

/** The default models are GLM-5.3, which always thinks: at its default effort the reasoning used a route's whole
 *  max_tokens (refine 2048, chat 1024) and the reply came back empty. Spread into every request body. */
export const LOW_REASONING = { reasoning_effort: 'low' } as const

export function resolveTextProvider(): TextProvider | null {
  const fw = process.env.FIREWORKS_API_KEY
  if (fw) {
    return {
      url: 'https://api.fireworks.ai/inference/v1/chat/completions',
      key: fw,
      model: 'accounts/fireworks/models/glm-5p3-flash',
      name: 'Fireworks',
    }
  }
  // Same precedence as the agent (claude-auth / pipeline-fastbrain).
  const zai = process.env.Z_AI_PERSONAL_API_KEY || process.env.ZAI_API_KEY
  if (zai) {
    return {
      // Coding Plan endpoint - the standard /api/paas/v4 bills the pay-as-you-go
      // wallet instead of the GLM Coding Plan quota.
      url: 'https://api.z.ai/api/coding/paas/v4/chat/completions',
      key: zai,
      model: process.env.OSBORN_DEMO_FAST_MODEL || 'glm-5.3-flash',
      name: 'z.ai (house pass)',
    }
  }
  return null
}
