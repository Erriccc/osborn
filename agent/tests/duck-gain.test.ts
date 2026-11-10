// Duck gain — applyGain ramp math + installDuck captureFrame wrapper (blind, from spec).
// Run: npx tsx agent/tests/duck-gain.test.ts
import assert from 'node:assert/strict'

const { DUCK_LEVEL, applyGain, installDuck } = await import('../src/duck')

let pass = 0
const t = async (name: string, fn: () => unknown | Promise<unknown>) => {
  try { await fn(); pass++; console.log('ok   ', name) }
  catch (e: any) { console.log('FAIL ', name, '\n     ', String(e?.message ?? e).split('\n')[0]); process.exitCode = 1 }
}

class Frame {
  constructor(public data: Int16Array, public sampleRate: number, public channels: number, public samplesPerChannel: number) {}
}
let throwOnConstruct = false
class ThrowFrame extends Frame {
  constructor(d: Int16Array, sr: number, ch: number, spc: number) {
    super(d, sr, ch, spc)
    if (throwOnConstruct) throw new Error('boom')
  }
}
const mkFrame = (v = 10000, n = 100, C: any = Frame) => new C(new Int16Array(n).fill(v), 48000, 1, n)
function mkSession() {
  const got: any[] = []
  const audio: any = { captureFrame: async (f: any) => { got.push(f) } }
  return { session: { output: { audio } } as any, audio, got }
}

await t('DUCK_LEVEL is 0.45', () => assert.equal(DUCK_LEVEL, 0.45))

await t('applyGain identity returns same reference', () => {
  const a = new Int16Array([1, 2, 3])
  assert.equal(applyGain(a, 1, 1), a)
})
await t('applyGain non-identity returns new array, same length', () => {
  const a = new Int16Array([100, 200, 300, 400])
  const r = applyGain(a, 0.5, 0.5)
  assert.notEqual(r, a); assert.ok(r instanceof Int16Array); assert.equal(r.length, 4)
  assert.deepEqual(Array.from(r), [50, 100, 150, 200])
})
await t('applyGain ramp endpoints', () => {
  const a = new Int16Array(11).fill(1000)
  const r = applyGain(a, 1, 0.5)
  assert.equal(r[0], 1000); assert.equal(r[10], 500)
  assert.equal(r[5], 750)
  for (let i = 1; i < 11; i++) assert.ok(r[i] <= r[i - 1])
})
await t('applyGain ramp up to full', () => {
  const r = applyGain(new Int16Array(11).fill(1000), 0.5, 1)
  assert.equal(r[0], 500); assert.equal(r[10], 1000)
})
await t('applyGain single sample uses `to`', () => {
  const r = applyGain(new Int16Array([1000]), 1, 0.5)
  assert.equal(r.length, 1); assert.equal(r[0], 500)
})
await t('applyGain empty array', () => {
  assert.equal(applyGain(new Int16Array(0), 1, 0.5).length, 0)
})
await t('applyGain clamps positive and negative extremes', () => {
  const r = applyGain(new Int16Array([32767, -32768, 32767, -32768]), 2, 2)
  assert.deepEqual(Array.from(r), [32767, -32768, 32767, -32768])
})
await t('applyGain rounds', () => {
  const r = applyGain(new Int16Array([3]), 0.5, 0.5) // 1.5 -> 2
  assert.equal(r[0], 2)
  assert.equal(applyGain(new Int16Array([1]), 0.4, 0.4)[0], 0)
})
await t('applyGain does not mutate src', () => {
  const a = new Int16Array([1000, 2000, 3000, 4000])
  applyGain(a, 1, 0.1)
  assert.deepEqual(Array.from(a), [1000, 2000, 3000, 4000])
})

await t('installDuck returns null when output missing', () => {
  assert.equal(installDuck({} as any), null)
  assert.equal(installDuck({ output: {} } as any), null)
})
await t('installDuck pass-through at gain 1 forwards same frame', async () => {
  const { session, audio, got } = mkSession()
  const c: any = installDuck(session)
  assert.ok(c); assert.equal(c.target, 1)
  const f = mkFrame()
  await audio.captureFrame(f)
  assert.equal(got.length, 1); assert.equal(got[0], f)
})
await t('duck: ramp frame then steady state', async () => {
  const { session, audio, got } = mkSession()
  const c: any = installDuck(session)
  c.setDuck(DUCK_LEVEL, 'test')
  assert.equal(c.target, 0.45)
  const f1 = mkFrame(10000, 100)
  await audio.captureFrame(f1)
  const o1 = got[0]
  assert.notEqual(o1, f1); assert.ok(o1 instanceof Frame)
  assert.equal(o1.sampleRate, 48000); assert.equal(o1.channels, 1); assert.equal(o1.samplesPerChannel, 100)
  assert.equal(o1.data[0], 10000); assert.equal(o1.data[99], 4500)
  assert.equal(f1.data[99], 10000)
  const f2 = mkFrame(10000, 100)
  await audio.captureFrame(f2)
  const o2 = got[1]
  assert.notEqual(o2, f2)
  assert.ok(Array.from(o2.data as Int16Array).every(v => v === 4500))
})
await t('restore: setDuck(1) ramps back to full', async () => {
  const { session, audio, got } = mkSession()
  const c: any = installDuck(session)
  c.setDuck(0.45)
  await audio.captureFrame(mkFrame()); await audio.captureFrame(mkFrame())
  c.setDuck(1)
  assert.equal(c.target, 1)
  await audio.captureFrame(mkFrame())
  const o = got[2]
  assert.equal(o.data[0], 4500); assert.equal(o.data[99], 10000)
  const f = mkFrame()
  await audio.captureFrame(f)
  assert.ok(Array.from(got[3].data as Int16Array).every(v => v === 10000))
})
await t('idempotent install: no double wrap', async () => {
  const { session, audio, got } = mkSession()
  const c1: any = installDuck(session)
  const c2: any = installDuck(session)
  assert.ok(c1); assert.ok(c2)
  c2.setDuck(0.45)
  await audio.captureFrame(mkFrame()); await audio.captureFrame(mkFrame())
  assert.equal(got.length, 2)
  assert.ok(Array.from(got[1].data as Int16Array).every(v => v === 4500)) // not 2025
})
await t('throw fallback forwards original frame', async () => {
  const { session, audio, got } = mkSession()
  const c: any = installDuck(session)
  const f = mkFrame(10000, 100, ThrowFrame)
  throwOnConstruct = true
  try {
    c.setDuck(0.45)
    await audio.captureFrame(f)
  } finally { throwOnConstruct = false }
  assert.equal(got.length, 1); assert.equal(got[0], f)
})

console.log(`\n${pass} passed`)
