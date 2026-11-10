// Adversarial meeting-TTS tests. Run: npx tsx agent/tests/meeting-tts-adversarial.test.ts
import assert from 'node:assert/strict'
import { synthMeetingAudio, selectMeetingTtsProviders } from '../src/meeting-tts.js'

const MP3_ID3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x00])
const MP3_SYNC = Buffer.from([0xff, 0xfb, 0x90, 0x00, 1, 2, 3])
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WAVEfmt ')])

let pass = 0, fail = 0
const tests: Array<[string, () => Promise<void>]> = []
const it = (n: string, f: () => Promise<void>) => tests.push([n, f])

type Call = { url: string; body: any }
function mkFetch(handlers: { soniox?: () => Response | Promise<Response>; openai?: () => Response | Promise<Response> }) {
  const calls: Call[] = []
  const f = (async (url: any, init: any) => {
    const u = String(url)
    calls.push({ url: u, body: init?.body ? JSON.parse(init.body) : null })
    if (u.includes('soniox')) { if (!handlers.soniox) throw new Error('unexpected soniox'); return handlers.soniox() }
    if (u.includes('openai')) { if (!handlers.openai) throw new Error('unexpected openai'); return handlers.openai() }
    throw new Error('unknown url ' + u)
  }) as unknown as typeof fetch
  return { f, calls }
}
const ok = (b: Buffer) => new Response(b, { status: 200 })
const BOTH = { SONIOX_API_KEY: 's', OPENAI_API_KEY: 'o' } as NodeJS.ProcessEnv
const SONLY = { SONIOX_API_KEY: 's' } as NodeJS.ProcessEnv

