/**
 *   npx tsx --test lib/vision-retry.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { VISION_KILL_ENV, shouldRetryWithVision, summarizeVision, visionGate, visionInstruction } from './vision-retry.ts'

test('on by default, off for one call or by the env switch', () => {
  assert.deepEqual(visionGate({}, {}), { enabled: true })
  assert.deepEqual(visionGate(undefined, {}), { enabled: true })
  assert.deepEqual(visionGate({ vision: true }, {}), { enabled: true })
  assert.deepEqual(visionGate({ vision: false }, {}), { enabled: false, why: 'request' })
  assert.deepEqual(visionGate({}, { [VISION_KILL_ENV]: '1' }), { enabled: false, why: 'env' })
  assert.deepEqual(visionGate({ vision: true }, { [VISION_KILL_ENV]: '1' }), { enabled: false, why: 'env' })
  assert.equal(visionGate({}, { [VISION_KILL_ENV]: 'true' }).enabled, true)  // only '1', like OSBORN_BRAIN_STUB
  assert.equal(visionGate({}, { [VISION_KILL_ENV]: '0' }).enabled, true)
  assert.equal(visionGate({}, { [VISION_KILL_ENV]: '' }).enabled, true)
  assert.equal(visionGate({ vision: 'false' }, {}).enabled, true)  // only the boolean opts out
})

test('retries only a brain no-op', () => {
  const on = { enabled: true }
  assert.equal(shouldRetryWithVision({ noop: true }, on), true)
  assert.equal(shouldRetryWithVision({ noop: false }, on), false)
  assert.equal(shouldRetryWithVision({ noop: true, engine: true }, on), false)
  assert.equal(shouldRetryWithVision(undefined, on), false)
  assert.equal(shouldRetryWithVision({ noop: true }, { enabled: false, why: 'env' }), false)
})

test('a vision attempt counts as acted only after looking, and only when the tool succeeded', () => {
  assert.deepEqual(summarizeVision(null), { acted: false, did: '' })
  assert.equal(summarizeVision({ actions: [{ type: 'screenshot' }, { type: 'done' }] }).acted, false)
  const s = summarizeVision({ actions: [{ type: 'screenshot' }, { type: 'think' }, { type: 'click', describe: 'the Play button', success: true }] })
  assert.equal(s.acted, true)
  assert.match(s.did, /^vision \(click\): the Play button/)
  assert.deepEqual(summarizeVision({ actions: [{ type: 'click', describe: 'x' }, { type: 'screenshot' }] }), { acted: false, did: '', blind: true })
  assert.equal(summarizeVision({ actions: [{ type: 'screenshot' }, { type: 'click', success: false }] }).acted, false)
  assert.equal(summarizeVision({ actions: [{ type: 'screenshot' }, { type: 'click', error: 'no element' }] }).acted, false)
  // a failed click followed by a good one still counts, from the good one
  assert.match(summarizeVision({ actions: [{ type: 'screenshot' }, { type: 'click', success: false }, { type: 'type', describe: 'a field' }] }).did, /vision \(type\): a field/)
})

test('the instruction keeps the original text, looks first and asks for one interaction', () => {
  const t = visionInstruction('click the Play button')
  assert.match(t, /click the Play button/)
  assert.match(t, /First take a screenshot/)
  assert.match(t, /single interaction/)
})
