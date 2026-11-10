// Native duck tests: applyGain ramp/clamp/immutability and installDuck wrapper.
// Run: npx tsx agent/tests/duck.test.ts
import assert from 'node:assert/strict'

const { applyGain, installDuck, DUCK_LEVEL } = await import('../src/duck.js')

let pass = 0
const t = async (name: string, fn: () => unknown) => {
  try { await fn(); pass++; console.log('ok   ', name) } catch (e: any) { console.log('FAIL ', name, '\n     ', e.message.split('\n')[0]); process.exitCode = 1 }
}

class FakeFrame {
  constructor(public data: Int16Array, public sampleRate: number, public channels: number, public samplesPerChannel: number) {}
}
class FakeOutput {
  frames: any[] = []
  captureFrame(f: any) { this.frames.push(f); return Promise.resolve() }
}
const mkSession = () => ({ output: { audio: new FakeOutput() } })
const frame = (vals: number[]) => new FakeFrame(Int16Array.from(vals), 24000, 1, vals.length)

await t('DUCK_LEVEL is 0.45 (55% quieter)', () => assert.equal(DUCK_LEVEL, 0.45))

await t('applyGain identity at 1→1 returns same reference', () => {
  const a = Int16Array.from([1, 2, 3])
  assert.equal(applyGain(a, 1, 1), a)
})

await t('applyGain ramp endpoints', () => {
  const a = Int16Array.from([1000, 1000, 1000, 1000, 1000])
  const r = applyGain(a, 1, 0.6)
  assert.equal(r[0], 1000)
  assert.equal(r[4], 600)
  assert.equal(r[2], 800)
})

await t('applyGain constant gain', () => {
  const r = applyGain(Int16Array.from([100, -100, 7]), 0.6, 0.6)
  assert.deepEqual(Array.from(r), [60, -60, 4])
})

await t('applyGain clamps', () => {
  const r = applyGain(Int16Array.from([30000, -30000]), 2, 2)
  assert.deepEqual(Array.from(r), [32767, -32768])
})

await t('applyGain does not mutate input', () => {
  const a = Int16Array.from([500, -500, 500])
  const r = applyGain(a, 0.6, 0.6)
  assert.notEqual(r, a)
  assert.deepEqual(Array.from(a), [500, -500, 500])
})

await t('installDuck returns null without output.audio', () => {
  assert.equal(installDuck({}), null)
  assert.equal(installDuck(null), null)
  assert.equal(installDuck({ output: {} }), null)
})

await t('pass-through at gain 1', async () => {
  const s = mkSession(); const out = s.output.audio
  installDuck(s)
  const f = frame([100, 200])
  await out.captureFrame(f)
  assert.equal(out.frames[0], f)
})

await t('scales after setDuck(0.6), then restores', async () => {
  const s = mkSession(); const out = s.output.audio
  const d = installDuck(s)!
  d.setDuck(0.6, 'test')
  assert.equal(d.target, 0.6)
  const f1 = frame([1000, 1000, 1000])
  await out.captureFrame(f1)
  const r1 = out.frames[0]
  assert.notEqual(r1, f1)
  assert.ok(r1 instanceof FakeFrame)
  assert.equal(r1.data[0], 1000)
  assert.equal(r1.data[2], 600)
  assert.equal(r1.sampleRate, 24000)
  assert.equal(r1.samplesPerChannel, 3)
  assert.deepEqual(Array.from(f1.data), [1000, 1000, 1000], 'original untouched')
  const f2 = frame([1000, 1000])
  await out.captureFrame(f2)
  assert.deepEqual(Array.from(out.frames[1].data), [600, 600])
  d.setDuck(1)
  const f3 = frame([1000, 1000, 1000])
  await out.captureFrame(f3)
  assert.deepEqual(Array.from(out.frames[2].data), [600, 800, 1000], 'ramps back up')
  const f4 = frame([1000])
  await out.captureFrame(f4)
  assert.equal(out.frames[3], f4, 'pass-through once fully restored')
})

await t('install is idempotent', async () => {
  const s = mkSession(); const out = s.output.audio
  const a = installDuck(s)
  const b = installDuck(s)
  assert.equal(a, b)
  a!.setDuck(0.6)
  await out.captureFrame(frame([1000]))
  assert.equal(out.frames.length, 1, 'not double-wrapped')
  assert.equal(out.frames[0].data[0], 600, 'scaled once, not twice')
})

await t('throw in gain path forwards original frame', async () => {
  const s = mkSession(); const out = s.output.audio
  const d = installDuck(s)!
  d.setDuck(0.6)
  const bad = { data: null, sampleRate: 24000, channels: 1, samplesPerChannel: 2 }
  await out.captureFrame(bad)
  assert.equal(out.frames[0], bad)
})

console.log(`\n${pass} passed${process.exitCode ? ', some FAILED' : ''}`)
