// Run: npx tsx agent/tests/switch-decision.test.ts
// Pure seam for #74: which session does the NEXT message run in, given the live
// session, any pending switch, and whether a turn is in flight?
//
// The live bug (browser log 2026-11-09): the click armed resume target 73b234e6
// (session_resume_set), the persistent query kept running c97588f4, the next
// turn was pushed into it, and init reported session_resume_failed
// {requested: 73b234e6, actual: c97588f4}. The decision for that exact state
// must be "switch to 73b234e6", never "push into c97588f4".
import assert from 'node:assert/strict'
import { decideNextSession, type SessionSwitchState } from '../src/session-switch.js'

let pass = 0, fail = 0
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('PASS', name) }
  catch (e: any) { fail++; console.log('FAIL', name, '-', String(e.message).split('\n')[0].slice(0, 300)) }
}

const OLD = 'c97588f4-0000-4000-8000-000000000000'
const NEW = '73b234e6-0000-4000-8000-000000000000'
const OTHER = '19c77344-0000-4000-8000-000000000000'

const live = (over: Partial<SessionSwitchState> = {}): SessionSwitchState => ({
  liveSessionId: OLD,
  queryResumeTarget: OLD,
  resumeTarget: OLD,
  hasLiveQuery: true,
  turnInFlight: false,
  ...over,
})

t('live log sequence: armed target differs from live query -> switch to target, not push', () => {
  const d = decideNextSession(live({ resumeTarget: NEW }))
  assert.equal(d.action, 'switch')
  assert.equal(d.runIn, NEW)
  assert.notEqual(d.runIn, OLD)
})

t('same sequence, the old session started fresh (no resume target at spawn) -> still switch', () => {
  const d = decideNextSession(live({ queryResumeTarget: null, resumeTarget: NEW }))
  assert.equal(d.action, 'switch')
  assert.equal(d.runIn, NEW)
})

t('no pending switch -> push into the live session', () => {
  const d = decideNextSession(live())
  assert.equal(d.action, 'push')
  assert.equal(d.runIn, OLD)
  assert.equal(d.leave, 'none')
})

t('fresh session (never resumed) with no target -> push into it', () => {
  const d = decideNextSession(live({ queryResumeTarget: null, resumeTarget: null }))
  assert.equal(d.action, 'push')
  assert.equal(d.runIn, OLD)
})

t('explicit request for the live session -> push, nothing torn down', () => {
  const d = decideNextSession(live({ requestedTarget: OLD }))
  assert.equal(d.action, 'push')
  assert.equal(d.leave, 'none')
})

t('explicit request for another session -> switch', () => {
  const d = decideNextSession(live({ requestedTarget: OTHER }))
  assert.equal(d.action, 'switch')
  assert.equal(d.runIn, OTHER)
})

t('explicit request wins over an armed target', () => {
  const d = decideNextSession(live({ resumeTarget: NEW, requestedTarget: OTHER }))
  assert.equal(d.runIn, OTHER)
})

t('turn in flight: the left session is kept running in the background, never closed', () => {
  const d = decideNextSession(live({ resumeTarget: NEW, turnInFlight: true }))
  assert.equal(d.action, 'switch')
  assert.equal(d.leave, 'background')
})

t('idle: the left session can be closed (nothing in flight is lost)', () => {
  const d = decideNextSession(live({ resumeTarget: NEW, turnInFlight: false }))
  assert.equal(d.leave, 'close')
})

t('no decision ever closes a session with a turn in flight', () => {
  const ids = [OLD, NEW, OTHER, null]
  for (const liveSessionId of ids) for (const queryResumeTarget of ids) for (const resumeTarget of ids)
    for (const requestedTarget of [...ids, undefined]) for (const hasLiveQuery of [true, false]) {
      const d = decideNextSession({ liveSessionId, queryResumeTarget, resumeTarget, requestedTarget, hasLiveQuery, turnInFlight: true })
      assert.notEqual(d.leave, 'close', JSON.stringify({ liveSessionId, queryResumeTarget, resumeTarget, requestedTarget, hasLiveQuery }))
    }
})

t('resume already attempted and SDK fell back (failed resume) -> push, no rebuild loop', () => {
  // The live query was spawned with resume NEW but init reported OTHER: the
  // target was already tried. Re-rebuilding on every turn would loop forever.
  const d = decideNextSession(live({ liveSessionId: OTHER, queryResumeTarget: NEW, resumeTarget: NEW }))
  assert.equal(d.action, 'push')
  assert.equal(d.runIn, OTHER)
})

t('primed query for the target, init not seen yet -> push into it (no double spawn)', () => {
  const d = decideNextSession(live({ liveSessionId: null, queryResumeTarget: NEW, resumeTarget: NEW }))
  assert.equal(d.action, 'push')
  assert.equal(d.runIn, NEW)
})

t('primed query for the target + explicit request for the same target -> push', () => {
  const d = decideNextSession(live({ liveSessionId: null, queryResumeTarget: NEW, resumeTarget: NEW, requestedTarget: NEW }))
  assert.equal(d.action, 'push')
})

t('no live query: cold start in the armed target', () => {
  const d = decideNextSession({ liveSessionId: null, queryResumeTarget: null, resumeTarget: NEW, hasLiveQuery: false, turnInFlight: false })
  assert.equal(d.action, 'cold-start')
  assert.equal(d.runIn, NEW)
  assert.equal(d.leave, 'none')
})

t('no live query, explicit request -> cold start in the request', () => {
  const d = decideNextSession({ liveSessionId: null, queryResumeTarget: null, resumeTarget: OLD, requestedTarget: NEW, hasLiveQuery: false, turnInFlight: false })
  assert.equal(d.action, 'cold-start')
  assert.equal(d.runIn, NEW)
})

t('no live query, no target -> cold start in the remembered session (or new)', () => {
  const a = decideNextSession({ liveSessionId: OLD, queryResumeTarget: null, resumeTarget: null, hasLiveQuery: false, turnInFlight: false })
  assert.equal(a.runIn, OLD)
  const b = decideNextSession({ liveSessionId: null, queryResumeTarget: null, resumeTarget: null, hasLiveQuery: false, turnInFlight: false })
  assert.equal(b.action, 'cold-start')
  assert.equal(b.runIn, null)
})

t('switch then switch back: A->B then B->A both switch', () => {
  const ab = decideNextSession(live({ requestedTarget: NEW }))
  assert.equal(ab.runIn, NEW)
  const ba = decideNextSession({ liveSessionId: NEW, queryResumeTarget: NEW, resumeTarget: NEW, requestedTarget: OLD, hasLiveQuery: true, turnInFlight: false })
  assert.equal(ba.action, 'switch')
  assert.equal(ba.runIn, OLD)
})

t('empty-string targets are treated as absent', () => {
  const d = decideNextSession(live({ resumeTarget: '', requestedTarget: '' }))
  assert.equal(d.action, 'push')
  assert.equal(d.runIn, OLD)
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
