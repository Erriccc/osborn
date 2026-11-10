// Run: npx tsx frontend/tests/switch-blind-ui.test.ts
// BLIND tests for #74 frontend helpers (scope §5 S9/S12, §6 claude_output dedupe).
import assert from 'node:assert/strict'
import { isRedundantFinal } from '../src/lib/claude-output.js'
import { switchPendingReducer, pendingSwitchLabel, switchFailureText } from '../src/lib/switch-ui.js'

let pass = 0, fail = 0
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('PASS', name) } catch (e: any) { fail++; console.log('FAIL', name, '-', String(e?.message).split('\n')[0].slice(0, 300)) }
}
const ids = (...a: string[]) => new Set(a)

t('multi-block: isFinal with a seen messageId is dropped', () => {
  assert.equal(isRedundantFinal({ isFinal: true, messageId: 'm1', text: 'one two' }, { seenMessageIds: ids('m1'), trailingAssistantTexts: ['one', 'two'] }), true)
})
t('isFinal with a different/unseen messageId is kept', () => {
  assert.equal(isRedundantFinal({ isFinal: true, messageId: 'm2', text: 'x' }, { seenMessageIds: ids('m1'), trailingAssistantTexts: ['x'] }), false)
})
t('streaming chunks are never redundant', () => {
  assert.equal(isRedundantFinal({ isStreaming: true, messageId: 'm1', text: 'a' }, { seenMessageIds: ids('m1'), trailingAssistantTexts: ['a'] }), false)
  assert.equal(isRedundantFinal({ messageId: 'm1', text: 'a' }, { seenMessageIds: ids('m1'), trailingAssistantTexts: [] }), false)
})
t('single-block reply unchanged: final with no chunks seen is kept', () => {
  assert.equal(isRedundantFinal({ isFinal: true, messageId: 'solo', text: 'hello' }, { seenMessageIds: ids(), trailingAssistantTexts: [] }), false)
})
t('no messageId: final equal to trailing run (whitespace-normalised) dropped; differing text kept', () => {
  assert.equal(isRedundantFinal({ isFinal: true, text: 'a  b\nc' }, { seenMessageIds: ids(), trailingAssistantTexts: ['a', 'b c'] }), true)
  assert.equal(isRedundantFinal({ isFinal: true, text: 'different' }, { seenMessageIds: ids(), trailingAssistantTexts: ['a'] }), false)
})
t('empty/undefined text and empty trailing: kept, no throw', () => {
  assert.equal(isRedundantFinal({ isFinal: true }, { seenMessageIds: ids(), trailingAssistantTexts: [] }), false)
  assert.equal(isRedundantFinal({ isFinal: true, text: '' }, { seenMessageIds: ids(), trailingAssistantTexts: [''] }), false)
  assert.equal(isRedundantFinal(null as any, { seenMessageIds: ids(), trailingAssistantTexts: [] }), false)
})
t('empty-string messageId behaves as no messageId', () => {
  assert.equal(isRedundantFinal({ isFinal: true, messageId: '', text: 'a' }, { seenMessageIds: ids(''), trailingAssistantTexts: ['a'] }), true)
})
t('rapid switch requests: last pending wins (single state)', () => {
  let s = switchPendingReducer(null, { type: 'pending', sessionId: 'B', now: 1 })
  s = switchPendingReducer(s, { type: 'pending', sessionId: 'C', cwd: '/x', runningTasks: 2, now: 2 })
  s = switchPendingReducer(s, { type: 'pending', sessionId: 'D', now: 3 })
  assert.equal(s?.sessionId, 'D'); assert.equal(s?.runningTasks, 0); assert.equal(s?.cwd, undefined)
})
t('stale cancel for a replaced request is ignored; matching/untargeted cancel clears; switched clears', () => {
  const s = switchPendingReducer(switchPendingReducer(null, { type: 'pending', sessionId: 'B', now: 1 }), { type: 'pending', sessionId: 'C', now: 2 })
  assert.equal(switchPendingReducer(s, { type: 'cancelled', sessionId: 'B' })?.sessionId, 'C')
  assert.equal(switchPendingReducer(s, { type: 'cancelled', sessionId: 'C' }), null)
  assert.equal(switchPendingReducer(s, { type: 'cancelled' }), null)
  assert.equal(switchPendingReducer(s, { type: 'switched' }), null)
  assert.equal(switchPendingReducer(null, { type: 'cancelled', sessionId: 'B' }), null)
})
t('reducer does not mutate prior state', () => {
  const s = switchPendingReducer(null, { type: 'pending', sessionId: 'B', now: 1 })!, snap = JSON.stringify(s)
  switchPendingReducer(s, { type: 'pending', sessionId: 'C', now: 2 }); assert.equal(JSON.stringify(s), snap)
})
t('failure copy: needs_you / meeting_active / target_busy_in_background map to distinct user text; fallbacks', () => {
  const a = switchFailureText({ reason: 'needs_you' }), b = switchFailureText({ reason: 'meeting_active' }), c = switchFailureText({ reason: 'target_busy_in_background' })
  assert.equal(new Set([a, b, c]).size, 3)
  assert.match(b, /meeting/i); assert.match(a, /permission|Switch now/i)
  assert.equal(switchFailureText({ reason: 'weird', error: 'boom' }), 'boom')
  assert.ok(switchFailureText({}).length > 0)
})
t('pending label: singular/plural sub-agents, none when 0', () => {
  assert.ok(!/sub-agent/.test(pendingSwitchLabel('T', 0)))
  assert.match(pendingSwitchLabel('T', 1), /1 sub-agent still/); assert.match(pendingSwitchLabel('T', 3), /3 sub-agents still/)
})
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0)
