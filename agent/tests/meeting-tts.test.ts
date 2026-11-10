// Meeting TTS unit tests. Run: npx tsx agent/tests/meeting-tts.test.ts
import assert from 'node:assert/strict'
import {
  selectMeetingTtsProviders,
  synthMeetingAudio,
  sniffAudioFormat,
  voiceOverrideTarget,
  MEETING_AUDIO_CONTENT_TYPE,
  SONIOX_TTS_URL,
  OPENAI_TTS_URL,
} from '../src/meeting-tts.js'

// Minimal MP3: ID3 tag header + an MPEG-2 Layer III frame sync (what Soniox returned live).
const MP3_BYTES = Buffer.from([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0, 0xff, 0xf3, 0xc4, 0xc4])
const MP3_SYNC = Buffer.from([0xff, 0xe3, 0x90, 0x00, 1, 2])
const WAV_BYTES = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WAVEfmt ')])

type Call = [string, RequestInit]
function mockFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = []
  const f = (async (url: any, init: any) => { calls.push([String(url), init]); return impl(String(url), init) }) as unknown as typeof fetch
  return { f, calls, body: (i: number) => JSON.parse(calls[i][1].body as string) }
}
const ok = (b: Buffer) => new Response(b, { status: 200, headers: { 'Content-Type': 'audio/mpeg' } })
const err = (status: number, msg = 'nope') => new Response(msg, { status })
const hangUntilAbort = (init: RequestInit) => new Promise<Response>((_, reject) => {
  init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
})

const tests: Array<[string, () => void | Promise<void>]> = []
const it = (n: string, fn: () => void | Promise<void>) => tests.push([n, fn])

// ── selectMeetingTtsProviders ────────────────────────────────────────────────
it('select: no keys → empty', () => assert.deepEqual(selectMeetingTtsProviders({}), []))
it('select: soniox only → soniox', () => assert.deepEqual(selectMeetingTtsProviders({ SONIOX_API_KEY: 's' }), ['soniox']))
it('select: openai only → openai', () => assert.deepEqual(selectMeetingTtsProviders({ OPENAI_API_KEY: 'o' }), ['openai']))
it('select: both keys, no preference → soniox, openai', () =>
  assert.deepEqual(selectMeetingTtsProviders({ SONIOX_API_KEY: 's', OPENAI_API_KEY: 'o' }), ['soniox', 'openai']))
it('select: OSBORN_TTS_PROVIDER=openai → openai first, soniox kept as fallback', () =>
  assert.deepEqual(selectMeetingTtsProviders({ SONIOX_API_KEY: 's', OPENAI_API_KEY: 'o', OSBORN_TTS_PROVIDER: 'openai' }), ['openai', 'soniox']))
it('select: OSBORN_TTS_PROVIDER=soniox → soniox first', () =>
  assert.deepEqual(selectMeetingTtsProviders({ SONIOX_API_KEY: 's', OPENAI_API_KEY: 'o', OSBORN_TTS_PROVIDER: 'soniox' }), ['soniox', 'openai']))
it('select: explicit provider without its key is ignored', () =>
  assert.deepEqual(selectMeetingTtsProviders({ SONIOX_API_KEY: 's', OSBORN_TTS_PROVIDER: 'openai' }), ['soniox']))
it('select: unsupported pipeline provider (deepgram) → default order', () =>
  assert.deepEqual(selectMeetingTtsProviders({ SONIOX_API_KEY: 's', OPENAI_API_KEY: 'o', OSBORN_TTS_PROVIDER: 'deepgram' }), ['soniox', 'openai']))

// ── sniffAudioFormat ─────────────────────────────────────────────────────────
it('sniff: ID3 → mp3', () => assert.equal(sniffAudioFormat(MP3_BYTES), 'mp3'))
it('sniff: 0xFFEx frame sync → mp3', () => assert.equal(sniffAudioFormat(MP3_SYNC), 'mp3'))
it('sniff: 0xFFFx frame sync → mp3', () => assert.equal(sniffAudioFormat(Buffer.from([0xff, 0xfb, 0x90, 0])), 'mp3'))
it('sniff: RIFF → wav', () => assert.equal(sniffAudioFormat(WAV_BYTES), 'wav'))
it('sniff: JSON / short → unknown', () => {
  assert.equal(sniffAudioFormat(Buffer.from('{"error":1}')), 'unknown')
  assert.equal(sniffAudioFormat(Buffer.from([0xff])), 'unknown')
})

