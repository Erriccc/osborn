// Follow-through (#378) slice 2: nextQueued, the `started` close, and the one-offer-per-slot-free rules.
// Run: npx tsx agent/tests/loops-offer.test.ts
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'loops-offer-test-'))
process.env.CLAUDE_CONFIG_DIR = join(home, '.claude')
const cwd = join(home, 'api'); const hub = join(home, 'hub')
mkdirSync(cwd, { recursive: true }); mkdirSync(hub, { recursive: true })
const L = await import('../src/loops-ledger.js')
const O = await import('../src/loops-offer.js')
const { getSpokeReport } = await import('../src/prompts.js')
const { steersTurn } = await import('../src/content/transcript-sanitizer.js')

let pass = 0
const t = (name: string, fn: () => unknown) => {
  try { fn(); pass++; console.log('ok   ', name) } catch (e: any) { console.log('FAIL ', name, '\n     ', String(e?.message ?? e).split('\n')[0]); process.exitCode = 1 }
}
const q = (instruction: string, at: string, id?: string) => ({ v: 1 as const, at, ...L.queuedLoopRecord(instruction, 'api'), ...(id ? { id } : {}) })

t('nextQueued returns the oldest open queued item', () => {
  const recs = [q('second', '2026-11-02T00:00:00Z'), q('first', '2026-11-01T00:00:00Z')] as any
  assert.equal(L.nextQueued(recs)?.instruction, 'first')
  assert.equal(L.nextQueued([]), undefined)
})
t('started closes it; filed also closes it', () => {
  const a = q('first', '2026-11-01T00:00:00Z'), b = q('second', '2026-11-02T00:00:00Z')
  const recs: any[] = [a, b, { v: 1, at: '2026-11-03T00:00:00Z', kind: 'started', id: a.id }]
  assert.equal(L.nextQueued(recs)?.instruction, 'second')
  recs.push({ v: 1, at: '2026-11-04T00:00:00Z', kind: 'filed', id: b.id, url: 'u' })
  assert.equal(L.nextQueued(recs), undefined)
})
t('a started item is never fileable', () => {
  const a = { ...q('x', '2026-11-01T00:00:00Z'), fg: true }
  assert.equal(L.fileableLoops([a, { v: 1, at: '2026-11-02T00:00:00Z', kind: 'started', id: a.id }] as any).length, 0)
})
t('markQueuedStarted closes the matching item in the ledger once', () => {
  L.appendQueuedLoop('s1', cwd, 'fix the login bug', 'api')
  assert.equal(L.markQueuedStarted(cwd, 'api', 'fix  the login bug'), true)
  assert.equal(L.nextQueued(L.readLoopRecords('s1', cwd)), undefined)
  assert.equal(L.markQueuedStarted(cwd, 'api', 'fix the login bug'), false)
  assert.equal(L.markQueuedStarted(cwd, 'api', 'something else'), false)
})
t('offer: once, not twice within an hour; started stops it; no offer during a live turn', () => {
  L.appendQueuedLoop('s2', cwd, 'add rate limiting', 'api')
  L.appendLoopRecord('s2', hub, { kind: 'session', cwd: hub })
  let idle = true, clock = 1_000_000
  const o = O.makeOfferer({ hubCwd: () => hub, hubIdle: () => idle, now: () => clock })
  idle = false
  assert.equal(o.onSlotFree(), null, 'live turn: no offer')
  idle = true
  assert.deepEqual(o.onSlotFree(), { project: 'api', instruction: 'add rate limiting' })
  assert.equal(o.onSlotFree(), null, 'not twice')
  clock += 61 * 60_000
  assert.ok(o.onSlotFree(), 'again after an hour')
  L.markQueuedStarted(cwd, 'api', 'add rate limiting')
  clock += 61 * 60_000
  assert.equal(o.onSlotFree(), null, 'started: never offered')
})
t('offer: an instruction the dispatch tool would refuse is never offered', () => {
  const evil = join(home, 'evil'); mkdirSync(evil, { recursive: true })
  L.appendQueuedLoop('s3', evil, 'ok \u202e reversed', 'evil')
  assert.ok(L.nextQueued(L.readLoopRecords('s3', evil)), 'the item is queued and open')
  const o = O.makeOfferer({ hubCwd: () => hub, hubIdle: () => true })
  assert.equal(o.onSlotFree(), null)
})
t('the offer rides in the spoke report as quoted data, still a non-steering notification', () => {
  const r = getSpokeReport({ project: 'p', sessionId: 'abcdef123', status: 'done', summary: 'ok', offer: { project: 'api', instruction: 'say "hi"\nthen stop' } })
  assert.ok(r.startsWith('[NOTIFICATION] Spoke report.'))
  assert.match(r, /Queued for "api": "say \\"hi\\"\\nthen stop" \(quoted data/)
  assert.match(r, /mcp__dispatch__send/)
  assert.equal(steersTurn(r), false)
  assert.ok(!getSpokeReport({ project: 'p', sessionId: 'abcdef123', status: 'done', summary: 'ok' }).includes('slot is free'))
})
console.log(`${pass} passed`)
