/**
 * env-keys.ts — the agent's source-of-truth list of environment variables it
 * expects to find in process.env at runtime, mirroring the frontend's
 * platform-env.ts injection spec.
 *
 * Today the agent reads these directly from process.env (some explicitly, some
 * implicitly via the LiveKit plugin SDKs which read env internally). This module
 * gives that set ONE name so:
 *   • a future runtime path can hydrate process.env from a cloud/user config
 *     layer before the plugins read it, using this list as the set to fetch, and
 *   • startup can log which expected keys are missing for diagnosis.
 *
 * Keep in sync with frontend/src/lib/platform-env.ts (PLATFORM_ENV_SPEC).
 */

export interface AgentEnvKey {
  key: string
  required: boolean
  /** true = read directly via process.env.X in agent source; false = consumed
   *  implicitly by a plugin SDK (Deepgram/Soniox/Gemini realtime) reading env. */
  explicit: boolean
  description: string
}

export const AGENT_ENV_KEYS: AgentEnvKey[] = [
  // Voice transport
  { key: 'LIVEKIT_URL', required: true, explicit: true, description: 'LiveKit server URL.' },
  { key: 'LIVEKIT_API_KEY', required: true, explicit: true, description: 'LiveKit API key.' },
  { key: 'LIVEKIT_API_SECRET', required: true, explicit: true, description: 'LiveKit API secret.' },
  // STT / inference (plugin-consumed unless noted)
  { key: 'DEEPGRAM_API_KEY', required: true, explicit: false, description: 'Deepgram STT (LiveKit plugin).' },
  { key: 'SONIOX_API_KEY', required: false, explicit: false, description: 'Soniox STT (LiveKit plugin).' },
  { key: 'GROQ_API_KEY', required: false, explicit: true, description: 'Groq fast-brain inference.' },
  { key: 'OPENAI_API_KEY', required: true, explicit: true, description: 'OpenAI realtime + pipeline.' },
  { key: 'GOOGLE_API_KEY', required: false, explicit: false, description: 'Google Gemini realtime (plugin).' },
  // LLM auth (Claude vs OpenRouter switch)
  { key: 'ANTHROPIC_API_KEY', required: false, explicit: true, description: 'Anthropic/Claude auth (per-user; may be OAuth file instead).' },
  { key: 'OPENROUTER_API_KEY', required: false, explicit: true, description: 'OpenRouter model routing.' },
  // Integrations
  { key: 'RECALL_API_KEY', required: false, explicit: true, description: 'Recall.ai meeting bot.' },
  { key: 'RECALL_REGION', required: false, explicit: true, description: 'Recall.ai region.' },
  { key: 'SMITHERY_API_KEY', required: false, explicit: true, description: 'Smithery hosted-MCP catalog.' },
  // Platform / infra
  { key: 'OSBORN_API_PORT', required: true, explicit: true, description: 'Agent HTTP server port.' },
  { key: 'OSBORN_CWD', required: false, explicit: true, description: 'Agent working directory.' },
  { key: 'OSBORN_SYNC_TOKEN', required: false, explicit: true, description: 'Session export/import auth token.' },
  { key: 'OSBORN_FRONTEND_URL', required: false, explicit: true, description: 'Frontend base URL for artifact upload.' },
  { key: 'DEV_DOMAIN', required: false, explicit: true, description: 'Wildcard dev-routing domain.' },
]

/** Keys the agent treats as required — absence should be surfaced at startup. */
export const REQUIRED_AGENT_ENV_KEYS: string[] = AGENT_ENV_KEYS
  .filter((k) => k.required)
  .map((k) => k.key)

/** Return the required keys that are missing from the given env (default process.env). */
export function missingRequiredEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return REQUIRED_AGENT_ENV_KEYS.filter((k) => !env[k])
}
