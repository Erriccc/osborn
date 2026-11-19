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
