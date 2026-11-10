// Run: npx tsx agent/tests/session-switch-adversarial.test.ts
// Adversarial cases for decideNextSession (#74), from the issue log + owner decision.
import assert from 'node:assert/strict'
import { decideNextSession, type SessionSwitchState } from '../src/session-switch.js'

let pass = 0, fail = 0
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('PASS', name) } catch (e: any) { fail++; console.log('FAIL', name, '-', String(e.message).split('\n')[0].slice(0, 300)) }
}
const LIVE = 'c97588f4-0000-4000-8000-000000000000'
const TGT = '73b234e6-0000-4000-8000-000000000000'
const base: SessionSwitchState = { liveSessionId: LIVE, queryResumeTarget: null, resumeTarget: null, hasLiveQuery: true, turnInFlight: false }

t('exact log case: armed target 73b234e6 while running c97588f4 => switch to target', () => {
  const d = decideNextSession({ ...base, resumeTarget: TGT })
  assert.equal(d.action, 'switch'); assert.equal(d.runIn, TGT)
})
t('exact log case via explicit request => switch', () => {
  const d = decideNextSession({ ...base, requestedTarget: TGT })
  assert.equal(d.action, 'switch'); assert.equal(d.runIn, TGT)
})
t('turn in flight is NEVER closed (any switch shape)', () => {
  for (const s of [{ resumeTarget: TGT }, { requestedTarget: TGT }, { resumeTarget: TGT, requestedTarget: TGT }]) {
    const d = decideNextSession({ ...base, ...s, turnInFlight: true })
    assert.notEqual(d.leave, 'close', JSON.stringify(s))
    assert.equal(d.leave, 'background')
  }
})
t('turn in flight, no switch: never close', () => {
  assert.notEqual(decideNextSession({ ...base, turnInFlight: true }).leave, 'close')
})
t('idle leaving session may close', () => {
  assert.equal(decideNextSession({ ...base, requestedTarget: TGT }).leave, 'close')
})
t('stale target after SDK fallback is not retried (spawned for TGT, init reported LIVE)', () => {
  const d = decideNextSession({ ...base, queryResumeTarget: TGT, resumeTarget: TGT })
  assert.equal(d.action, 'push'); assert.equal(d.runIn, LIVE)
  assert.equal(d.leave, 'none')
})
t('stale fallback holds across repeated turns (no loop)', () => {
  for (let i = 0; i < 3; i++) assert.equal(decideNextSession({ ...base, queryResumeTarget: TGT, resumeTarget: TGT, turnInFlight: i % 2 === 0 }).action, 'push')
})
t('target equal to running session => push, nothing left', () => {
  const d = decideNextSession({ ...base, resumeTarget: LIVE, requestedTarget: LIVE })
  assert.equal(d.action, 'push'); assert.equal(d.leave, 'none')
})
t('no live query => cold-start into target, nothing left', () => {
  const d = decideNextSession({ ...base, hasLiveQuery: false, liveSessionId: null, resumeTarget: TGT })
  assert.equal(d.action, 'cold-start'); assert.equal(d.runIn, TGT); assert.equal(d.leave, 'none')
})
t('no live query, no target => cold-start new (null)', () => {
  const d = decideNextSession({ ...base, hasLiveQuery: false, liveSessionId: null })
  assert.equal(d.action, 'cold-start'); assert.equal(d.runIn, null)
})
t('before first init: query spawned for X, target X => push', () => {
  const d = decideNextSession({ ...base, liveSessionId: null, queryResumeTarget: TGT, resumeTarget: TGT })
  assert.equal(d.action, 'push')
})
t('before first init: spawned for X, switch to Y => switch', () => {
  const d = decideNextSession({ ...base, liveSessionId: null, queryResumeTarget: LIVE, requestedTarget: TGT })
  assert.equal(d.action, 'switch'); assert.equal(d.runIn, TGT)
})
t('explicit request wins over stale armed target', () => {
  const OTHER = '19c77344-0000-4000-8000-000000000000'
  const d = decideNextSession({ ...base, resumeTarget: OTHER, requestedTarget: TGT })
  assert.equal(d.runIn, TGT)
})
t('rapid A->B->C->B clicks: last request decides', () => {
  assert.equal(decideNextSession({ ...base, requestedTarget: '4ba9e287' }).runIn, '4ba9e287')
  assert.equal(decideNextSession({ ...base, requestedTarget: TGT }).runIn, TGT)
})
t('empty-string / undefined targets treated as none', () => {
  assert.equal(decideNextSession({ ...base, resumeTarget: '', requestedTarget: undefined }).action, 'push')
  assert.equal(decideNextSession({ ...base, resumeTarget: '', requestedTarget: '' }).action, 'push')
})
t('does not mutate input', () => {
  const s = Object.freeze({ ...base, resumeTarget: TGT })
  decideNextSession(s)
})
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
