/**
 * turn-detector-shim.ts — LiveKit Cloud turn detection without JobContext
 *
 * The official MultilingualModel crashes without LiveKit's worker framework
 * because it calls getJobContext(). This shim implements the same _TurnDetector
 * interface but makes the remote HTTP call directly — no worker framework needed.
 *
 * Auth: LiveKit Cloud inference requires a signed JWT (same format as room access
 * tokens). We cache the token and refresh it before expiry so we're not signing
 * on every turn.
 *
 * On LiveKit Cloud (LIVEKIT_REMOTE_EOT_URL set): HTTP call to inference gateway.
 * Without the URL: Returns 1.0 (always end of turn — STT endpointing handles it).
 */

import type { llm } from '@livekit/agents'
import { log } from '@livekit/agents'
import { AccessToken } from 'livekit-server-sdk'

const REMOTE_INFERENCE_TIMEOUT = 2000
const MAX_HISTORY_TURNS = 15
const TOKEN_TTL_SECONDS = 600        // 10-minute JWT
const TOKEN_REFRESH_BUFFER = 60      // refresh 60s before expiry

export class CloudTurnDetector {
  #remoteUrl: string | undefined
  #logger = log()
  #cachedToken: string | undefined
  #tokenExpiresAt = 0

  readonly model = 'lk_end_of_utterance_multilingual'
  readonly provider = 'livekit'

  constructor() {
    const raw = process.env.LIVEKIT_REMOTE_EOT_URL
    // EOT endpoint is HTTP — convert wss:// → https:// if the env var uses WebSocket scheme
    this.#remoteUrl = raw
      ? raw.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://')
      : undefined
    if (this.#remoteUrl) {
      console.log(`🧠 Turn detector: LiveKit Cloud remote inference (${this.#remoteUrl})`)
    } else {
      console.log('🧠 Turn detector: No LIVEKIT_REMOTE_EOT_URL — STT endpointing only')
    }
  }

  async #getAuthToken(): Promise<string | undefined> {
    const apiKey = process.env.LIVEKIT_API_KEY
    const apiSecret = process.env.LIVEKIT_API_SECRET
    if (!apiKey || !apiSecret) return undefined

    const nowSec = Math.floor(Date.now() / 1000)
    if (this.#cachedToken && nowSec < this.#tokenExpiresAt - TOKEN_REFRESH_BUFFER) {
      return this.#cachedToken
    }

    // Sign a fresh token — identity is the agent, no room grants needed for inference
    const at = new AccessToken(apiKey, apiSecret, {
      identity: 'osborn-eot-agent',
      ttl: `${TOKEN_TTL_SECONDS}s`,
    })
    this.#cachedToken = await at.toJwt()
    this.#tokenExpiresAt = nowSec + TOKEN_TTL_SECONDS
    return this.#cachedToken
  }

  async unlikelyThreshold(_language?: string): Promise<number | undefined> {
    return undefined
  }

  async supportsLanguage(_language?: string): Promise<boolean> {
    return true
  }

  /**
   * Startup probe — send a minimal request to confirm the endpoint returns
   * valid JSON probability. Returns true if the EOT service is live and real.
   * Called once at session init; if false, index.ts falls back to 'stt'.
   */
  async probe(): Promise<boolean> {
    if (!this.#remoteUrl) return false
    try {
      const token = await this.#getAuthToken()
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (token) headers['Authorization'] = `Bearer ${token}`
      const resp = await fetch(`${this.#remoteUrl}/eot/multi`, {
        method: 'POST',
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'test' }],
          jobId: 'osborn-probe',
          workerId: 'osborn-direct',
        }),
        headers,
        signal: AbortSignal.timeout(3000),
      })
      if (!resp.ok) return false
      const text = await resp.text()
      try {
        const data = JSON.parse(text) as { probability?: number }
        const ok = typeof data.probability === 'number'
        console.log(`🧠 EOT probe: ${ok ? '✅ live' : '❌ non-JSON ("' + text.slice(0, 30) + '")'} — ${ok ? 'using CloudTurnDetector' : 'falling back to STT'}`)
        return ok
      } catch {
        console.log(`🧠 EOT probe: ❌ non-JSON response ("${text.slice(0, 40)}") — falling back to STT endpointing`)
        return false
      }
    } catch (err) {
      console.log(`🧠 EOT probe: ❌ unreachable — ${err instanceof Error ? err.message : err} — falling back to STT`)
      return false
    }
  }

  async predictEndOfTurn(chatCtx: llm.ChatContext, _timeout?: number): Promise<number> {
    if (!this.#remoteUrl) {
      return 1.0
    }

    try {
      const messages = chatCtx
        .copy({
          excludeFunctionCall: true,
          excludeInstructions: true,
          excludeEmptyMessage: true,
        })
        .truncate(MAX_HISTORY_TURNS)

      const request: any = {
        ...messages.toJSON({
          excludeImage: true,
          excludeAudio: true,
          excludeTimestamp: true,
        }),
        jobId: `osborn-${Date.now()}`,
        workerId: 'osborn-direct',
      }

      const agentId = process.env.LIVEKIT_AGENT_ID
      if (agentId) request.agentId = agentId

      const token = await this.#getAuthToken()
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (token) headers['Authorization'] = `Bearer ${token}`

      const resp = await fetch(`${this.#remoteUrl}/eot/multi`, {
        method: 'POST',
        body: JSON.stringify(request),
        headers,
        signal: AbortSignal.timeout(REMOTE_INFERENCE_TIMEOUT),
      })

      if (!resp.ok) {
        this.#logger.warn(`EOT inference returned ${resp.status} — falling back to STT`)
        return 1.0
      }

      const text = await resp.text()
      try {
        const data = JSON.parse(text) as { probability?: number }
        if (typeof data.probability === 'number' && data.probability >= 0) {
          return data.probability
        }
      } catch {
        // Non-JSON response (e.g. "OK") — log once then fall through
        this.#logger.warn(`EOT inference returned non-JSON: "${text.slice(0, 40)}" — auth may be wrong`)
      }

      return 1.0
    } catch {
      return 1.0
    }
  }
}
