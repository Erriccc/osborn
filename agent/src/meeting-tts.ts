// Meeting TTS — one-shot text → audio for the meeting bot.
//
// Two consumers:
//   - synthMp3 (index.ts) → Recall native output_audio, which REQUIRES mp3.
//   - GET /tts (index.ts) → meeting canvas, which decodes the bytes with
//     AudioContext.decodeAudioData (mp3 is fine there too).
// So every provider is asked for MP3, and the returned bytes are sniffed: a
// response that is not actually MP3 counts as a failure (next provider).
//
// Provider order: Soniox REST (the main pipeline's default TTS) when
// SONIOX_API_KEY is set, then OpenAI only if OPENAI_API_KEY is set, then null.
// An explicit OSBORN_TTS_PROVIDER (soniox | openai) moves that provider to the
// front; the other one stays as a fallback so the meeting never goes silent
// just because the preferred provider is out of credit.
//
// Timing: Soniox gets at most SONIOX_TIMEOUT_MS, and the whole chain shares a
// TOTAL_DEADLINE_MS budget — the canvas aborts its /tts fetch at 12s.

export type MeetingTtsProvider = 'soniox' | 'openai'
export type SniffedAudioFormat = 'mp3' | 'wav' | 'unknown'

export interface MeetingAudio {
  audio: Buffer
  contentType: string
  format: 'mp3'
  provider: MeetingTtsProvider
}

export interface SynthOptions {
  /** Voice override. Applied ONLY to the provider whose voice set it belongs to
   *  (an OpenAI voice name → openai, anything else → soniox); never to the other. */
  voice?: string
  /** Total budget across all providers (default TOTAL_DEADLINE_MS). */
  deadlineMs?: number
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
}

export const MEETING_AUDIO_CONTENT_TYPE = 'audio/mpeg'
export const SONIOX_TTS_URL = 'https://tts-rt.soniox.com/tts'
export const OPENAI_TTS_URL = 'https://api.openai.com/v1/audio/speech'
export const SONIOX_TIMEOUT_MS = 8000
export const TOTAL_DEADLINE_MS = 11000
// Fallbacks when the pipeline TTS is not Soniox (mirrors config.ts defaults).
const SONIOX_DEFAULT_MODEL = 'tts-rt-v1'
const SONIOX_DEFAULT_VOICE = 'Victoria'
// Same speed as the pipeline's soniox.TTS (voice-io.ts) so both sound alike.
const SONIOX_SPEED = 0.9
const OPENAI_DEFAULT_MODEL = 'tts-1-hd'
const OPENAI_DEFAULT_VOICE = 'fable'
const OPENAI_VOICES = new Set(['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer', 'verse'])
// Cloudflare in front of tts-rt.soniox.com rejects some default client UAs (error 1010).
const USER_AGENT = 'osborn-agent'

/** Identify audio by magic bytes: ID3 tag or an MPEG frame sync → mp3, RIFF → wav. */
export function sniffAudioFormat(buf: Buffer): SniffedAudioFormat {
  if (!buf || buf.length < 4) return 'unknown'
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return 'mp3' // "ID3"
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3' // frame sync 0xFFE?/0xFFF?
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF') return 'wav'
  return 'unknown'
}

/** Ordered list of providers to try, given the env. Empty → no voice. */
export function selectMeetingTtsProviders(env: NodeJS.ProcessEnv = process.env): MeetingTtsProvider[] {
  const available: MeetingTtsProvider[] = []
  if (env.SONIOX_API_KEY) available.push('soniox')
  if (env.OPENAI_API_KEY) available.push('openai')
  const preferred = env.OSBORN_TTS_PROVIDER as MeetingTtsProvider | undefined
  if (preferred && available.includes(preferred)) {
    return [preferred, ...available.filter((p) => p !== preferred)]
  }
  return available
}

/** Which provider a `?voice=` override is meant for. */
export function voiceOverrideTarget(voice: string): MeetingTtsProvider {
  return OPENAI_VOICES.has(voice.trim().toLowerCase()) ? 'openai' : 'soniox'
}

function sonioxModelVoice(env: NodeJS.ProcessEnv): { model: string; voice: string } {
  // When the pipeline TTS is Soniox (the default), use the same OSBORN_TTS_*
  // overrides getDirectConfig uses, so the bot sounds identical in both places.
  if (!env.OSBORN_TTS_PROVIDER || env.OSBORN_TTS_PROVIDER === 'soniox') {
    return { model: env.OSBORN_TTS_MODEL || SONIOX_DEFAULT_MODEL, voice: env.OSBORN_TTS_VOICE || SONIOX_DEFAULT_VOICE }
  }
  return { model: SONIOX_DEFAULT_MODEL, voice: SONIOX_DEFAULT_VOICE }
}

