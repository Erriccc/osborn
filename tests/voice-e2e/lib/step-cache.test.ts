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
const { actWithCache, fencedCall, zombieGate } = await import('./step-cache.ts')
const { readFileSync, existsSync } = await import('fs')
const actionsFile = join(process.env.OSBORN_KNOWLEDGE_DIR, 'example.com', 'actions.json')
const cached = (): Record<string, any> => existsSync(actionsFile) ? JSON.parse(readFileSync(actionsFile, 'utf8')) : {}

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
    settled: (end) => order.push(`settled=${end}`),
    onLate: (l) => late.push(l),
  }).catch((e) => { order.push('lock released'); throw e })
  await assert.rejects(run, /timed out/)
  assert.deepEqual(order, ['brain closed', 'act stopped', 'settled=late', 'lock released'])
  assert.equal(late.length, 1)  // the late finish is reported, not silent
})

test('#174: a call that will not stop releases the caller after the settle wait, and says so', async () => {
  let end: string | undefined
  const t0 = Date.now()
  await assert.rejects(fencedCall(() => new Promise(() => {}), { timeoutMs: 10, settleMs: 40, why: 'timed out', settled: (e) => { end = e } }), /timed out/)
  assert.equal(end, 'running')
  assert.ok(Date.now() - t0 >= 45)
})

test('#421: an act that finishes after the timeout writes nothing to the action cache', async () => {
  let finishAct!: () => void
  const brain = {
    observe: async () => [{ method: 'click', description: 'Late', selector: 'xpath=/html/body/button' }],
    act: () => new Promise<void>((done) => { finishAct = done }),
  }
  const late: any[] = []
  await assert.rejects(fencedCall((signal) => actWithCache(brain, page, 'press the late button', signal), {
    timeoutMs: 20, settleMs: 500, why: 'brain call timed out',
    onTimeout: () => { setTimeout(() => finishAct(), 10) },
    onLate: (l) => late.push(l),
  }), /timed out/)
  assert.equal(late.length, 1)
  assert.equal(late[0].ok, true)
  assert.equal(cached()['/form :: press the late button'], undefined)
})

test('#421: a cached replay that finishes after the timeout bumps no hit counter', async () => {
  const brain = { observe: async () => [{ method: 'click', description: 'Again' }], act: async (): Promise<void> => {} }
  await actWithCache(brain, page, 'press again')  // resolves and caches it
  assert.equal(cached()['/form :: press again'].hits, 0)
  let finishAct!: () => void
  brain.act = () => new Promise<void>((done) => { finishAct = done })
  await assert.rejects(fencedCall((signal) => actWithCache(brain, page, 'press again', signal), {
    timeoutMs: 20, settleMs: 500, why: 'brain call timed out', onTimeout: () => { setTimeout(() => finishAct(), 10) },
  }), /timed out/)
  assert.equal(cached()['/form :: press again'].hits, 0)
})

test('#421: a late rejection is reported, and only a stop at the fence counts as stopped', async () => {
  const late: any[] = []
  let end: string | undefined
  let fail!: () => void
  await assert.rejects(fencedCall(() => new Promise((_, rej) => { fail = () => rej(new Error('target closed')) }), {
    timeoutMs: 10, settleMs: 500, why: 'timed out', onTimeout: () => { setTimeout(() => fail(), 10) },
    settled: (e) => { end = e }, onLate: (l) => late.push(l),
  }), /timed out/)
  assert.equal(end, 'late')
  assert.equal(late.length, 1)
  assert.equal(late[0].ok, false)
  assert.match(String(late[0].error), /target closed/)

  // a call that stops at its own fence check never started an action after the deadline
  let release!: () => void
  const brain = { observe: () => new Promise((done) => { release = () => done([{ method: 'click', description: 'X' }]) }), act: async () => { throw new Error('must not act') } }
  late.length = 0
  await assert.rejects(fencedCall((signal) => actWithCache(brain, page, 'press x', signal), {
    timeoutMs: 10, settleMs: 500, why: 'timed out', onTimeout: () => { release() },
    settled: (e) => { end = e }, onLate: (l) => late.push(l),
  }), /timed out/)
  assert.equal(end, 'stopped')
  assert.equal(late.length, 0)
})

test('#421: the settle wait includes the brain close', async () => {
  const order: string[] = []
  let closedAs: boolean | undefined
  await assert.rejects(fencedCall(() => new Promise<number>(() => {}), {
    timeoutMs: 10, settleMs: 40, why: 'timed out',
    onTimeout: () => new Promise((done) => setTimeout(() => { order.push('closed'); done(null) }, 20)),
    settled: (_, closed) => { closedAs = closed; order.push('settled') },
  }), /timed out/)
  assert.deepEqual(order, ['closed', 'settled'])
  assert.equal(closedAs, true)
  await assert.rejects(fencedCall(() => new Promise<number>(() => {}), {
    timeoutMs: 10, settleMs: 30, why: 'timed out', onTimeout: () => new Promise(() => {}), settled: (_, closed) => { closedAs = closed },
  }), /timed out/)
  assert.equal(closedAs, false)
})

test('#421: the next brain call waits for a zombie, and is refused if it will not stop in its budget', async () => {
  const gate = zombieGate()
  await gate.wait(0, 'act')  // nothing tracked: no wait
  let finish!: () => void
  gate.track(new Promise<void>((done) => { finish = done }))
  assert.equal(gate.pending, true)
  await assert.rejects(gate.wait(30, 'act'), /act refused: a timed-out brain call/)
  setTimeout(() => finish(), 20)
  await gate.wait(1000, 'act')  // waits it out
  assert.equal(gate.pending, false)
  // a zombie that rejects still clears; two zombies are both waited for
  let failA!: () => void
  let finishB!: () => void
  gate.track(new Promise<void>((_, rej) => { failA = () => rej(new Error('x')) }))
  gate.track(new Promise<void>((done) => { finishB = done }))
  failA()
  await assert.rejects(gate.wait(30, 'brain re-init'), /brain re-init refused/)
  finishB()
  await gate.wait(1000, 'act')
  assert.equal(gate.pending, false)
})

test('fencedCall: a call within the deadline returns, and its own error passes through unfenced', async () => {
  let fenced = 0
  const o = { timeoutMs: 1000, settleMs: 10, why: 'timed out', onTimeout: () => { fenced++ } }
  assert.equal(await fencedCall(async () => 7, o), 7)
  await assert.rejects(fencedCall(async () => { throw new Error('boom') }, o), /boom/)
  assert.equal(fenced, 0)
})
