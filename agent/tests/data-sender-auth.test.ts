// Sensitive data-channel messages only from the controlling user (UI review item 22).
// Run: npx tsx agent/tests/data-sender-auth.test.ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CONTROL_MESSAGE_TYPES,
  READ_ONLY_MESSAGE_TYPES,
  canBecomeController,
  checkControlSender,
  userIdFromMetadata,
} from '../src/data-sender-auth.js'

let pass = 0
const t = (name: string, fn: () => unknown) => {
  try { fn(); pass++; console.log('ok   ', name) } catch (e: any) { console.log('FAIL ', name, '\n     ', e.message.split('\n')[0]); process.exitCode = 1 }
}

const CTRL = 'user-sess-123'

t('claude_auth_code from the controlling user is accepted', () => {
  assert.equal(checkControlSender('claude_auth_code', CTRL, CTRL).ok, true)
})
t('claude_auth_code from meeting-canvas is dropped', () => {
  assert.equal(checkControlSender('claude_auth_code', 'meeting-canvas', CTRL).ok, false)
})
t('claude_auth_code from another user identity is dropped', () => {
  assert.equal(checkControlSender('claude_auth_code', 'user-other', CTRL).ok, false)
})
t('claude_auth_code from a bot / unknown identity is dropped', () => {
  assert.equal(checkControlSender('claude_auth_code', 'recall-bot', CTRL).ok, false)
})
t('claude_auth_code from the agent identity is dropped (watch path is approvals only)', () => {
  assert.equal(checkControlSender('claude_auth_code', 'osborn-agent', CTRL).ok, false)
})
t('claude_auth_code with no sender participant is dropped', () => {
  assert.equal(checkControlSender('claude_auth_code', undefined, CTRL).ok, false)
})
t('claude_auth_code with no controlling participant is dropped', () => {
  assert.equal(checkControlSender('claude_auth_code', CTRL, null).ok, false)
})
t('permission_response from the controlling user is accepted', () => {
  assert.equal(checkControlSender('permission_response', CTRL, CTRL).ok, true)
})
t('permission_response from a non-controller user is dropped', () => {
  assert.equal(checkControlSender('permission_response', 'user-other', CTRL).ok, false)
})
t('permission_response from meeting-canvas is dropped', () => {
  assert.equal(checkControlSender('permission_response', 'meeting-canvas', CTRL).ok, false)
})
t('permission_response from osborn-agent (watch gateway) is accepted', () => {
  assert.equal(checkControlSender('permission_response', 'osborn-agent', CTRL).ok, true)
})
t('read-only queries are not gated', () => {
  assert.equal(checkControlSender('get_current_session', undefined, null).ok, true)
  assert.equal(checkControlSender('get_skills', 'user-other', CTRL).ok, true)
})
t('user_text / list_sessions / skill_add from a non-controller are dropped', () => {
  assert.equal(checkControlSender('user_text', 'user-other', CTRL).ok, false)
  assert.equal(checkControlSender('list_sessions', 'user-other', CTRL).ok, false)
  assert.equal(checkControlSender('skill_add', 'user-other', CTRL).ok, false)
  assert.equal(checkControlSender('skill_remove', 'user-other', CTRL).ok, false)
})
t('every type handleDataReceived handles is either gated or explicitly read-only', () => {
  const s = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.ts'), 'utf8')
  const start = s.indexOf('const handleDataReceived = async')
  const types = new Set([...s.slice(start).matchAll(/data\.type === '([a-z_]+)'/g)].map((m) => m[1]))
  const unknown = [...types].filter((ty) => !CONTROL_MESSAGE_TYPES.has(ty) && !READ_ONLY_MESSAGE_TYPES.has(ty))
  assert.deepEqual(unknown, [], `unclassified types: ${unknown.join(', ')}`)
})
t('canBecomeController: owner-bound, single-tenant fallback', () => {
  assert.equal(canBecomeController('uid-A', 'uid-A'), true)
  assert.equal(canBecomeController('uid-B', 'uid-A'), false)
  assert.equal(canBecomeController(undefined, 'uid-A'), false)
  assert.equal(canBecomeController('uid-B', ''), true)
})
t('userIdFromMetadata reads the token metadata userId', () => {
  assert.equal(userIdFromMetadata(JSON.stringify({ userId: 'uid-A', provider: 'x' })), 'uid-A')
  assert.equal(userIdFromMetadata(JSON.stringify({ userId: '' })), undefined)
  assert.equal(userIdFromMetadata('not json'), undefined)
  assert.equal(userIdFromMetadata(undefined), undefined)
})

// Wiring: handleDataReceived runs the check before any branch, and the
// controller is tracked on join/leave.
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.ts'), 'utf8')
t('index.ts: handleDataReceived checks the sender before claude_auth_code', () => {
  const start = src.indexOf('const handleDataReceived = async')
  assert.ok(start > 0, 'handleDataReceived not found')
  const body = src.slice(start, start + 2000)
  const check = body.indexOf('checkControlSender(')
  const auth = body.indexOf("data.type === 'claude_auth_code'")
  assert.ok(check > 0 && auth > 0 && check < auth, 'checkControlSender must run before the claude_auth_code branch')
  assert.match(body, /participant\?\.identity/)
})
t('index.ts: controller set on join and cleared on leave', () => {
  assert.match(src, /controllingUserIdentity = participant\.identity/)
  assert.match(src, /if \(participant\.identity === controllingUserIdentity\) controllingUserIdentity = null/)
})
t('index.ts: owner check runs before the joiner becomes controller', () => {
  const owner = src.indexOf('canBecomeController(joinerUserId, OWNER_USER_ID)')
  const assign = src.indexOf('controllingUserIdentity = participant.identity')
  assert.ok(owner > 0 && assign > owner, 'canBecomeController must gate the controller assignment')
  assert.match(src, /process\.env\.OSBORN_OWNER_USER_ID/)
})

console.log(`\n${pass} passed${process.exitCode ? ', some FAILED' : ''}`)