it('soniox network error + openai present -> falls back to openai', async () => {
  const { f, calls } = mkFetch({ soniox: () => { throw new TypeError('fetch failed') }, openai: () => ok(MP3_ID3) })
  const r = await synthMeetingAudio('hi', { env: BOTH, fetchImpl: f })
  assert.equal(r?.provider, 'openai')
  assert.equal(calls.length, 2)
  assert.ok(calls[0].url.includes('soniox'))
})
it('soniox 500 + openai present -> falls back', async () => {
  const { f } = mkFetch({ soniox: () => new Response('err', { status: 500 }), openai: () => ok(MP3_SYNC) })
  assert.equal((await synthMeetingAudio('hi', { env: BOTH, fetchImpl: f }))?.provider, 'openai')
})
it('soniox 401 + openai present -> falls back', async () => {
  const { f } = mkFetch({ soniox: () => new Response('no', { status: 401 }), openai: () => ok(MP3_SYNC) })
  assert.equal((await synthMeetingAudio('hi', { env: BOTH, fetchImpl: f }))?.provider, 'openai')
})
it('soniox 200 empty body + openai present -> falls back', async () => {
  const { f } = mkFetch({ soniox: () => ok(Buffer.alloc(0)), openai: () => ok(MP3_SYNC) })
  assert.equal((await synthMeetingAudio('hi', { env: BOTH, fetchImpl: f }))?.provider, 'openai')
})
it('soniox success never calls openai', async () => {
  const { f, calls } = mkFetch({ soniox: () => ok(MP3_ID3) })
  const r = await synthMeetingAudio('hi', { env: BOTH, fetchImpl: f })
  assert.equal(r?.provider, 'soniox'); assert.equal(calls.length, 1)
})
it('soniox network error, no openai key -> null, no throw, openai never called', async () => {
  const { f, calls } = mkFetch({ soniox: () => { throw new Error('ECONNRESET') } })
  assert.equal(await synthMeetingAudio('hi', { env: SONLY, fetchImpl: f }), null)
  assert.equal(calls.length, 1)
})
it('soniox 503, no openai key -> null', async () => {
  const { f } = mkFetch({ soniox: () => new Response('x', { status: 503 }) })
  assert.equal(await synthMeetingAudio('hi', { env: SONLY, fetchImpl: f }), null)
})
it('both fail -> null, no throw', async () => {
  const { f } = mkFetch({ soniox: () => { throw new Error('a') }, openai: () => { throw new Error('b') } })
  assert.equal(await synthMeetingAudio('hi', { env: BOTH, fetchImpl: f }), null)
})
it('no keys -> null, fetch never called', async () => {
  const { f, calls } = mkFetch({})
  assert.equal(await synthMeetingAudio('hi', { env: {}, fetchImpl: f }), null)
  assert.equal(calls.length, 0)
})
it('OPENAI key only: soniox never contacted', async () => {
  const { f, calls } = mkFetch({ openai: () => ok(MP3_ID3) })
  const r = await synthMeetingAudio('hi', { env: { OPENAI_API_KEY: 'o' }, fetchImpl: f })
  assert.equal(r?.provider, 'openai'); assert.ok(calls.every(c => !c.url.includes('soniox')))
})
it('explicit OSBORN_TTS_PROVIDER=openai honored (openai first)', async () => {
  const { f, calls } = mkFetch({ soniox: () => ok(MP3_ID3), openai: () => ok(MP3_ID3) })
  const r = await synthMeetingAudio('hi', { env: { ...BOTH, OSBORN_TTS_PROVIDER: 'openai' }, fetchImpl: f })
  assert.equal(r?.provider, 'openai'); assert.ok(calls[0].url.includes('openai'))
})
it('unknown OSBORN_TTS_PROVIDER value does not throw / does not drop providers', async () => {
  const order = selectMeetingTtsProviders({ ...BOTH, OSBORN_TTS_PROVIDER: 'bogus' } as any)
  assert.deepEqual(order, ['soniox', 'openai'])
})
it('empty text -> null without network', async () => {
  const { f, calls } = mkFetch({ soniox: () => ok(MP3_ID3) })
  assert.equal(await synthMeetingAudio('', { env: BOTH, fetchImpl: f }), null)
  assert.equal(calls.length, 0)
})
it('whitespace-only text -> null without network', async () => {
  const { f, calls } = mkFetch({ soniox: () => ok(MP3_ID3) })
  assert.equal(await synthMeetingAudio('  \n\t ', { env: BOTH, fetchImpl: f }), null)
  assert.equal(calls.length, 0)
})
it('null/undefined text does not throw', async () => {
  const { f } = mkFetch({ soniox: () => ok(MP3_ID3) })
  assert.equal(await synthMeetingAudio(undefined as any, { env: BOTH, fetchImpl: f }), null)
  assert.equal(await synthMeetingAudio(null as any, { env: BOTH, fetchImpl: f }), null)
})
it('very long text (100k) is truncated to <=4000 and succeeds', async () => {
  const { f, calls } = mkFetch({ soniox: () => ok(MP3_ID3) })
  const r = await synthMeetingAudio('a'.repeat(100_000), { env: BOTH, fetchImpl: f })
  assert.ok(r); assert.ok(calls[0].body.text.length <= 4000)
})
it('very long text, openai fallback also truncated', async () => {
  const { f, calls } = mkFetch({ soniox: () => new Response('x', { status: 500 }), openai: () => ok(MP3_ID3) })
  await synthMeetingAudio('b'.repeat(50_000), { env: BOTH, fetchImpl: f })
  assert.ok(calls[1].body.input.length <= 4000)
})
it('unicode/emoji text passes through intact', async () => {
  const { f, calls } = mkFetch({ soniox: () => ok(MP3_ID3) })
  await synthMeetingAudio('héllo 🎙️ 世界', { env: BOTH, fetchImpl: f })
  assert.equal(calls[0].body.text, 'héllo 🎙️ 世界')
})
it('requests mp3 from both providers (content-type contract)', async () => {
  const a = mkFetch({ soniox: () => ok(MP3_ID3) })
  await synthMeetingAudio('hi', { env: BOTH, fetchImpl: a.f })
  assert.equal(a.calls[0].body.audio_format, 'mp3')
  const b = mkFetch({ openai: () => ok(MP3_ID3) })
  await synthMeetingAudio('hi', { env: { OPENAI_API_KEY: 'o' }, fetchImpl: b.f })
  assert.equal(b.calls[0].body.response_format, 'mp3')
})
it('content-type audio/mpeg agrees with MP3 magic (ID3 or 0xFFFB)', async () => {
  for (const bytes of [MP3_ID3, MP3_SYNC]) {
    const { f } = mkFetch({ soniox: () => ok(bytes) })
    const r = await synthMeetingAudio('hi', { env: BOTH, fetchImpl: f })
    assert.equal(r?.contentType, 'audio/mpeg')
    const b = r!.audio
    const isMp3 = b.subarray(0, 3).toString('latin1') === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)
    assert.ok(isMp3)
  }
})
it('MISMATCH GUARD: provider returns WAV (RIFF) -> must not be labelled audio/mpeg', async () => {
  const { f } = mkFetch({ soniox: () => ok(WAV) })
  const r = await synthMeetingAudio('hi', { env: SONLY, fetchImpl: f })
  if (r === null) return // rejecting is acceptable
  const isRiff = r.audio.subarray(0, 4).toString('latin1') === 'RIFF'
  if (isRiff) assert.ok(/wav/.test(r.contentType), `RIFF bytes labelled ${r.contentType}`)
})

;(async () => {
  const origWarn = console.warn, origLog = console.log
  console.warn = () => {}; console.log = () => {}
  for (const [n, fn] of tests) {
    try { await fn(); pass++; origLog(`ok   ${n}`) } catch (e) { fail++; origLog(`FAIL ${n}\n     ${(e as Error).message}`) }
  }
  console.warn = origWarn
  origLog(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})()
