// Meeting TTS — one-shot text → audio for the meeting bot.
//
// Two consumers:
//   - synthMp3 (index.ts) → Recall native output_audio, which REQUIRES mp3.
//   - GET /tts (index.ts) → meeting canvas, which decodes the bytes with
//     AudioContext.decodeAudioData (mp3 is fine there too).
// So every provider here returns MP3 and the content-type is always audio/mpeg.
//
// Provider order: Soniox REST (the main pipeline's default TTS) when
// SONIOX_API_KEY is set, then OpenAI only if OPENAI_API_KEY is set, then null.
// An explicit OSBORN_TTS_PROVIDER (soniox | openai) moves that provider to the
// front; the other one stays as a fallback so the meeting never goes silent
// just because the preferred provider is out of credit.

export type MeetingTtsProvider = 'soniox' | 'openai'

export interface MeetingAudio {
  audio: Buffer
  contentType: string
  format: 'mp3'
  provider: MeetingTtsProvider
}

export interface SynthOptions {
  voice?: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
}

export const MEETING_AUDIO_CONTENT_TYPE = 'audio/mpeg'
export const SONIOX_TTS_URL = 'https://tts-rt.soniox.com/tts'
export const OPENAI_TTS_URL = 'https://api.openai.com/v1/audio/speech'
// Fallbacks when the pipeline TTS is not Soniox (mirrors config.ts defaults).
const SONIOX_DEFAULT_MODEL = 'tts-rt-v1'
const SONIOX_DEFAULT_VOICE = 'Victoria'
// Same speed as the pipeline's soniox.TTS (voice-io.ts) so both sound alike.
const SONIOX_SPEED = 0.9
const OPENAI_DEFAULT_MODEL = 'tts-1-hd'
const OPENAI_DEFAULT_VOICE = 'fable'
// Cloudflare in front of tts-rt.soniox.com rejects some default client UAs (error 1010).
const USER_AGENT = 'osborn-agent'

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

async function synthSoniox(text: string, env: NodeJS.ProcessEnv, opts: SynthOptions, f: typeof fetch): Promise<Buffer | null> {
  const { model, voice: defVoice } = sonioxModelVoice(env)
  const voice = opts.voice || defVoice
  const t0 = Date.now()
  try {
    const r = await f(SONIOX_TTS_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.SONIOX_API_KEY}`,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({ model, language: 'en', voice, speed: SONIOX_SPEED, audio_format: 'mp3', text }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20000),
    })
    if (r.ok) {
      const buf = Buffer.from(await r.arrayBuffer())
      if (buf.length > 0) {
        console.log(`🗣️ meeting tts soniox ${model}/${voice} ${buf.length}b in ${Date.now() - t0}ms`)
        return buf
      }
      console.warn('⚠️ meeting tts soniox: empty body')
      return null
    }
    const e = await r.text().catch(() => '')
    console.warn(`⚠️ meeting tts soniox ${r.status}: ${e.slice(0, 160)}`)
  } catch (e) { console.warn(`⚠️ meeting tts soniox: ${(e as Error).message}`) }
  return null
}

async function synthOpenAI(text: string, env: NodeJS.ProcessEnv, opts: SynthOptions, f: typeof fetch): Promise<Buffer | null> {
  const { model, voice: defVoice } = openaiModelVoice(env)
  const voice = opts.voice || defVoice
  const t0 = Date.now()
  try {
    const r = await f(OPENAI_TTS_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, voice, input: text, response_format: 'mp3' }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20000),
    })
    if (r.ok) {
      const buf = Buffer.from(await r.arrayBuffer())
      if (buf.length > 0) {
        console.log(`🗣️ meeting tts openai ${model}/${voice} ${buf.length}b in ${Date.now() - t0}ms`)
        return buf
      }
      console.warn('⚠️ meeting tts openai: empty body')
      return null
    }
    const e = await r.text().catch(() => '')
    console.warn(`⚠️ meeting tts openai ${r.status}: ${e.slice(0, 160)}`)
  } catch (e) { console.warn(`⚠️ meeting tts openai: ${(e as Error).message}`) }
  return null
}

/**
 * Synthesize `text` as MP3 for the meeting. Tries providers in
 * selectMeetingTtsProviders order. Never throws; returns null when no key is
 * configured or every provider failed.
 */
export async function synthMeetingAudio(text: string, opts: SynthOptions = {}): Promise<MeetingAudio | null> {
  const env = opts.env ?? process.env
  const f = opts.fetchImpl ?? fetch
  const input = (text || '').slice(0, 4000)
  if (!input.trim()) return null
  const order = selectMeetingTtsProviders(env)
  if (order.length === 0) {
    console.warn('⚠️ meeting tts: no SONIOX_API_KEY or OPENAI_API_KEY — meeting has no voice')
    return null
  }
  for (const provider of order) {
    const audio = provider === 'soniox'
      ? await synthSoniox(input, env, opts, f)
      : await synthOpenAI(input, env, opts, f)
    if (audio) return { audio, contentType: MEETING_AUDIO_CONTENT_TYPE, format: 'mp3', provider }
  }
  return null
}
