// Run: npx tsx agent/tests/switch-blind-plan.test.ts
// BLIND adversarial tests for #74 (scope doc §2-§6): pure planner + fake-query LLM.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decideNextSession, planSwitch, type SessionSwitchState, type SwitchPlanContext } from '../src/session-switch.js'

const fakeHome = mkdtempSync(join(tmpdir(), 'osb-blind-'))
process.env.HOME = fakeHome
process.env.CLAUDE_CONFIG_DIR = join(fakeHome, '.claude')
const { ClaudeLLM } = await import('../src/claude-llm.js')

let pass = 0, fail = 0
async function t(name: string, fn: () => void | Promise<void>) {
  try { await fn(); pass++; console.log('PASS', name) }
  catch (e: any) { fail++; console.log('FAIL', name, '-', String(e?.message).split('\n')[0].slice(0, 300)) }
}
const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const C = 'cccccccc-3333-4333-8333-cccccccccccc'

const st = (o: Partial<SessionSwitchState> = {}): SessionSwitchState =>
  ({ liveSessionId: A, queryResumeTarget: A, resumeTarget: B, requestedTarget: B, hasLiveQuery: true, turnInFlight: false, ...o })
const cx = (o: Partial<SwitchPlanContext> = {}): SwitchPlanContext =>
  ({ permissionPending: false, meetingActive: false, targetSlot: 'none', force: false, demoteSupported: false, ...o })

// ── busy A never closed without force ──
await t('busy A, no force: plan is never execute-with-close (defer)', () => {
  const d = decideNextSession(st({ turnInFlight: true }))
  const p = planSwitch(d, cx())
  assert.equal(p.kind, 'defer')
  assert.notEqual(p.leave, 'close')
})
await t('busy A: exhaustive ctx matrix without force never yields execute+close', () => {
  for (const permissionPending of [true, false]) for (const meetingActive of [true, false])
    for (const targetSlot of ['none', 'idle', 'busy'] as const) for (const demoteSupported of [false]) {
      const p = planSwitch(decideNextSession(st({ turnInFlight: true })), cx({ permissionPending, meetingActive, targetSlot, demoteSupported, force: false }))
      assert.ok(!(p.kind === 'execute' && p.leave === 'close'), JSON.stringify({ permissionPending, meetingActive, targetSlot, p }))
    }
})
await t('busy A + force: execute and close', () => {
  const p = planSwitch(decideNextSession(st({ turnInFlight: true })), cx({ force: true }))
  assert.equal(p.kind, 'execute'); assert.equal(p.leave, 'close')
})
await t('idle A: execute, close (nothing lost)', () => {
  const p = planSwitch(decideNextSession(st()), cx())
  assert.equal(p.kind, 'execute'); assert.equal(p.leave, 'close')
})
// ── permission ──
await t('busy + permission pending, no force: reject needs_you', () => {
  const p = planSwitch(decideNextSession(st({ turnInFlight: true })), cx({ permissionPending: true }))
  assert.equal(p.kind, 'reject'); assert.equal(p.reason, 'needs_you')
})
await t('busy + permission pending + force: executes', () => {
  const p = planSwitch(decideNextSession(st({ turnInFlight: true })), cx({ permissionPending: true, force: true }))
  assert.equal(p.kind, 'execute')
})
// ── meeting ──
await t('meeting live: reject meeting_active (idle, busy, forced)', () => {
  for (const turnInFlight of [false, true]) for (const force of [false, true]) {
    const p = planSwitch(decideNextSession(st({ turnInFlight })), cx({ meetingActive: true, force }))
    assert.equal(p.kind, 'reject', JSON.stringify({ turnInFlight, force })); assert.equal(p.reason, 'meeting_active')
  }
})
// ── target slot ──
await t('target busy slot: reject target_busy_in_background, even forced', () => {
  for (const force of [false, true]) {
    const p = planSwitch(decideNextSession(st()), cx({ targetSlot: 'busy', force }))
    assert.equal(p.kind, 'reject'); assert.equal(p.reason, 'target_busy_in_background')
  }
})
await t('target idle slot: execute with stopSlotFirst; no slot: stopSlotFirst false', () => {
  const p = planSwitch(decideNextSession(st()), cx({ targetSlot: 'idle' }))
  assert.equal(p.kind, 'execute'); assert.equal(p.stopSlotFirst, true)
  assert.equal(planSwitch(decideNextSession(st()), cx()).stopSlotFirst, false)
})
await t('non-execute plans never set stopSlotFirst', () => {
  const p = planSwitch(decideNextSession(st({ turnInFlight: true })), cx({ targetSlot: 'idle' }))
  assert.notEqual(p.kind, 'execute'); assert.equal(p.stopSlotFirst, false)
})
// ── noop ──
await t('switch to the running session: noop, nothing closed, regardless of ctx', () => {
  for (const turnInFlight of [false, true]) for (const force of [true, false]) {
    const d = decideNextSession(st({ requestedTarget: A, resumeTarget: A, turnInFlight }))
    const p = planSwitch(d, cx({ force, permissionPending: true }))
    assert.equal(p.kind, 'noop'); assert.equal(p.leave, 'none')
  }
})
await t('input purity: planSwitch/decide do not mutate inputs', () => {
  const s = st({ turnInFlight: true }), c = cx(), s0 = JSON.stringify(s), c0 = JSON.stringify(c)
  planSwitch(decideNextSession(s), c); assert.equal(JSON.stringify(s), s0); assert.equal(JSON.stringify(c), c0)
})
// ── rapid repeats: last wins, single pendingSwitch ──
await t('repeated defer plans are stable (deterministic)', () => {
  for (const tgt of [B, C, B]) {
    const p = planSwitch(decideNextSession(st({ turnInFlight: true, requestedTarget: tgt, resumeTarget: tgt })), cx())
    assert.equal(p.kind, 'defer')
  }
})
await t('index.ts holds exactly one pendingSwitch slot; a newer defer clears the old timer (static)', () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.equal((src.match(/let pendingSwitch\b/g) || []).length, 1)
  // the poller must self-cancel when it is no longer the registered timer
  assert.match(src, /pendingSwitch\.timer !== timer\) \{ clearInterval\(timer\)/)
  assert.match(src, /newer request replaces the older/)
})

