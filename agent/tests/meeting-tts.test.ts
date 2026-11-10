import { describe, it, expect, vi } from 'vitest'
import {
  selectMeetingTtsProviders,
  synthMeetingAudio,
  MEETING_AUDIO_CONTENT_TYPE,
  SONIOX_TTS_URL,
  OPENAI_TTS_URL,
} from '../src/meeting-tts.js'

// Minimal MP3: ID3 tag header + an MPEG-2 Layer III frame sync (what Soniox returned live).
const MP3_BYTES = Buffer.from([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0, 0xff, 0xf3, 0xc4, 0xc4])

function okResponse(body: Buffer, contentType = 'audio/mpeg') {
  return new Response(body, { status: 200, headers: { 'Content-Type': contentType } })
}
function errResponse(status: number, msg = 'nope') {
  return new Response(msg, { status })
}

describe('selectMeetingTtsProviders', () => {
  it('no keys → empty', () => {
    expect(selectMeetingTtsProviders({})).toEqual([])
  })
  it('soniox only → soniox', () => {
    expect(selectMeetingTtsProviders({ SONIOX_API_KEY: 's' })).toEqual(['soniox'])
  })
  it('openai only → openai', () => {
    expect(selectMeetingTtsProviders({ OPENAI_API_KEY: 'o' })).toEqual(['openai'])
  })
  it('both keys, no preference → soniox first, openai fallback', () => {
    expect(selectMeetingTtsProviders({ SONIOX_API_KEY: 's', OPENAI_API_KEY: 'o' })).toEqual(['soniox', 'openai'])
  })
  it('explicit OSBORN_TTS_PROVIDER=openai → openai first, soniox kept as fallback', () => {
    expect(selectMeetingTtsProviders({ SONIOX_API_KEY: 's', OPENAI_API_KEY: 'o', OSBORN_TTS_PROVIDER: 'openai' })).toEqual(['openai', 'soniox'])
  })
  it('explicit OSBORN_TTS_PROVIDER=soniox → soniox first', () => {
    expect(selectMeetingTtsProviders({ SONIOX_API_KEY: 's', OPENAI_API_KEY: 'o', OSBORN_TTS_PROVIDER: 'soniox' })).toEqual(['soniox', 'openai'])
  })
  it('explicit provider without its key is ignored', () => {
    expect(selectMeetingTtsProviders({ SONIOX_API_KEY: 's', OSBORN_TTS_PROVIDER: 'openai' })).toEqual(['soniox'])
  })
  it('unsupported pipeline provider (deepgram) → default order', () => {
    expect(selectMeetingTtsProviders({ SONIOX_API_KEY: 's', OPENAI_API_KEY: 'o', OSBORN_TTS_PROVIDER: 'deepgram' })).toEqual(['soniox', 'openai'])
  })
})

