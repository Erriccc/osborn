/**
 *   npx tsx --test lib/vision-retry.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { VISION_KILL_ENV, shouldRetryWithVision, viewportMatches, summarizeVision, visionGate, visionInstruction } from './vision-retry.ts'

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

const call = (toolName: string) => ({ type: 'tool-call', toolName })
const shot = (ok = true) => ({ role: 'tool', content: [{ type: 'tool-result', toolName: 'screenshot', output: { value: ok ? [{ type: 'media', mediaType: 'image/png', data: 'x' }] : [{ type: 'text', text: '{"success":false}' }] } }] })
const looked = (ok = true) => [{ role: 'user', content: 'go' }, { role: 'assistant', content: [call('screenshot')] }, shot(ok), { role: 'assistant', content: [call('click')] }]

test('counts exactly one successful click, type or keys press made after a screenshot that returned an image', () => {
  assert.deepEqual(summarizeVision(null), { acted: false, ran: false, did: '', note: '' })
  const click = { type: 'click', describe: 'the Play button', coordinates: [10, 20], success: true }
  const s = summarizeVision({ actions: [{ type: 'screenshot' }, click], messages: looked() })
  assert.equal(s.acted, true)
  assert.match(s.did, /^vision \(click\): the Play button at \(10,20\)/)
  assert.equal(summarizeVision({ actions: [{ type: 'screenshot' }, { type: 'done' }] }).ran, false)
  assert.equal(summarizeVision({ success: false, message: 'model refused', actions: [] }).note, 'model refused')
  // the screenshot failed (no image), or there is nothing to tell: not looked
  assert.equal(summarizeVision({ actions: [{ type: 'screenshot' }, click], messages: looked(false) }).acted, false)
  assert.deepEqual([summarizeVision({ actions: [{ type: 'screenshot' }, click] }).acted, summarizeVision({ actions: [{ type: 'screenshot' }, click] }).ran], [false, true])
  // a failed interaction did nothing
  for (const bad of [{ type: 'click', success: false }, { type: 'click', error: 'no element' }]) {
    const f = summarizeVision({ actions: [{ type: 'screenshot' }, bad], messages: looked() })
    assert.deepEqual([f.acted, f.ran], [false, false])
  }
})

test('anything but one click, type or keys press ran but is not counted', () => {
  for (const actions of [
    [{ type: 'screenshot' }, { type: 'scroll', success: true }],
    [{ type: 'screenshot' }, { type: 'goto' }],
    [{ type: 'screenshot' }, { type: 'dragAndDrop' }],
    [{ type: 'screenshot' }, { type: 'act' }],
    [{ type: 'screenshot' }, { type: 'click', success: true }, { type: 'type', success: true }],
  ]) {
    const s = summarizeVision({ actions, messages: looked() })
    assert.deepEqual([s.acted, s.ran], [false, true], JSON.stringify(actions))
    assert.match(s.note, /the retry ran /)
  }
  assert.match(summarizeVision({ actions: [{ type: 'act' }] }).note, /unverified/)
})

test('the instruction keeps the original text, looks first and asks for one interaction', () => {
  const t = visionInstruction('click the Play button')
  assert.match(t, /click the Play button/)
  assert.match(t, /First take a screenshot/)
  assert.match(t, /single interaction/)
})

test('an interaction sent in the same model step as the screenshot is blind', () => {
  const actions = [{ type: 'screenshot' }, { type: 'click', describe: 'Play', success: true }]
  const same = [{ role: 'user', content: 'go' }, { role: 'assistant', content: [call('screenshot'), call('click')] }, shot()]
  const s = summarizeVision({ actions, messages: same })
  assert.deepEqual([s.acted, s.ran], [false, true])
  assert.match(s.note, /without a screenshot/)
})

test('conditional and destructive instructions are skipped unless vision:true is sent', () => {
  for (const instruction of ['If a cookie banner shows, close it, otherwise do nothing', 'click Delete account', 'Submit the form', 'sign out', 'unless it is open, press Play']) {
    assert.deepEqual(visionGate({ instruction }, {}), { enabled: false, why: 'instruction' }, instruction)
    assert.equal(visionGate({ instruction, vision: true }, {}).enabled, true, instruction)
  }
  for (const instruction of ['Pay with PayPal', 'Place order', 'Checkout', 'Publish the post', 'Logout', 'Sign-out', 'Cancel subscription']) assert.equal(visionGate({ instruction }, {}).enabled, false, instruction)
  assert.equal(visionGate({ instruction: 'click the Play button' }, {}).enabled, true)
  assert.equal(visionGate({ instruction: 'delete it', vision: true }, { [VISION_KILL_ENV]: '1' }).enabled, false)  // the kill switch wins
})

test('only a tab at the brain\'s viewport is retried', () => {
  assert.equal(viewportMatches({ width: 1288, height: 711 }, { width: 1288, height: 711 }), true)
  assert.equal(viewportMatches({ width: 1280, height: 720 }, { width: 1288, height: 711 }), true)  // the engine's default tab
  assert.equal(viewportMatches({ width: 1024, height: 768 }, { width: 1288, height: 711 }), false)
  assert.equal(viewportMatches({ width: 390, height: 844 }, { width: 1288, height: 711 }), false)
  assert.equal(viewportMatches(null, { width: 1288, height: 711 }), false)
})