// ── synthMeetingAudio ────────────────────────────────────────────────────────
it('synth: no keys → null without throwing and without any network call', async () => {
  const m = mockFetch(() => ok(MP3_BYTES))
  assert.equal(await synthMeetingAudio('hello', { env: {}, fetchImpl: m.f }), null)
  assert.equal(m.calls.length, 0)
})
it('synth: empty text → null, no network', async () => {
  const m = mockFetch(() => ok(MP3_BYTES))
  assert.equal(await synthMeetingAudio('  ', { env: { SONIOX_API_KEY: 's' }, fetchImpl: m.f }), null)
  assert.equal(m.calls.length, 0)
})
it('synth: soniox success → mp3 bytes, audio/mpeg, soniox REST request shape', async () => {
  const m = mockFetch(() => ok(MP3_BYTES))
  const out = await synthMeetingAudio('hello from the meeting', { env: { SONIOX_API_KEY: 'sk', OPENAI_API_KEY: 'ok' }, fetchImpl: m.f })
  assert.ok(out)
  assert.equal(out.provider, 'soniox')
  assert.equal(out.format, 'mp3')
  assert.equal(out.contentType, 'audio/mpeg')
  assert.equal(out.contentType, MEETING_AUDIO_CONTENT_TYPE)
  assert.equal(sniffAudioFormat(out.audio), 'mp3')
  assert.ok(out.audio.equals(MP3_BYTES))
  assert.equal(m.calls.length, 1)
  assert.equal(m.calls[0][0], SONIOX_TTS_URL)
  assert.equal((m.calls[0][1].headers as Record<string, string>)['Authorization'], 'Bearer sk')
  const b = m.body(0)
  assert.equal(b.audio_format, 'mp3')
  assert.equal(b.text, 'hello from the meeting')
  assert.equal(b.model, 'tts-rt-v1')
  assert.equal(b.voice, 'Victoria')
})
it('synth: soniox honors OSBORN_TTS_MODEL/VOICE when the pipeline provider is soniox', async () => {
  const m = mockFetch(() => ok(MP3_BYTES))
  await synthMeetingAudio('hi', { env: { SONIOX_API_KEY: 'sk', OSBORN_TTS_PROVIDER: 'soniox', OSBORN_TTS_MODEL: 'tts-rt-v2', OSBORN_TTS_VOICE: 'Maya' }, fetchImpl: m.f })
  assert.equal(m.body(0).model, 'tts-rt-v2')
  assert.equal(m.body(0).voice, 'Maya')
})
it('synth: soniox 500 → falls back to openai (mp3, audio/mpeg)', async () => {
  const m = mockFetch((url) => url === SONIOX_TTS_URL ? err(500) : ok(MP3_BYTES))
  const out = await synthMeetingAudio('hi', { env: { SONIOX_API_KEY: 'sk', OPENAI_API_KEY: 'ok' }, fetchImpl: m.f })
  assert.equal(out?.provider, 'openai')
  assert.equal(out?.contentType, 'audio/mpeg')
  assert.equal(m.calls.length, 2)
  assert.equal(m.calls[1][0], OPENAI_TTS_URL)
  assert.equal(m.body(1).response_format, 'mp3')
})
it('synth: soniox network error → falls back to openai, never throws', async () => {
  const m = mockFetch((url) => { if (url === SONIOX_TTS_URL) throw new Error('ECONNRESET'); return ok(MP3_BYTES) })
  assert.equal((await synthMeetingAudio('hi', { env: { SONIOX_API_KEY: 'sk', OPENAI_API_KEY: 'ok' }, fetchImpl: m.f }))?.provider, 'openai')
})
it('synth: soniox fails and no OPENAI_API_KEY → null, openai never called', async () => {
  const m = mockFetch(() => err(403, 'error code: 1010'))
  assert.equal(await synthMeetingAudio('hi', { env: { SONIOX_API_KEY: 'sk' }, fetchImpl: m.f }), null)
  assert.equal(m.calls.length, 1)
  assert.equal(m.calls[0][0], SONIOX_TTS_URL)
})
it('synth: all providers fail → null', async () => {
  const m = mockFetch(() => err(429, 'insufficient_quota'))
  assert.equal(await synthMeetingAudio('hi', { env: { SONIOX_API_KEY: 'sk', OPENAI_API_KEY: 'ok' }, fetchImpl: m.f }), null)
  assert.equal(m.calls.length, 2)
})
it('synth: empty 200 body counts as failure', async () => {
  const m = mockFetch((url) => url === SONIOX_TTS_URL ? ok(Buffer.alloc(0)) : ok(MP3_BYTES))
  assert.equal((await synthMeetingAudio('hi', { env: { SONIOX_API_KEY: 'sk', OPENAI_API_KEY: 'ok' }, fetchImpl: m.f }))?.provider, 'openai')
})
it('synth: OSBORN_TTS_PROVIDER=openai tries openai first with OSBORN_TTS_MODEL/VOICE', async () => {
  const m = mockFetch(() => ok(MP3_BYTES))
  const out = await synthMeetingAudio('hi', { env: { SONIOX_API_KEY: 'sk', OPENAI_API_KEY: 'ok', OSBORN_TTS_PROVIDER: 'openai', OSBORN_TTS_MODEL: 'tts-1', OSBORN_TTS_VOICE: 'nova' }, fetchImpl: m.f })
  assert.equal(out?.provider, 'openai')
  assert.equal(m.calls[0][0], OPENAI_TTS_URL)
  assert.equal(m.body(0).model, 'tts-1')
  assert.equal(m.body(0).voice, 'nova')
})

