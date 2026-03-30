/**
 * turn-detector-shim.ts — LiveKit Cloud turn detection without JobContext
 *
 * The official MultilingualModel crashes without LiveKit's worker framework
 * because it calls getJobContext(). This shim implements the same _TurnDetector
 * interface but makes the remote HTTP call directly — no worker framework needed.
 *
 * On LiveKit Cloud (LIVEKIT_REMOTE_EOT_URL set): HTTP call to inference gateway.
 * Without the URL: Returns 1.0 (always end of turn — STT endpointing handles it).
 */

import type { llm } from '@livekit/agents'
import { log } from '@livekit/agents'

const REMOTE_INFERENCE_TIMEOUT = 2000
const MAX_HISTORY_TURNS = 15

/**
 * Implements _TurnDetector interface for LiveKit Cloud remote inference
 * without requiring JobContext / worker framework.
 */
export class CloudTurnDetector {
  #remoteUrl: string | undefined
  #logger = log()

  readonly model = 'lk_end_of_utterance_multilingual'
  readonly provider = 'livekit'

  constructor() {
    this.#remoteUrl = process.env.LIVEKIT_REMOTE_EOT_URL
    if (this.#remoteUrl) {
      console.log(`🧠 Turn detector: LiveKit Cloud remote inference`)
    } else {
      console.log('🧠 Turn detector: No LIVEKIT_REMOTE_EOT_URL — STT endpointing fallback')
    }
  }

  async unlikelyThreshold(_language?: string): Promise<number | undefined> {
    return undefined // Let the framework use defaults
  }

  async supportsLanguage(_language?: string): Promise<boolean> {
    return true // Multilingual model supports all languages
  }

  async predictEndOfTurn(chatCtx: llm.ChatContext, _timeout?: number): Promise<number> {
    if (!this.#remoteUrl) {
      return 1.0 // No remote URL = always end of turn (STT handles it)
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
        // Dummy IDs — LiveKit Cloud uses these for routing/logging, not auth
        jobId: `osborn-${Date.now()}`,
        workerId: 'osborn-direct',
      }

      const agentId = process.env.LIVEKIT_AGENT_ID
      if (agentId) {
        request.agentId = agentId
      }

      const resp = await fetch(`${this.#remoteUrl}/eot/multi`, {
        method: 'POST',
        body: JSON.stringify(request),
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(REMOTE_INFERENCE_TIMEOUT),
      })

      if (!resp.ok) {
        return 1.0 // Failed — default to end of turn
      }

      const data = (await resp.json()) as { probability?: number }
      if (typeof data.probability === 'number' && data.probability >= 0) {
        return data.probability
      }

      return 1.0
    } catch {
      return 1.0 // Timeout/error — default to end of turn
    }
  }
}
