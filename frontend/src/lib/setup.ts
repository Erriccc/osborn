// ============================================================
// SETUP WIZARD UTILITIES
// Pure logic for env file generation, validation, and health checks
// ============================================================

export interface EnvConfig {
  livekitUrl: string
  livekitApiKey: string
  livekitApiSecret: string
  anthropicApiKey: string
  voiceProvider: 'openai' | 'gemini'
  openaiApiKey: string
  googleApiKey: string
  smitheryApiKey: string
}

export const defaultEnvConfig: EnvConfig = {
  livekitUrl: '',
  livekitApiKey: '',
  livekitApiSecret: '',
  anthropicApiKey: '',
  voiceProvider: 'openai',
  openaiApiKey: '',
  googleApiKey: '',
  smitheryApiKey: '',
}

/**
 * Generate agent/.env file content from config
 */
export function generateAgentEnv(config: EnvConfig): string {
  const lines: string[] = [
    '# LiveKit',
    `LIVEKIT_URL=${config.livekitUrl}`,
    `LIVEKIT_API_KEY=${config.livekitApiKey}`,
    `LIVEKIT_API_SECRET=${config.livekitApiSecret}`,
    '',
    '# Anthropic (Claude)',
    `ANTHROPIC_API_KEY=${config.anthropicApiKey}`,
    '',
    '# Voice Provider',
  ]

  if (config.openaiApiKey) {
    lines.push(`OPENAI_API_KEY=${config.openaiApiKey}`)
  }
  if (config.googleApiKey) {
    lines.push(`GOOGLE_API_KEY=${config.googleApiKey}`)
  }

  if (config.smitheryApiKey) {
    lines.push('')
    lines.push('# MCP (optional)')
    lines.push(`SMITHERY_API_KEY=${config.smitheryApiKey}`)
  }

  lines.push('')
  return lines.join('\n')
}

/**
 * Generate frontend/.env.local file content from config
 */
export function generateFrontendEnv(config: EnvConfig): string {
  return [
    '# LiveKit',
    `NEXT_PUBLIC_LIVEKIT_URL=${config.livekitUrl}`,
    `LIVEKIT_API_KEY=${config.livekitApiKey}`,
    `LIVEKIT_API_SECRET=${config.livekitApiSecret}`,
    '',
  ].join('\n')
}

/**
 * Validate a LiveKit URL (must start with wss://)
 */
export function validateLivekitUrl(url: string): boolean {
  return url.startsWith('wss://')
}

/**
 * Validate an Anthropic API key (must start with sk-ant-)
 */
export function validateAnthropicKey(key: string): boolean {
  return key.startsWith('sk-ant-')
}

/**
 * Check if the agent server is reachable
 */
export async function checkAgentHealth(agentUrl: string): Promise<{ ok: boolean; message: string }> {
  try {
    const baseUrl = agentUrl.replace(/\/+$/, '')
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5000) })
    if (res.ok) {
      return { ok: true, message: 'Agent is running and healthy' }
    }
    return { ok: false, message: `Agent responded with status ${res.status}` }
  } catch {
    return { ok: false, message: 'Could not reach agent server' }
  }
}
