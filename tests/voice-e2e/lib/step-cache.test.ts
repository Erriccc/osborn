/**
 * The #174 fence: once a brain call has timed out, its late completion never acts.
 *   npx tsx --test lib/step-cache.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

process.env.OSBORN_KNOWLEDGE_DIR = mkdtempSync(join(tmpdir(), 'step-cache-test-'))
const { actWithCache, fencedCall } = await import('./step-cache.ts')

const page = { url: () => 'https://example.com/form', locator: () => ({ first: () => ({ count: async () => 0 }) }) } as any

test('#174: an act whose observe finishes after the timeout does not act', async () => {
  const fence = new AbortController()
  let acted = 0
  let finishObserve!: () => void
  const brain = {
    observe: () => new Promise((done) => { finishObserve = () => done([{ method: 'click', description: 'Submit' }]) }),
    act: async () => { acted++ },
  }
  const call = actWithCache(brain, page, 'submit the form', fence.signal)
  await new Promise((r) => setTimeout(r, 10))
  fence.abort(new Error('brain call timed out'))  // the engine's timeout fires, the lock frees
  finishObserve()                                 // ...then the hung model call wakes up
  await assert.rejects(call, /timed out/)
  assert.equal(acted, 0)
})

test('#174: an already-aborted call starts nothing', async () => {
  const fence = new AbortController(); fence.abort(new Error('timed out'))
  let calls = 0
  const brain = { observe: async () => { calls++; return [] }, act: async () => { calls++ } }
  await assert.rejects(actWithCache(brain, page, 'submit the form', fence.signal), /timed out/)
  assert.equal(calls, 0)
})

test('without a signal the act goes through as before', async () => {
  let acted = 0
  const brain = { observe: async () => [{ method: 'click', description: 'Go' }], act: async () => { acted++ } }
  const r = await actWithCache(brain, page, 'press go')
  assert.equal(acted, 1)
  assert.equal(r.cached, false)
})

test('#174: a timed-out call holds its caller until the in-flight action has stopped', async () => {
  let finishAct!: () => void
  const order: string[] = []
  const brain = {
    observe: async () => [{ method: 'click', description: 'Submit' }],
    act: () => new Promise<void>((done) => { finishAct = () => { order.push('act stopped'); done() } }),
  }
  const late: unknown[] = []
  const run = fencedCall((signal) => actWithCache(brain, page, 'submit the form', signal), {
    timeoutMs: 20, settleMs: 1000, why: 'brain call timed out',
    onTimeout: () => { order.push('brain closed'); setTimeout(() => finishAct(), 30) },  // closing ends the act
    stopped: (ok) => order.push(`stopped=${ok}`),
    onLate: (r) => late.push(r),
  }).catch((e) => { order.push('lock released'); throw e })
  await assert.rejects(run, /timed out/)
  assert.deepEqual(order, ['brain closed', 'act stopped', 'stopped=true', 'lock released'])
  assert.equal(late.length, 1)  // the late finish is reported, not silent
})

test('#174: a call that will not stop releases the caller after the settle wait, and says so', async () => {
  let stopped: boolean | undefined
  const t0 = Date.now()
  await assert.rejects(fencedCall(() => new Promise(() => {}), { timeoutMs: 10, settleMs: 40, why: 'timed out', stopped: (ok) => { stopped = ok } }), /timed out/)
  assert.equal(stopped, false)
  assert.ok(Date.now() - t0 >= 45)
})

test('fencedCall: a call within the deadline returns, and its own error passes through unfenced', async () => {
  let fenced = 0
  const o = { timeoutMs: 1000, settleMs: 10, why: 'timed out', onTimeout: () => { fenced++ } }
  assert.equal(await fencedCall(async () => 7, o), 7)
  await assert.rejects(fencedCall(async () => { throw new Error('boom') }, o), /boom/)
  assert.equal(fenced, 0)
})
