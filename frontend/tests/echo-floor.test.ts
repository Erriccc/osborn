// Run: cd frontend && npx --yes tsx tests/echo-floor.test.ts
// The barge-in duck's echo floor stays within (0, ONSET_MAX / 3] however it is fed (#242).
import assert from 'node:assert'
import { FLOOR_MAX, ONSET_MAX, ONSET_MIN, duckOnset, learnEchoFloor, liftEchoFloor } from '../src/lib/echo-floor'

// 30 s of sound just under the onset while the agent plays: the floor walks up to its cap, never past it.
let floor = FLOOR_MAX
for (let i = 0; i < 30 * 60; i++) floor = learnEchoFloor(floor, 0.039, 1000 / 60)
assert.ok(floor <= FLOOR_MAX + 1e-12, `floor ${floor} left its range`)
assert.equal(duckOnset(floor), ONSET_MAX)

// Quiet echo still teaches it down, and the onset never drops under its minimum.
for (let i = 0; i < 5 * 60; i++) floor = learnEchoFloor(floor, 0.002, 1000 / 60)
assert.ok(floor < 0.003, `floor ${floor} did not fall with quiet echo`)
assert.equal(duckOnset(floor), ONSET_MIN)

// The restore lift raises the floor toward what tripped it, capped like learning.
assert.equal(liftEchoFloor(0.005, 0.02), 0.008)
assert.equal(liftEchoFloor(0.005, 0.09), FLOOR_MAX)
assert.equal(liftEchoFloor(0.01, 0.001), 0.01, 'a lift never lowers the floor')
console.log('echo-floor: all assertions passed')

// #229 / #231: duck timing log and agent-track handling (pure decisions behind VoiceRoom's loop)
import { bargeInTiming, shouldBuildAnalyser, trackSwapped } from '../src/lib/echo-floor'
{
  const eq: typeof assert.strictEqual = (a, b, m?) => assert.strictEqual(a, b, m)
  eq(bargeInTiming(0, 1000, 1500), null, 'no duck: natural stop logs nothing')
  eq(bargeInTiming(1650, 1000, 1500), 'barge-in timing: duck 650ms, agent stopped 500ms after your voice')
  eq(bargeInTiming(1650, 1000, 900), 'barge-in timing: duck 650ms, agent was already quiet', 'stale heard-at is not a fake 0ms')
  eq(bargeInTiming(1100, 1000, 1000), 'barge-in timing: duck 100ms, agent stopped 0ms after your voice', 'heard exactly at onset is a real 0')
  const A = {}, B = {}
  eq(trackSwapped(B, A), true, 'swap detected so the duck volume is re-applied')
  eq(trackSwapped(A, A), false)
  eq(trackSwapped(null, A), true)
  eq(shouldBuildAnalyser(A, null, 5000, 0), true, 'new track: build')
  eq(shouldBuildAnalyser(A, A, 9000, 0), false, 'already analysed: no rebuild')
  eq(shouldBuildAnalyser(A, null, 5500, 5000), false, 'failed build: wait for the retry gap')
  eq(shouldBuildAnalyser(A, null, 6100, 5000), true, 'failed build: retried after 1s')
  console.log('PASS duck timing + track handling')
}

import { afterAnalyserBuild, planAgentTrack, type AgentTrackState } from '../src/lib/echo-floor'
{
  const A = {}, B = {}
  let st: AgentTrackState = { seen: null, analysed: null, failedFor: null, triedAt: 0 }
  // One frame as VoiceRoom's agentLevel runs it: plan, carry the plan's state, then the build outcome.
  const frame = (t: unknown, now: number, ok: boolean) => {
    const p = planAgentTrack(t, st, now); st = p.next
    const r = p.build ? afterAnalyserBuild(st, t, ok, now) : null
    if (r) st = r.next
    return { reapply: p.reapplyVolume, build: p.build, log: !!r?.logFailure }
  }
  const eq = (a: unknown, b: unknown, m?: string) => assert.deepStrictEqual(a, b, m)
  eq(frame(A, 5000, false), { reapply: true, build: true, log: true }, 'first track: duck level re-applied at once; failure logged')
  eq(st.analysed, null, 'a failed build is not marked analysed')
  eq(frame(A, 5500, true), { reapply: false, build: false, log: false }, 'repeated frame: no re-apply, retry waits for the gap')
  eq(frame(A, 6100, false), { reapply: false, build: true, log: false }, 'retried after 1s; same track failing again logs nothing')
  eq(frame(A, 7200, true), { reapply: false, build: true, log: false })
  eq(st.analysed, A)
  eq(frame(A, 9000, true), { reapply: false, build: false, log: false }, 'built: no rebuild')
  eq(frame(B, 9100, true), { reapply: true, build: true, log: false }, 'swap mid-duck: the new track gets the duck level')
  eq(frame(null, 10200, false), { reapply: false, build: true, log: false }, 'track dropped: analyser released, nothing re-applied, no failure logged')
  eq(st.failedFor, A, 'a dropped track does not reset the once-per-track log')
  eq(frame(null, 11300, false), { reapply: false, build: false, log: false }, 'still dropped: nothing to do')
  console.log('PASS agent track wiring')
}
