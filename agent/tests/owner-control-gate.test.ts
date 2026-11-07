// Owner-bound control gate. Written from spec only (TDD), not from the implementation.
// Run: cd /workspace/osborn && npx tsx agent/tests/owner-control-gate.test.ts
import assert from 'node:assert/strict'
import * as mod from '../src/data-sender-auth.js'

const { checkControlSender } = mod
let pass = 0, fail = 0
const t = (name: string, fn: () => unknown) => {
  try { fn(); pass++; console.log('ok   ', name) } catch (e: any) { fail++; console.log('FAIL ', name, '\n     ', String(e.message).split('\n')[0]) }
}

const CTRL = 'user-sess-123'
const OTHER = 'user-other'

const STATE_CHANGING = [
  'user_text', 'spawn_background_session', 'dispatch_background', 'stop_background_session',
  'set_agents', 'mcp_toggle', 'start_ide', 'join_meeting', 'leave_meeting', 'resume_session',
  'switch_session', 'continue_session', 'session_selected', 'claude_auth_code', 'permission_response',
  'add_skill', 'remove_skill',
]

for (const type of STATE_CHANGING) {
  t(`${type}: dropped from a non-controller user`, () => {
    assert.equal(checkControlSender(type, OTHER, CTRL).ok, false)
  })
  t(`${type}: dropped from meeting-canvas`, () => {
    assert.equal(checkControlSender(type, 'meeting-canvas', CTRL).ok, false)
  })
  t(`${type}: dropped with no sender`, () => {
    assert.equal(checkControlSender(type, undefined, CTRL).ok, false)
  })
  t(`${type}: dropped when there is no controller`, () => {
    assert.equal(checkControlSender(type, OTHER, null).ok, false)
  })
  t(`${type}: accepted from the controller`, () => {
    assert.equal(checkControlSender(type, CTRL, CTRL).ok, true)
  })
}

t('fail closed: unknown/new state-changing type from non-controller is blocked', () => {
  assert.equal(checkControlSender('brand_new_mutating_type_xyz', OTHER, CTRL).ok, false)
})
t('unknown type from the controller is accepted', () => {
  assert.equal(checkControlSender('brand_new_mutating_type_xyz', CTRL, CTRL).ok, true)
})

// ---- B. Controller bound to owner ----
// SPEC-EXPECTATION: the exact helper name is unknown. We accept any of these
// exported pure functions with signature (participantUserId, ownerUserId) => boolean.
const helperName = ['canBecomeController', 'isEligibleController', 'shouldBecomeController', 'isOwnerParticipant']
  .find(n => typeof (mod as any)[n] === 'function')
t('SPEC-EXPECTATION: an owner-binding helper is exported from data-sender-auth.ts', () => {
  assert.ok(helperName, 'none of canBecomeController/isEligibleController/shouldBecomeController/isOwnerParticipant exported')
})
if (helperName) {
  const f = (mod as any)[helperName] as (p: string | undefined | null, owner: string | null | undefined) => boolean
  t('owner configured, matching userId -> eligible', () => assert.equal(f('uid-A', 'uid-A'), true))
  t('owner configured, different userId -> never controller', () => assert.equal(f('uid-B', 'uid-A'), false))
  t('owner configured, missing participant userId -> not controller', () => assert.equal(f(undefined, 'uid-A'), false))
  t('no owner configured (single-tenant) -> newest joiner may control', () => {
    assert.equal(f('uid-B', null), true)
    assert.equal(f('uid-B', undefined), true)
    assert.equal(f('uid-B', ''), true)
  })
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
