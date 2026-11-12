/**
 * key-health.ts — a tiny, REAL "can this provider actually answer?" self-test for
 * the no-Claude fallback tiers (issue #87, gap 5).
 *
 * The bug this surfaces: applyAuthFallback() picks a tier because a key is
 * PRESENT, but presence is not validity — the observed test account had a z.ai
 * key that failed and an OpenRouter key that had expired, and nothing said so;
 * the session showed "Listening" and silently never replied (the #70 symptom).
 *
 * This fires ONE minimal /v1/messages request against the ACTIVE provider's
 * endpoint (the exact env applyAuthFallback already set) to confirm the
 * configured key can really answer. The result rides GET /health, so a dead key
 * becomes a visible "No working model" instead of a silent non-reply.
 *
 * Design rules (adversarial review of #87):
 *   - NEVER on the Claude path (tier 1) and never on the connect critical path:
 *     the caller runs it fire-and-forget AFTER the session starts, fallback-only,
 *     so it adds zero boot latency to a normal Claude session.
 *   - Conservative classification: only a DEFINITIVE auth/billing failure
 *     (401/403/402) becomes a negative verdict. A 4xx that could be an endpoint
 *     quirk (400/404), any 5xx, a timeout or a network error yields NO verdict
 *     (null) — a transient blip must never fabricate "No working model".
 *
 * Shape mirrors the frontend's KeyHealthEntry (frontend/src/lib/agent-health.ts)
 * so resolveAgentHealth consumes it unchanged.
 */

import { cleanEnvKey } from './claude-auth.js'

/** One fallback key's self-test result. Mirrors the frontend KeyHealthEntry. */
export interface KeyHealthEntry {
  /** Provider key, e.g. 'zai' | 'openrouter' | 'anthropic'. */
  provider: string
  /** Outcome of the tiny real request. */
  status: 'ok' | 'failed' | 'expired'
  /** ISO timestamp of the test. */
  checkedAt?: string
}

/**
 * Classify a /v1/messages probe's HTTP status into a key-health verdict, or null
 * when the outcome is ambiguous (no honest verdict — see module header).
 *   2xx                 → ok       (the key answered)
 *   429                 → ok       (valid key, just rate-limited)
 *   401, 403            → expired  (bad / expired credential)
 *   402                 → failed   (billing / credit depleted)
 *   anything else       → null     (endpoint quirk / 5xx / unknown — no verdict)
 */
export function classifyProbeStatus(httpStatus: number): 'ok' | 'failed' | 'expired' | null {
  if (httpStatus >= 200 && httpStatus < 300) return 'ok'
  if (httpStatus === 429) return 'ok'
  if (httpStatus === 401 || httpStatus === 403) return 'expired'
  if (httpStatus === 402) return 'failed'
  return null
}

/**
 * Fire ONE minimal request against the ACTIVE provider endpoint to confirm the
 * configured key can really answer. Reads the env applyAuthFallback() already
 * set (ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY /
 * ANTHROPIC_MODEL), so it tests exactly what query() will use. All fallback
 * tiers speak native Anthropic Messages, so one request shape covers them.
 *
 * Returns the verdict entry, or null when there was nothing to test or the
 * outcome was ambiguous (never a fabricated failure).
 */
export async function probeActiveProviderKey(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 8000,
): Promise<KeyHealthEntry | null> {
  const base = (cleanEnvKey(env.ANTHROPIC_BASE_URL) || 'https://api.anthropic.com').replace(/\/$/, '')
  const authToken = cleanEnvKey(env.ANTHROPIC_AUTH_TOKEN)
  const apiKey = cleanEnvKey(env.ANTHROPIC_API_KEY)
  const model = cleanEnvKey(env.ANTHROPIC_MODEL) || 'claude-3-5-haiku-latest'
  // Nothing to test — no credential configured for the active endpoint.
  if (!authToken && !apiKey) return null

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
  }
  // Fallback redirects (z.ai / OpenRouter) authenticate with a bearer AUTH_TOKEN;
  // a user's own Anthropic key uses x-api-key. applyAuthFallback sets exactly one.
  if (authToken) headers['authorization'] = `Bearer ${authToken}`
  else headers['x-api-key'] = apiKey

  const body = JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] })
  try {
    const r = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const verdict = classifyProbeStatus(r.status)
    if (!verdict) return null
    return { provider, status: verdict, checkedAt: new Date().toISOString() }
  } catch {
    // Network error / timeout — ambiguous, never a fabricated verdict.
    return null
  }
}
