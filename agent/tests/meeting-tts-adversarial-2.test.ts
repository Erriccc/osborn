import assert from 'node:assert/strict'
import { synthMeetingAudio, sniffAudioFormat } from '../src/meeting-tts.js'

const MP3 = Buffer.from([0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4])
const ID3 = Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0, 0, 0, 0, 0])])
const ok = (b: Buffer) => new Response(b, { status: 200 })
const env = { SONIOX_API_KEY: 'sx', OPENAI_API_KEY: 'oa' } as NodeJS.ProcessEnv
const keepalive = setInterval(() => {}, 1000) // AbortSignal.timeout timers are unref'd; mocks hold no socket
let pass = 0, fail = 0
async function t(name: string, fn: () => Promise<void>) {
  try { await fn(); pass++; console.log('ok  ', name) } catch (e) { fail++; console.log('FAIL', name, (e as Error).message) }
}
type Call = { url: string; body: any }
function rec(handler: (url: string, init: any, n: number) => Promise<Response>) {
  const calls: Call[] = []
  const f = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) })
    return handler(String(url), init, calls.length)
  }) as typeof fetch
  return { calls, f }
}
const hang = (init: any) => new Promise<Response>((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))))

await t('sniff: sizes/edges', async () => {
  assert.equal(sniffAudioFormat(Buffer.alloc(0)), 'unknown')
  assert.equal(sniffAudioFormat(Buffer.from([0xff, 0xe3, 0, 0])), 'mp3')
  assert.equal(sniffAudioFormat(Buffer.from([0xff, 0xdf, 0, 0])), 'unknown')
  assert.equal(sniffAudioFormat(Buffer.from([0xfe, 0xfb, 0, 0])), 'unknown')
  assert.equal(sniffAudioFormat(ID3), 'mp3')
  assert.equal(sniffAudioFormat(Buffer.from('ID')), 'unknown')
})
await t('hanging soniox gives up ~8s, openai tried within 11s', async () => {
  const { calls, f } = rec(async (u, init) => u.includes('soniox') ? hang(init) : ok(MP3))
  const t0 = Date.now()
  const r = await synthMeetingAudio('hi', { env, fetchImpl: f })
  const dt = Date.now() - t0
  assert.equal(r?.provider, 'openai')
  assert.ok(dt >= 7800 && dt < 9500, `dt=${dt}`)
  assert.equal(calls.length, 2)
})
await t('empty / whitespace text -> null, no fetch', async () => {
  const { calls, f } = rec(async () => ok(MP3))
  assert.equal(await synthMeetingAudio('', { env, fetchImpl: f }), null)
  assert.equal(await synthMeetingAudio('  \n\t', { env, fetchImpl: f }), null)
  assert.equal(calls.length, 0)
})
await t('0-byte soniox -> openai fallback; 0-byte both -> null', async () => {
  let r = rec(async (u) => u.includes('soniox') ? ok(Buffer.alloc(0)) : ok(MP3))
  assert.equal((await synthMeetingAudio('hi', { env, fetchImpl: r.f }))?.provider, 'openai')
  r = rec(async () => ok(Buffer.alloc(0)))
  assert.equal(await synthMeetingAudio('hi', { env, fetchImpl: r.f }), null)
  assert.equal(r.calls.length, 2)
})
await t('missing SONIOX key -> straight to openai only', async () => {
  const { calls, f } = rec(async () => ok(MP3))
  const r = await synthMeetingAudio('hi', { env: { OPENAI_API_KEY: 'oa' } as any, fetchImpl: f })
  assert.equal(r?.provider, 'openai')
  assert.equal(calls.length, 1)
  assert.ok(calls[0].url.includes('openai'))
})
await t('empty-string SONIOX key treated as missing', async () => {
  const { calls, f } = rec(async () => ok(MP3))
  await synthMeetingAudio('hi', { env: { SONIOX_API_KEY: '', OPENAI_API_KEY: 'oa' } as any, fetchImpl: f })
  assert.equal(calls.length, 1)
})
await t('voice "nova" (any case/space) never sent to soniox', async () => {
  for (const v of ['nova', 'NOVA', ' Nova ']) {
    const { calls, f } = rec(async (u) => u.includes('soniox') ? new Response('x', { status: 500 }) : ok(MP3))
    const r = await synthMeetingAudio('hi', { env, fetchImpl: f, voice: v })
    const sx = calls.find((c) => c.url.includes('soniox'))!
    assert.notEqual(String(sx.body.voice).trim().toLowerCase(), 'nova')
    assert.equal(sx.body.voice, 'Victoria')
    assert.equal(calls.find((c) => c.url.includes('openai'))!.body.voice, v)
    assert.equal(r?.provider, 'openai')
  }
})
await t('soniox voice "Maya" not sent to openai', async () => {
  const { calls, f } = rec(async (u) => u.includes('soniox') ? new Response('x', { status: 500 }) : ok(MP3))
  await synthMeetingAudio('hi', { env, fetchImpl: f, voice: 'Maya' })
  assert.equal(calls[0].body.voice, 'Maya')
  assert.equal(calls[1].body.voice, 'fable')
})
await t('ID3 accepted from soniox; JSON/HTML 200 rejected', async () => {
  let r = rec(async () => ok(ID3))
  assert.equal((await synthMeetingAudio('hi', { env, fetchImpl: r.f }))?.provider, 'soniox')
  r = rec(async (u) => u.includes('soniox') ? ok(Buffer.from('<html>blocked</html>')) : ok(MP3))
  assert.equal((await synthMeetingAudio('hi', { env, fetchImpl: r.f }))?.provider, 'openai')
})
await t('fetch throwing synchronously/rejecting never throws', async () => {
  const f = (async () => { throw new Error('boom') }) as typeof fetch
  assert.equal(await synthMeetingAudio('hi', { env, fetchImpl: f }), null)
})
await t('small deadlineMs bounds total time', async () => {
  const { f } = rec(async (_u, init) => hang(init))
  const t0 = Date.now()
  assert.equal(await synthMeetingAudio('hi', { env, fetchImpl: f, deadlineMs: 500 }), null)
  assert.ok(Date.now() - t0 < 1500)
})
clearInterval(keepalive)
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
