/**
 * platform-env.ts — SINGLE SOURCE OF TRUTH for the environment variables that
 * get injected into every osborn agent machine, across ALL provisioning
 * backends (Fly Machines, Sprites, Daytona).
 *
 * WHY THIS FILE EXISTS
 * Before this module, the "canonical key set" was declared independently in
 * machines.ts, sprites.ts, and daytona.ts — three lists that had drifted out of
 * sync (Fly forwarded GROQ but not RECALL_REGION; sprites the reverse; daytona
 * was missing six keys). That drift is silent: a machine simply comes up without
 * a key and the feature that needs it fails at runtime. Consolidating here means
 * one list to read, one list to change.
 *
 * WHAT EACH BACKEND STILL OWNS
 * The *literals* legitimately differ per backend (port, HOME, workspace path) and
 * stay in each backend's getPlatformEnvVars. What they now SHARE is:
 *   • PLATFORM_FORWARD_KEYS — the union of keys forwarded from the frontend
 *     host's process.env onto the machine, and
 *   • the livekitRoom(userId) derivation.
 *
 * VISIBILITY (Phase 1 groundwork)
 * PLATFORM_ENV_SPEC classifies every injected key by scope (platform-owned vs
 * user-addable), whether it's required, and whether it's a secret to mask in UI.
 * This is the data a future "manage API keys / connected platforms" surface reads
 * to show operator-set keys read-only and let users add their own overrides.
 */

export type EnvScope = 'platform' | 'user'
export type EnvSource = 'host-env' | 'literal' | 'per-user'

export interface EnvKeySpec {
  key: string
  /** host-env: forwarded from the frontend host's process.env. literal: computed
   *  per-backend (port/room/paths). per-user: sourced from the user's stored config. */
  source: EnvSource
  /** platform = operator-set (shown read-only in UI). user = user can add/override. */
  scope: EnvScope
  /** true = the agent misbehaves or a core feature breaks without it. */
  required: boolean
  /** true = value must be masked in any UI and never logged. */
  secret: boolean
  description: string
}

/**
 * Every env var injected onto a machine. Keep this list authoritative — adding a
 * key the machine should receive means adding it here, not editing three files.
 * `source: 'literal'` entries are documented here for visibility but are built
 * per-backend (their values depend on backend-specific ports/paths).
 */
export const PLATFORM_ENV_SPEC: EnvKeySpec[] = [
  // ── LiveKit (voice transport) — platform-required ──
  { key: 'LIVEKIT_URL', source: 'host-env', scope: 'platform', required: true, secret: true, description: 'LiveKit server URL for the voice room.' },
  { key: 'LIVEKIT_API_KEY', source: 'host-env', scope: 'platform', required: true, secret: true, description: 'LiveKit API key (mints room tokens).' },
  { key: 'LIVEKIT_API_SECRET', source: 'host-env', scope: 'platform', required: true, secret: true, description: 'LiveKit API secret.' },
  { key: 'NEXT_PUBLIC_LIVEKIT_URL', source: 'host-env', scope: 'platform', required: false, secret: false, description: 'Public LiveKit URL for the browser client.' },
  // ── STT / TTS providers — platform-set ──
  { key: 'DEEPGRAM_API_KEY', source: 'host-env', scope: 'platform', required: true, secret: true, description: 'Deepgram STT (consumed implicitly by the LiveKit Deepgram plugin).' },
  { key: 'SONIOX_API_KEY', source: 'host-env', scope: 'platform', required: false, secret: true, description: 'Soniox STT (alternate transcription plugin).' },
  { key: 'GROQ_API_KEY', source: 'host-env', scope: 'platform', required: false, secret: true, description: 'Groq inference (fast-brain / low-latency paths).' },
  // ── LLM providers ──
  { key: 'OPENAI_API_KEY', source: 'host-env', scope: 'platform', required: true, secret: true, description: 'OpenAI (realtime voice + pipeline STT/TTS fallbacks).' },
  { key: 'GOOGLE_API_KEY', source: 'host-env', scope: 'platform', required: false, secret: true, description: 'Google Gemini (realtime plugin, consumed implicitly).' },
  { key: 'ANTHROPIC_API_KEY', source: 'host-env', scope: 'user', required: false, secret: true, description: 'Anthropic API key — per-user Claude auth (users may bring their own; also settable via OAuth file).' },
  { key: 'OPENROUTER_API_KEY', source: 'host-env', scope: 'user', required: false, secret: true, description: 'OpenRouter key — alternate model routing for the agent.' },
  // ── Integrations ──
  { key: 'RECALL_API_KEY', source: 'host-env', scope: 'user', required: false, secret: true, description: 'Recall.ai meeting-bot token.' },
  { key: 'RECALL_REGION', source: 'host-env', scope: 'user', required: false, secret: false, description: 'Recall.ai regional endpoint selector (default us-west-2).' },
  { key: 'SMITHERY_API_KEY', source: 'host-env', scope: 'platform', required: false, secret: true, description: 'Smithery hosted-MCP catalog key.' },
  // ── Platform literals (built per-backend; listed here for visibility) ──
  { key: 'OSBORN_API_PORT', source: 'literal', scope: 'platform', required: true, secret: false, description: 'Port the agent HTTP server binds (8741 on Fly, 8080 on Sprites).' },
  { key: 'LIVEKIT_ROOM', source: 'literal', scope: 'platform', required: true, secret: false, description: 'Per-user LiveKit room name (osborn-<uid8>).' },
  { key: 'DEV_DOMAIN', source: 'literal', scope: 'platform', required: false, secret: false, description: 'Wildcard dev-routing domain.' },
  { key: 'DEV_APP_NAME', source: 'literal', scope: 'platform', required: false, secret: false, description: 'This machine\'s app name (dev-router routing).' },
  { key: 'OSBORN_SYNC_TOKEN', source: 'per-user', scope: 'platform', required: false, secret: true, description: 'Per-user token authorizing the agent to call the frontend session export/import endpoints.' },
  { key: 'OSBORN_FRONTEND_URL', source: 'literal', scope: 'platform', required: false, secret: false, description: 'Frontend base URL the agent uploads artifacts to.' },
]

/**
 * The union of keys forwarded from the frontend host's process.env onto every
 * machine. This REPLACES the three drifted per-backend forwardKeys arrays — all
 * backends now forward the same set (a key absent from the host env is simply
 * skipped, so forwarding a superset is safe).
 */
export const PLATFORM_FORWARD_KEYS: string[] = PLATFORM_ENV_SPEC
  .filter((s) => s.source === 'host-env')
  .map((s) => s.key)

/**
 * Read the given keys (default: all host-env platform keys) from the frontend
 * host's process.env, returning only those actually set. This is the one place
 * that reads host env for machine provisioning.
 */
export function forwardHostEnv(keys: readonly string[] = PLATFORM_FORWARD_KEYS): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of keys) {
    const v = process.env[key]
    if (v) out[key] = v
  }
  return out
}

/** Per-user LiveKit room name — identical derivation across all backends. */
export function livekitRoom(userId: string): string {
  return `osborn-${userId.substring(0, 8)}`
}