// ── fake-query LLM: backstop ──
function fakeQ() {
  const spawned: any[] = []
  const fn = ({ options }: any) => {
    const queue: any[] = []; let wake: any = null
    const q: any = { options, closed: false,
      emit(m: any) { queue.push(m); wake?.(); wake = null },
      close() { q.closed = true; wake?.(); wake = null },
      async *[Symbol.asyncIterator]() { while (true) { if (queue.length) { yield queue.shift(); continue } if (q.closed) return; await new Promise<void>(r => { wake = r }) } } }
    spawned.push(q); return q
  }
  return { fn, spawned }
}
const tick = () => new Promise(r => setTimeout(r, 0))
const mk = (fq: any) => new ClaudeLLM({ workingDirectory: fakeHome, queryFn: fq.fn as any }) as any
const cb = (llm: any) => ({ onSessionId: () => {}, onCheckpoint: () => {}, eventEmitter: llm.events })
async function settle(llm: any) { for (let i = 0; i < 60 && !llm.busyState().idle; i++) await tick() }

await t('backstop: busy A + armed B -> A NOT closed (no rebuild)', async () => {
  const fq = fakeQ(), llm = mk(fq)
  llm.pushMessage('go', { resume: A }, cb(llm))
  fq.spawned[0].emit({ type: 'system', subtype: 'init', session_id: A }); await tick()
  assert.equal(llm.busyState().turnInFlight, true)
  llm.setResumeSessionId(B)
  llm.pushMessage('more', { resume: B }, cb(llm))
  assert.equal(fq.spawned[0].closed, false); assert.equal(fq.spawned.length, 1)
})
await t('backstop: failed resume (armed==spawned!=live) never rebuilds, across repeated pushes', async () => {
  const fq = fakeQ(), llm = mk(fq)
  llm.pushMessage('go', { resume: B }, cb(llm))
  fq.spawned[0].emit({ type: 'system', subtype: 'init', session_id: A }) // SDK fell back: live A, spawned B
  fq.spawned[0].emit({ type: 'result', result: 'ok' }); await tick(); await settle(llm)
  llm.setResumeSessionId(B)
  for (let i = 0; i < 3; i++) { llm.pushMessage('again' + i, { resume: B }, cb(llm)); fq.spawned[0].emit({ type: 'result', result: 'ok' }); await settle(llm) }
  assert.equal(fq.spawned.length, 1, 'rebuild loop')
  assert.equal(fq.spawned[0].closed, false)
})
await t('backstop: idle A + armed B (armed!=spawned!=live) rebuilds on B', async () => {
  const fq = fakeQ(), llm = mk(fq)
  llm.pushMessage('go', { resume: A }, cb(llm))
  fq.spawned[0].emit({ type: 'system', subtype: 'init', session_id: A }); fq.spawned[0].emit({ type: 'result', result: 'ok' }); await settle(llm)
  llm.setResumeSessionId(B); llm.pushMessage('x', { resume: B }, cb(llm))
  assert.equal(fq.spawned[0].closed, true); assert.equal(fq.spawned[1].options.resume, B)
})
await t('backstop: armed==live (no switch) pushes into same query', async () => {
  const fq = fakeQ(), llm = mk(fq)
  llm.pushMessage('go', { resume: A }, cb(llm))
  fq.spawned[0].emit({ type: 'system', subtype: 'init', session_id: A }); fq.spawned[0].emit({ type: 'result', result: 'ok' }); await settle(llm)
  llm.setResumeSessionId(A); llm.pushMessage('x', { resume: A }, cb(llm))
  assert.equal(fq.spawned.length, 1); assert.equal(fq.spawned[0].closed, false)
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