describe('synthMeetingAudio', () => {
  it('no keys → null without throwing and without any network call', async () => {
    const fetchImpl = vi.fn()
    await expect(synthMeetingAudio('hello', { env: {}, fetchImpl: fetchImpl as any })).resolves.toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('empty text → null', async () => {
    const fetchImpl = vi.fn()
    expect(await synthMeetingAudio('  ', { env: { SONIOX_API_KEY: 's' }, fetchImpl: fetchImpl as any })).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('soniox success → mp3 bytes, audio/mpeg, soniox REST request shape', async () => {
    const fetchImpl = vi.fn(async () => okResponse(MP3_BYTES))
    const out = await synthMeetingAudio('hello from the meeting', { env: { SONIOX_API_KEY: 'sk', OPENAI_API_KEY: 'ok' }, fetchImpl: fetchImpl as any })
    expect(out).not.toBeNull()
    expect(out!.provider).toBe('soniox')
    expect(out!.format).toBe('mp3')
    expect(out!.contentType).toBe('audio/mpeg')
    expect(out!.contentType).toBe(MEETING_AUDIO_CONTENT_TYPE)
    expect(out!.audio.equals(MP3_BYTES)).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(SONIOX_TTS_URL)
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer sk')
    const body = JSON.parse(init.body as string)
    expect(body.audio_format).toBe('mp3')
    expect(body.text).toBe('hello from the meeting')
    expect(body.model).toBe('tts-rt-v1')
    expect(body.voice).toBe('Victoria')
  })

  it('soniox honors OSBORN_TTS_MODEL/VOICE when the pipeline provider is soniox', async () => {
    const fetchImpl = vi.fn(async () => okResponse(MP3_BYTES))
    await synthMeetingAudio('hi', { env: { SONIOX_API_KEY: 'sk', OSBORN_TTS_PROVIDER: 'soniox', OSBORN_TTS_MODEL: 'tts-rt-v2', OSBORN_TTS_VOICE: 'Maya' }, fetchImpl: fetchImpl as any })
    const body = JSON.parse((fetchImpl.mock.calls[0] as any)[1].body)
    expect(body.model).toBe('tts-rt-v2')
    expect(body.voice).toBe('Maya')
  })

  it('soniox fails → falls back to openai (mp3, audio/mpeg)', async () => {
    const fetchImpl = vi.fn(async (url: string) => url === SONIOX_TTS_URL ? errResponse(500) : okResponse(MP3_BYTES))
    const out = await synthMeetingAudio('hi', { env: { SONIOX_API_KEY: 'sk', OPENAI_API_KEY: 'ok' }, fetchImpl: fetchImpl as any })
    expect(out!.provider).toBe('openai')
    expect(out!.contentType).toBe('audio/mpeg')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const [url2, init2] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit]
    expect(url2).toBe(OPENAI_TTS_URL)
    expect(JSON.parse(init2.body as string).response_format).toBe('mp3')
  })

  it('soniox throws (network) → falls back to openai, never throws', async () => {
    const fetchImpl = vi.fn(async (url: string) => { if (url === SONIOX_TTS_URL) throw new Error('ECONNRESET'); return okResponse(MP3_BYTES) })
    const out = await synthMeetingAudio('hi', { env: { SONIOX_API_KEY: 'sk', OPENAI_API_KEY: 'ok' }, fetchImpl: fetchImpl as any })
    expect(out!.provider).toBe('openai')
  })

  it('soniox fails and no OPENAI_API_KEY → null, openai never called', async () => {
    const fetchImpl = vi.fn(async () => errResponse(403, 'error code: 1010'))
    const out = await synthMeetingAudio('hi', { env: { SONIOX_API_KEY: 'sk' }, fetchImpl: fetchImpl as any })
    expect(out).toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect((fetchImpl.mock.calls[0] as any)[0]).toBe(SONIOX_TTS_URL)
  })

  it('all providers fail → null', async () => {
    const fetchImpl = vi.fn(async () => errResponse(429, 'insufficient_quota'))
    expect(await synthMeetingAudio('hi', { env: { SONIOX_API_KEY: 'sk', OPENAI_API_KEY: 'ok' }, fetchImpl: fetchImpl as any })).toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('empty 200 body counts as failure', async () => {
    const fetchImpl = vi.fn(async (url: string) => url === SONIOX_TTS_URL ? okResponse(Buffer.alloc(0)) : okResponse(MP3_BYTES))
    const out = await synthMeetingAudio('hi', { env: { SONIOX_API_KEY: 'sk', OPENAI_API_KEY: 'ok' }, fetchImpl: fetchImpl as any })
    expect(out!.provider).toBe('openai')
  })

  it('explicit OSBORN_TTS_PROVIDER=openai tries openai first with OSBORN_TTS_MODEL/VOICE', async () => {
    const fetchImpl = vi.fn(async () => okResponse(MP3_BYTES))
    const out = await synthMeetingAudio('hi', { env: { SONIOX_API_KEY: 'sk', OPENAI_API_KEY: 'ok', OSBORN_TTS_PROVIDER: 'openai', OSBORN_TTS_MODEL: 'tts-1', OSBORN_TTS_VOICE: 'nova' }, fetchImpl: fetchImpl as any })
    expect(out!.provider).toBe('openai')
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(OPENAI_TTS_URL)
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe('tts-1')
    expect(body.voice).toBe('nova')
  })
})
