import { EventEmitter } from 'node:events'

const RECALL_REGION = process.env.RECALL_REGION ?? 'us-west-2'
const RECALL_BASE_URL = `https://${RECALL_REGION}.recall.ai/api/v1`

export interface RecallBot {
  id: string
  meeting_url: string
  status: string
}

// Webhook payload shape per Recall.ai docs:
// https://docs.recall.ai/docs/real-time-transcription
// event: "transcript.data" (final) | "transcript.partial_data" (interim)
// data.data.words[].text — word text
// data.data.participant.name — speaker name
// data.bot.id — bot id
export interface TranscriptPayload {
  event: string
  data: {
    data: {
      words: Array<{
        text: string
        start_timestamp?: { relative?: number }
        end_timestamp?: { relative?: number }
      }>
      language_code?: string
      participant?: {
        id: number
        name: string
        is_host?: boolean
        platform?: string
      }
    }
    bot?: { id: string }
    recording?: { id: string }
  }
}

export class RecallClient extends EventEmitter {
  #apiKey: string
  #activeBots = new Map<string, string>() // botId → sessionId

  constructor(apiKey: string) {
    super()
    this.#apiKey = apiKey
  }

  /**
   * Join a meeting via Recall.ai.
   *
   * @param meetingUrl       Zoom / Google Meet / Teams URL the bot should dial in to
   * @param webhookBaseUrl   Base URL for the agent's HTTP endpoints (transcript webhook)
   * @param opts.outputPageUrl  Full URL for the bot's camera/audio page. If provided,
   *                            replaces the default `${webhookBaseUrl}/meeting-output`.
   *                            Used to point at the frontend-hosted /meeting-bot page
   *                            with token + room embedded as query params, so the page
   *                            connects to LiveKit and audio flows through the same
   *                            room as the osborn agent (no separate WebSocket+WAV pipe).
   * @param opts.botName     Display name of the bot in the meeting
   */
  async joinMeeting(
    meetingUrl: string,
    webhookBaseUrl: string,
    opts?: { outputPageUrl?: string; botName?: string },
  ): Promise<string> {
    const botName = opts?.botName ?? 'Osborn'
    const outputPageUrl = opts?.outputPageUrl ?? `${webhookBaseUrl}/meeting-output`
    // Authoritative structure per https://docs.recall.ai/reference/bot_create
    // and https://docs.recall.ai/docs/real-time-transcription:
    //
    //   recording_config.transcript.provider  — transcription provider config
    //   recording_config.realtime_endpoints   — webhook/websocket delivery
    //
    // IMPORTANT:
    //   - Field is `realtime_endpoints` (NOT `real_time_endpoints`)
    //   - `url` and `events` are flat on the endpoint object (NOT nested under `config`)
    //   - `transcription_options` does NOT exist — use `transcript.provider`
    //   - Both transcript.provider AND realtime_endpoints must be set, or no events delivered
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
          transcript: {
            provider: {
              // recallai_streaming is built-in — no external API key needed,
              // low-latency, works across all meeting platforms.
              recallai_streaming: {
                mode: 'prioritize_low_latency',
                language_code: 'en',
              },
            },
          },
          realtime_endpoints: [{
            type: 'webhook',
            url: `${webhookBaseUrl}/webhook/recall`,
            events: ['transcript.data'],
          }],
        },
        output_media: {
          camera: {
            // `kind` (not `type`) — confirmed from prior debugging.
            // The page Recall renders is responsible for joining the same LiveKit
            // room as the osborn agent: meeting audio captured via getUserMedia is
            // published into the room; osborn's TTS audio (already in the room) is
            // played by the page and captured by Recall as the bot's mic output.
            kind: 'webpage',
            config: {
              url: outputPageUrl,
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
    console.log(`🤖 Recall.ai bot joined meeting: ${bot.id} (output page: ${outputPageUrl})`)
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
    // Only process final transcripts (transcript.data), skip partials
    if (payload.event !== 'transcript.data') return

    const words = payload.data?.data?.words ?? []
    const text = words.map(w => w.text).join(' ').trim()
    if (!text) return

    const speaker = payload.data?.data?.participant?.name ?? 'Unknown'
    const botId = payload.data?.bot?.id ?? 'unknown'

    this.emit('transcript', { botId, speaker, text })
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
