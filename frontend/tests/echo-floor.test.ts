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
  // first track: re-apply the duck level at once and build
  let p = planAgentTrack(A, st, 5000)
  assert.deepStrictEqual(p, { reapplyVolume: true, build: true })
  st = { ...st, seen: A }
  // a failed build is not marked analysed, logs once, and retries only after the gap
  let r = afterAnalyserBuild(st, A, false, 5000); st = r.next
  assert.strictEqual(r.logFailure, true); assert.strictEqual(st.analysed, null)
  assert.strictEqual(planAgentTrack(A, st, 5500).build, false)
  assert.deepStrictEqual(planAgentTrack(A, st, 6100), { reapplyVolume: false, build: true })
  r = afterAnalyserBuild(st, A, false, 6100); st = r.next
  assert.strictEqual(r.logFailure, false, 'same track failing again does not log again')
  r = afterAnalyserBuild(st, A, true, 7200); st = r.next
  assert.strictEqual(st.analysed, A)
  assert.strictEqual(planAgentTrack(A, st, 9000).build, false, 'built: no rebuild')
  // swap mid-duck: new track gets the volume re-applied even though no ramp is running
  p = planAgentTrack(B, st, 9100)
  assert.deepStrictEqual(p, { reapplyVolume: true, build: true })
  // track dropped: nothing to re-apply; the old analyser is released
  st = { ...st, seen: B }
  assert.deepStrictEqual(planAgentTrack(null, st, 9200), { reapplyVolume: false, build: true })
  console.log('PASS agent track wiring')
}
