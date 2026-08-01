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
    webhookBaseUrl: string,
    opts?: { botName?: string; castUrl?: string },
  ): Promise<string> {
    const botName = opts?.botName ?? 'Osborn'
    // 0.9.85: optional CAST — display a webpage as the bot's camera in the
    // meeting (Recall output_media, the piece the v0.9.44 rewrite removed).
    // Point castUrl at the session-engine live-feed viewer, a seeded site
    // (e.g. voice-native's LinkedIn), or a research/output page. This is the
    // "the client sees content" visual side of the copilot. Left off by
    // default (silent, invisible observer) — only casts when castUrl is set.
    const cast = opts?.castUrl && /^https?:\/\//.test(opts.castUrl)
      ? { output_media: { camera: { kind: 'webpage', config: { url: opts.castUrl } } } }
      : {}
    if (opts?.castUrl && !Object.keys(cast).length) console.log(`⚠️ castUrl ignored (not http(s)): ${opts.castUrl}`)
    else if (Object.keys(cast).length) console.log(`📺 Meeting cast enabled — bot camera = ${opts!.castUrl}`)
    // 0.9.84: LIVE transcript via realtime_endpoints. The v0.9.44 rewrite
    // removed this and left only 30s polling of the batch download_url — but
    // that URL is a POST-PROCESSING artifact (empty until the meeting ends),
    // so mid-call there was nothing to fetch (confirmed live 2026-07-29:
    // transcript stayed `processing` during the call, downloaded only after
    // the bot left). Registering a realtime webhook makes Recall stream each
    // transcript turn to /webhook/recall as it's spoken — the receiver
    // (handleWebhook) already exists. Polling stays as the after-the-fact
    // backstop. Only wire the webhook when we have a public URL to receive on.
    // Subscribe to transcript (content) AND participant speech VAD events. The
    // speech_on/speech_off events fire from raw audio (faster than transcription)
    // and tell us WHO is speaking WHEN — used for interruption (human speaks while
    // the bot is talking → stop) and for chunking on natural silence boundaries.
    const realtime = /^https:\/\//.test(webhookBaseUrl)
      ? [{ type: 'webhook', url: `${webhookBaseUrl}/webhook/recall`, events: ['transcript.data', 'transcript.partial_data', 'participant_events.speech_on', 'participant_events.speech_off'] }]
      : []
    if (!realtime.length) console.log('⚠️ Recall realtime webhook skipped (no public https URL) — polling only')
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
        ...cast,
        recording_config: {
          transcript: {
            provider: {
              recallai_streaming: {
                mode: 'prioritize_low_latency',
                language_code: 'en',
              },
            },
          },
          ...(realtime.length ? { realtime_endpoints: realtime } : {}),
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

  /**
   * Speak DIRECTLY through the bot via Recall's native output_audio (mp3).
   * No canvas page, no Web Audio, no capture chain — Recall plays the file as
   * the bot's voice. Returns true on 2xx. (2026-08-01: canvas-audio quality
   * was "barely bearable"; this is the direct loud path.)
   */
  async outputAudio(botId: string, mp3: Buffer): Promise<boolean> {
    const res = await fetch(`${RECALL_BASE_URL}/bot/${botId}/output_audio/`, {
      method: 'POST',
      headers: { 'Authorization': `Token ${this.#apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'mp3', b64_data: mp3.toString('base64') }),
    })
    if (!res.ok) {
      const e = await res.text().catch(() => '')
      console.warn(`⚠️ Recall output_audio ${res.status}: ${e.slice(0, 160)}`)
      return false
    }
    return true
  }

  async getBotStatus(botId: string): Promise<string> {
    const res = await fetch(`${RECALL_BASE_URL}/bot/${botId}`, {
      headers: { 'Authorization': `Token ${this.#apiKey}` },
    })
    const bot = (await res.json()) as any
    return bot.status_changes?.at(-1)?.code ?? 'unknown'
  }

  // 0.9.86: track the last text we emitted per speaker so partials don't
  // spam the LLM with every incremental word — only emit when the utterance
  // grows meaningfully or finalizes.
  #lastEmitted = new Map<string, string>()

  handleWebhook(payload: TranscriptPayload): void {
    // Participant speech VAD (speech_on/speech_off) — fires from raw audio, ahead
    // of transcription. Emit a 'speech' event so index.ts can (a) interrupt the
    // bot when a HUMAN starts talking over it, and (b) chunk the transcript on
    // natural silence boundaries. The bot's own output_media audio may also fire
    // speech_on for its own participant — index.ts filters that by name.
    if (payload.event === 'participant_events.speech_on' || payload.event === 'participant_events.speech_off') {
      const p = (payload as unknown as { data?: { data?: { participant?: { name?: string, is_host?: boolean } }, bot?: { id?: string } } }).data
      this.emit('speech', {
        botId: p?.bot?.id ?? 'unknown',
        participant: p?.data?.participant?.name ?? 'Unknown',
        isHost: !!p?.data?.participant?.is_host,
        active: payload.event === 'participant_events.speech_on',
      })
      return
    }
    // Accept BOTH finals (transcript.data) AND partials (transcript.partial_data).
    // recallai_streaming in prioritize_low_latency mode emits partials DURING
    // the call and finals lag — ignoring partials (the old behavior) meant no
    // live transcript at all (confirmed 2026-07-29: 0 webhook-processed turns
    // mid-call). We emit partials for liveness, deduped against the last text.
    const isFinal = payload.event === 'transcript.data'
    const isPartial = payload.event === 'transcript.partial_data'
    if (!isFinal && !isPartial) return

    const words = payload.data?.data?.words ?? []
    const text = words.map(w => w.text).join(' ').trim()
    if (!text) return

    const speaker = payload.data?.data?.participant?.name ?? 'Unknown'
    const botId = payload.data?.bot?.id ?? 'unknown'
    const key = `${botId}:${speaker}`

    // Dedup: skip a partial that just repeats/prefixes what we already sent.
    const prev = this.#lastEmitted.get(key) ?? ''
    if (!isFinal && (text === prev || (prev && text.startsWith(prev) && text.length - prev.length < 8))) return
    this.#lastEmitted.set(key, text)
    if (isFinal) this.#lastEmitted.delete(key) // reset for the next utterance

    this.emit('transcript', { botId, speaker, text, partial: !isFinal })
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
