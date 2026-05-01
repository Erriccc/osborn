import { EventEmitter } from 'node:events'

const RECALL_REGION = process.env.RECALL_REGION ?? 'us-west-2'
const RECALL_BASE_URL = `https://${RECALL_REGION}.recall.ai/api/v1`

export interface RecallBot {
  id: string
  meeting_url: string
  status: string
}

export interface TranscriptWord {
  text: string
  start_time: number
  end_time: number
}

export interface TranscriptPayload {
  bot_id: string
  transcript: {
    speaker: string
    words: TranscriptWord[]
    is_final: boolean
    language?: string
  }
}

export class RecallClient extends EventEmitter {
  #apiKey: string
  #activeBots = new Map<string, string>() // botId → sessionId

  constructor(apiKey: string) {
    super()
    this.#apiKey = apiKey
  }

  async joinMeeting(meetingUrl: string, webhookBaseUrl: string, botName = 'Osborn'): Promise<string> {
    const res = await fetch(`${RECALL_BASE_URL}/bot`, {
      method: 'POST',
      headers: {
        'Authorization': `Token ${this.#apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        meeting_url: meetingUrl,
        bot_name: botName,
        recording_config: {
          // `transcript: true` was rejected as "Expected a dictionary, but got bool" —
          // omit; `transcription_options` below already configures the transcript provider.
          real_time_endpoints: [{
            type: 'webhook',
            config: {
              url: `${webhookBaseUrl}/webhook/recall`,
              events: ['transcript.data'],
            },
          }],
          transcription_options: {
            provider: 'assembly_ai',
            mode: 'prioritize_low_latency', // default delays transcripts 3-10 minutes
          },
        },
        output_media: {
          camera: {
            // Recall API expects `kind` (not `type`); the wrong key arrives as null and
            // gets rejected as "Invalid choice null. Expected 'webpage' or 'default'."
            kind: 'webpage',
            config: {
              url: `${webhookBaseUrl}/meeting-output`,
            },
          },
        },
      }),
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Recall.ai join failed: ${res.status} ${err}`)
    }

    const bot = (await res.json()) as RecallBot
    console.log(`🤖 Recall.ai bot joined meeting: ${bot.id}`)
    return bot.id
  }

  async leaveMeeting(botId: string): Promise<void> {
    await fetch(`${RECALL_BASE_URL}/bot/${botId}/leave_call`, {
      method: 'POST',
      headers: { 'Authorization': `Token ${this.#apiKey}` },
    })
    this.#activeBots.delete(botId)
    console.log(`👋 Recall.ai bot left meeting: ${botId}`)
  }

  async getBotStatus(botId: string): Promise<string> {
    const res = await fetch(`${RECALL_BASE_URL}/bot/${botId}`, {
      headers: { 'Authorization': `Token ${this.#apiKey}` },
    })
    const bot = (await res.json()) as any
    return bot.status_changes?.at(-1)?.code ?? 'unknown'
  }

  handleWebhook(payload: TranscriptPayload): void {
    if (!payload.transcript?.is_final) return
    const text = payload.transcript.words.map(w => w.text).join(' ').trim()
    if (!text) return
    this.emit('transcript', {
      botId: payload.bot_id,
      speaker: payload.transcript.speaker,
      text,
    })
  }

  registerBot(botId: string, sessionId: string): void {
    this.#activeBots.set(botId, sessionId)
  }

  getSessionId(botId: string): string | undefined {
    return this.#activeBots.get(botId)
  }

  hasActiveBot(): boolean {
    return this.#activeBots.size > 0
  }

  getActiveBotIds(): string[] {
    return [...this.#activeBots.keys()]
  }
}

// Singleton
let _recallClient: RecallClient | null = null

export function getRecallClient(): RecallClient | null {
  if (!process.env.RECALL_API_KEY) return null
  if (!_recallClient) {
    _recallClient = new RecallClient(process.env.RECALL_API_KEY)
  }
  return _recallClient
}