function openaiModelVoice(env: NodeJS.ProcessEnv): { model: string; voice: string } {
  if (env.OSBORN_TTS_PROVIDER === 'openai') {
    return { model: env.OSBORN_TTS_MODEL || OPENAI_DEFAULT_MODEL, voice: env.OSBORN_TTS_VOICE || OPENAI_DEFAULT_VOICE }
  }
  return { model: OPENAI_DEFAULT_MODEL, voice: OPENAI_DEFAULT_VOICE }
}

interface ProviderRequest {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
  label: string
}

function buildRequest(provider: MeetingTtsProvider, text: string, env: NodeJS.ProcessEnv, voiceOverride?: string): ProviderRequest {
  if (provider === 'soniox') {
    const { model, voice: def } = sonioxModelVoice(env)
    const voice = voiceOverride || def
    return {
      url: SONIOX_TTS_URL,
      headers: { 'Authorization': `Bearer ${env.SONIOX_API_KEY}`, 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      body: { model, language: 'en', voice, speed: SONIOX_SPEED, audio_format: 'mp3', text },
      label: `soniox ${model}/${voice}`,
    }
  }
  const { model, voice: def } = openaiModelVoice(env)
  const voice = voiceOverride || def
  return {
    url: OPENAI_TTS_URL,
    headers: { 'Authorization': `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: { model, voice, input: text, response_format: 'mp3' },
    label: `openai ${model}/${voice}`,
  }
}

async function tryProvider(req: ProviderRequest, timeoutMs: number, f: typeof fetch): Promise<Buffer | null> {
  const t0 = Date.now()
  try {
    const r = await f(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!r.ok) {
      const e = await r.text().catch(() => '')
      console.warn(`⚠️ meeting tts ${req.label} ${r.status}: ${e.slice(0, 160)}`)
      return null
    }
    const buf = Buffer.from(await r.arrayBuffer())
    if (buf.length === 0) { console.warn(`⚠️ meeting tts ${req.label}: empty body`); return null }
    const fmt = sniffAudioFormat(buf)
    if (fmt !== 'mp3') {
      // Recall output_audio only accepts mp3 — a mislabelled body is a failure.
      console.warn(`⚠️ meeting tts ${req.label}: expected mp3, got ${fmt} (${buf.length}b)`)
      return null
    }
    console.log(`🗣️ meeting tts ${req.label} ${buf.length}b in ${Date.now() - t0}ms`)
    return buf
  } catch (e) {
    console.warn(`⚠️ meeting tts ${req.label}: ${(e as Error).message}`)
    return null
  }
}

/**
 * Synthesize `text` as MP3 for the meeting. Tries providers in
 * selectMeetingTtsProviders order within a shared deadline. Never throws;
 * returns null when no key is configured, every provider failed, or the
 * deadline ran out.
 */
export async function synthMeetingAudio(text: string, opts: SynthOptions = {}): Promise<MeetingAudio | null> {
  const env = opts.env ?? process.env
  const f = opts.fetchImpl ?? fetch
  const input = (typeof text === 'string' ? text : '').slice(0, 4000)
  if (!input.trim()) return null
  const order = selectMeetingTtsProviders(env)
  if (order.length === 0) {
    console.warn('⚠️ meeting tts: no SONIOX_API_KEY or OPENAI_API_KEY — meeting has no voice')
    return null
  }
  const voiceTarget = opts.voice ? voiceOverrideTarget(opts.voice) : null
  const deadline = Date.now() + (opts.deadlineMs ?? TOTAL_DEADLINE_MS)
  for (const provider of order) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) { console.warn(`⚠️ meeting tts: deadline reached before ${provider}`); break }
    const timeoutMs = provider === 'soniox' ? Math.min(SONIOX_TIMEOUT_MS, remaining) : remaining
    const req = buildRequest(provider, input, env, voiceTarget === provider ? opts.voice : undefined)
    const audio = await tryProvider(req, timeoutMs, f)
    if (audio) return { audio, contentType: MEETING_AUDIO_CONTENT_TYPE, format: 'mp3', provider }
  }
  return null
}
