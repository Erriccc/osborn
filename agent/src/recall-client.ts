import { EventEmitter } from 'node:events'

const RECALL_REGION = process.env.RECALL_REGION ?? 'us-west-2'
const RECALL_BASE_URL = `https://${RECALL_REGION}.recall.ai/api/v1`

export interface RecallBot {
  id: string
  meeting_url: string
  status: string
}

/**
 * One transcript turn = one speaker's continuous utterance.
 * Shape returned by GET /api/v1/bot/{bot_id}/transcript.
 *
 * Per Recall docs each turn contains:
 *   - speaker: participant name (or 'Unknown')
 *   - words: array of { text, start_timestamp.relative, end_timestamp.relative }
 *   - The `start_timestamp.relative` (seconds since recording start) on the
 *     FIRST word is the turn's start; we use this as the dedup cursor.
 */
export interface TranscriptTurn {
  speaker?: string
  participant?: { id?: number; name?: string; is_host?: boolean }
  words: Array<{
    text: string
    start_timestamp?: { relative?: number; absolute?: string }
    end_timestamp?: { relative?: number; absolute?: string }
  }>
  language?: string
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
    _webhookBaseUrl: string,
    opts?: { botName?: string },
  ): Promise<string> {
    const botName = opts?.botName ?? 'Osborn'
    // ARCHITECTURE (post-2026-05-22 polling redesign):
    //   The bot joins by name only — visible in the meeting participant list as
    //   "Osborn" but with no audio output and no avatar. We do NOT configure any
    //   `output_media`, `audio_separate_raw`, or `realtime_endpoints` — instead
    //   the agent polls Recall's REST transcript API every ~30s
    //   (see MeetingTranscriptPoller) and feeds new turns into the LLM as
    //   `[MEETING — <botId>]:` tagged messages. The meetings skill teaches the
    //   LLM not to respond out loud to those messages, only to take notes.
    //
    //   We DO keep `recording_config.transcript.provider.recallai_streaming` so
    //   Recall actually transcribes the meeting — the REST endpoint we poll
    //   requires this to be configured, otherwise transcripts are empty.
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
              recallai_streaming: {
                mode: 'prioritize_low_latency',
                language_code: 'en',
              },
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
    console.log(`🤖 Recall.ai bot joined meeting: ${bot.id} (polling-only, no audio pipeline)`)
    return bot.id
  }

  /**
   * Fetch the bot's current transcript. Returns an array of "transcript turns"
   * (each turn = one speaker's utterance) sorted by start time.
   *
   * Verified 2026-05-22 against the real us-west-2 API: there is NO simple
   * `GET /bot/{id}/transcript` convenience endpoint. The actual chain is:
   *
   *   1. GET /api/v1/bot/{bot_id}
   *   2. recordings[0].media_shortcuts.transcript.data.download_url   (S3 signed URL)
   *   3. GET that URL  →  JSON array of TranscriptTurn objects
   *
   * The S3 URL is pre-signed and expires (~6h). Re-fetch step 1 each poll;
   * don't cache the URL.
   *
   * If `recordings[0]` doesn't exist yet (bot still joining or pre-recording),
   * returns []. Caller (MeetingTranscriptPoller) treats that as "no new turns
   * yet" and waits for the next tick.
   */
  async getTranscript(botId: string): Promise<TranscriptTurn[]> {
    const botRes = await fetch(`${RECALL_BASE_URL}/bot/${botId}`, {
      headers: { 'Authorization': `Token ${this.#apiKey}` },
    })
    if (!botRes.ok) {
      const err = await botRes.text().catch(() => '')
      throw new Error(`Recall.ai bot fetch failed: ${botRes.status} ${err.substring(0, 200)}`)
    }
    const bot = await botRes.json() as {
      recordings?: Array<{
        media_shortcuts?: {
          transcript?: { data?: { download_url?: string } }
        }
      }>
    }
    const downloadUrl = bot.recordings?.[0]?.media_shortcuts?.transcript?.data?.download_url
    if (!downloadUrl) {
      // Recording / transcript not ready yet — pre-call, just-joined, or
      // recording_done event hasn't fired. Empty result is expected here.
      return []
    }
    const txRes = await fetch(downloadUrl)
    if (!txRes.ok) {
      const err = await txRes.text().catch(() => '')
      throw new Error(`Recall.ai transcript download failed: ${txRes.status} ${err.substring(0, 200)}`)
    }
    const turns = await txRes.json() as TranscriptTurn[]
    return Array.isArray(turns) ? turns : []
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