// ── content-type must match the bytes ────────────────────────────────────────
it('synth: soniox returns WAV (RIFF) → rejected, falls back to openai mp3', async () => {
  const m = mockFetch((url) => url === SONIOX_TTS_URL ? ok(WAV_BYTES) : ok(MP3_BYTES))
  const out = await synthMeetingAudio('hi', { env: { SONIOX_API_KEY: 'sk', OPENAI_API_KEY: 'ok' }, fetchImpl: m.f })
  assert.equal(out?.provider, 'openai')
  assert.equal(sniffAudioFormat(out!.audio), 'mp3')
  assert.equal(out?.contentType, 'audio/mpeg')
})
it('synth: only provider returns non-mp3 (JSON) → null', async () => {
  const m = mockFetch(() => ok(Buffer.from('{"error_code":500}')))
  assert.equal(await synthMeetingAudio('hi', { env: { SONIOX_API_KEY: 'sk' }, fetchImpl: m.f }), null)
})

// ── deadline ─────────────────────────────────────────────────────────────────
it('synth: soniox hangs past the total deadline → openai skipped, null, bounded time', async () => {
  const m = mockFetch((url, init) => url === SONIOX_TTS_URL ? hangUntilAbort(init) : ok(MP3_BYTES))
  const t0 = Date.now()
  const out = await synthMeetingAudio('hi', { env: { SONIOX_API_KEY: 'sk', OPENAI_API_KEY: 'ok' }, fetchImpl: m.f, deadlineMs: 150 })
  assert.equal(out, null)
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0}ms`)
  assert.equal(m.calls.length, 1)
})
it('synth: openai hangs → aborted at the remaining deadline', async () => {
  const m = mockFetch((url, init) => url === SONIOX_TTS_URL ? err(500) : hangUntilAbort(init))
  const t0 = Date.now()
  assert.equal(await synthMeetingAudio('hi', { env: { SONIOX_API_KEY: 'sk', OPENAI_API_KEY: 'ok' }, fetchImpl: m.f, deadlineMs: 150 }), null)
  assert.ok(Date.now() - t0 < 1500)
  assert.equal(m.calls.length, 2)
})

// ── ?voice= override targeting ───────────────────────────────────────────────
it('voice target: OpenAI voice names → openai, others → soniox', () => {
  assert.equal(voiceOverrideTarget('fable'), 'openai')
  assert.equal(voiceOverrideTarget('Nova'), 'openai')
  assert.equal(voiceOverrideTarget('Maya'), 'soniox')
})
it('synth: soniox voice override applies to soniox, NOT to the openai fallback', async () => {
  const m = mockFetch((url) => url === SONIOX_TTS_URL ? err(500) : ok(MP3_BYTES))
  await synthMeetingAudio('hi', { env: { SONIOX_API_KEY: 'sk', OPENAI_API_KEY: 'ok' }, fetchImpl: m.f, voice: 'Maya' })
  assert.equal(m.body(0).voice, 'Maya')
  assert.equal(m.body(1).voice, 'fable')
})
it('synth: openai voice override is not sent to soniox, only to openai', async () => {
  const m = mockFetch((url) => url === SONIOX_TTS_URL ? err(500) : ok(MP3_BYTES))
  await synthMeetingAudio('hi', { env: { SONIOX_API_KEY: 'sk', OPENAI_API_KEY: 'ok' }, fetchImpl: m.f, voice: 'nova' })
  assert.equal(m.body(0).voice, 'Victoria')
  assert.equal(m.body(1).voice, 'nova')
})

;(async () => {
  // AbortSignal.timeout timers are unref'd: while a mocked fetch hangs, nothing
  // keeps the event loop alive and node would exit mid-run. Hold it open, and
  // default to failure so an early exit can never look like a pass.
  process.exitCode = 1
  const keepAlive = setInterval(() => {}, 1000)
  // Global watchdog: a hung test must fail the run, not stall it forever.
  setTimeout(() => { console.log('FAIL watchdog: test run exceeded 60s'); process.exit(1) }, 60000).unref()
  const origWarn = console.warn, origLog = console.log
  console.warn = () => {}; console.log = () => {}
  let pass = 0, fail = 0
  for (const [n, fn] of tests) {
    try { await fn(); pass++; origLog(`ok   ${n}`) } catch (e) { fail++; origLog(`FAIL ${n}\n     ${(e as Error).message}`) }
  }
  console.warn = origWarn; console.log = origLog
  console.log(`\n${pass} passed, ${fail} failed`)
  clearInterval(keepAlive)
  process.exit(fail ? 1 : 0)
})()
