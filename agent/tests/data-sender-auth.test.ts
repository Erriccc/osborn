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
  resolveJoin,
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
  assert.equal(checkControlSender('skill_get', 'user-other', CTRL).ok, true)
})
t('user_text / list_sessions / set_agents / skill changes / agent prompts from a non-controller are dropped', () => {
  assert.equal(checkControlSender('user_text', 'user-other', CTRL).ok, false)
  assert.equal(checkControlSender('list_sessions', 'user-other', CTRL).ok, false)
  assert.equal(checkControlSender('set_agents', 'user-other', CTRL).ok, false)
  for (const ty of ['skill_add', 'skill_fork', 'skill_remove', 'get_agent_prompt']) assert.equal(checkControlSender(ty, 'user-other', CTRL).ok, false, ty)
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
t('index.ts: controller cleared on leave', () => {
  assert.match(src, /if \(participant\.identity === controllingUserIdentity\) controllingUserIdentity = null/)
})
t('index.ts: join wiring uses resolveJoin with the configured owner', () => {
  assert.match(src, /resolveJoin\(participant\.identity, joinerUserId, OWNER_USER_ID, controllingUserIdentity\)/)
  assert.match(src, /controllingUserIdentity = join\.controller/)
  assert.match(src, /process\.env\.OSBORN_OWNER_USER_ID/)
})

// Behavioural: replay joins/leaves the way participantConnectedHandler and
// handleParticipantDisconnected do. A '-' prefix is a leave (controller cleared
// if it was the leaver). `session` is who the voice session was last built for.
type Step = [string, string | undefined]
const replay = (owner: string, steps: Step[]) => {
  let controller: string | null = null
  let session: string | null = null
  const sessions: string[] = []
  const adopts: boolean[] = []
  for (const [identity, userId] of steps) {
    if (identity.startsWith('-')) {
      const who = identity.slice(1)
      if (who === controller) controller = null
      session = null // handleParticipantDisconnected closes currentSession on any leave
      continue
    }
    const d = resolveJoin(identity, userId, owner, controller)
    controller = d.controller
    adopts.push(d.adoptSession)
    if (d.adoptSession) { sessions.push(identity); session = identity }
  }
  return { controller, sessions, session, adopts }
}
for (const owner of ['uid-x', '']) {
  const mode = owner ? 'owner configured' : 'single-tenant'
  t(`${mode}: owner user-x joins, then osborn-agent joins -> not adopted, user-x keeps session + control`, () => {
    const { controller, sessions, session, adopts } = replay(owner, [['user-x', 'uid-x'], ['osborn-agent', undefined]])
    assert.deepEqual(adopts, [true, false], 'osborn-agent must not rebuild the session over the owner')
    assert.equal(controller, 'user-x')
    assert.deepEqual(sessions, ['user-x'])
    assert.equal(session, 'user-x')
    assert.equal(checkControlSender('user_text', 'user-x', controller).ok, true)
    assert.equal(checkControlSender('resume_session', 'user-x', controller).ok, true)
    assert.equal(checkControlSender('user_text', 'osborn-agent', controller).ok, false)
    assert.equal(checkControlSender('permission_response', 'osborn-agent', controller).ok, true)
  })
  t(`${mode}: osborn-agent alone is adopted (watch voice path) but is not the controller`, () => {
    const { controller, sessions, adopts } = replay(owner, [['osborn-agent', undefined]])
    assert.deepEqual(adopts, [true])
    assert.deepEqual(sessions, ['osborn-agent'])
    assert.equal(controller, null)
    assert.equal(checkControlSender('user_text', 'osborn-agent', controller).ok, false)
    assert.equal(checkControlSender('permission_response', 'osborn-agent', controller).ok, true)
  })
  t(`${mode}: osborn-agent alone, then owner joins -> owner takes session + control`, () => {
    const { controller, session, adopts } = replay(owner, [['osborn-agent', undefined], ['user-x', 'uid-x']])
    assert.deepEqual(adopts, [true, true])
    assert.equal(controller, 'user-x')
    assert.equal(session, 'user-x')
  })
  // Documented behaviour when the owner leaves while osborn-agent stays:
  // the controller is cleared and the voice session is closed (the leave
  // handler tears it down). osborn-agent fires no new join, so it is NOT
  // re-adopted: there is no voice session until someone joins again. Gated
  // commands are dropped (no controller); watch approvals still pass. If the
  // gateway reconnects it is adopted (no controller); if the owner rejoins,
  // the owner takes the session and control back.
  t(`${mode}: owner leaves while osborn-agent remains -> no controller, no session, approvals still pass`, () => {
    const steps: Step[] = [['user-x', 'uid-x'], ['osborn-agent', undefined], ['-user-x', undefined]]
    const r = replay(owner, steps)
    assert.equal(r.controller, null)
    assert.equal(r.session, null)
    assert.equal(checkControlSender('user_text', 'osborn-agent', r.controller).ok, false)
    assert.equal(checkControlSender('permission_response', 'osborn-agent', r.controller).ok, true)
    const gw = replay(owner, [...steps, ['osborn-agent', undefined]])
    assert.equal(gw.adopts.at(-1), true, 'gateway reconnecting alone gets the watch voice session')
    assert.equal(gw.controller, null)
    const back = replay(owner, [...steps, ['user-x', 'uid-x']])
    assert.equal(back.controller, 'user-x')
    assert.equal(back.session, 'user-x')
  })
}
t('owner configured: non-owner user joining after the owner gets no session and no control', () => {
  const { controller, sessions } = replay('uid-x', [['user-x', 'uid-x'], ['user-evil', 'uid-evil']])
  assert.equal(controller, 'user-x')
  assert.deepEqual(sessions, ['user-x'])
  assert.equal(checkControlSender('user_text', 'user-evil', controller).ok, false)
})
t('single-tenant: newest user joiner still takes control', () => {
  const { controller } = replay('', [['user-a', undefined], ['user-b', undefined]])
  assert.equal(controller, 'user-b')
})
t('index.ts: gateway not adopted returns before the session teardown', () => {
  const start = src.indexOf('const join = resolveJoin(')
  const bail = src.indexOf('if (!join.adoptSession)', start)
  const teardown = src.indexOf('currentSession.close()', start)
  const uid = src.indexOf("currentUserId = ''", start)
  assert.ok(start > 0 && bail > start && bail < teardown && bail < uid, 'adoptSession=false must return before teardown and currentUserId reset')
})

console.log(`\n${pass} passed${process.exitCode ? ', some FAILED' : ''}`)
