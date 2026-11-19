// Sensitive data-channel messages only from the controlling user (UI review item 22).
// Run: npx tsx agent/tests/data-sender-auth.test.ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  CONTROL_MESSAGE_TYPES,
  READ_ONLY_MESSAGE_TYPES,
  canBecomeController,
  checkControlSender,
  CONNECT_ROOM_MAX_BODY,
  handlePhoneKeypad,
  isPhoneCallLive,
  isPhoneRoomName,
  keypadAnswer,
  PHONE_KEYPAD_APPROVALS_ENABLED,
  phonePermissionPolicy,
  PHONE_TOOLS_ENABLED,
  phoneToolPolicy,
  planConnectRoom,
  readBodyCapped,
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
  assert.match(src, /resolveJoin\(participant\.identity, joinerUserId, OWNER_USER_ID, controllingUserIdentity, \{ sip: isPhoneCaller, phoneRoom: inPhoneRoom\(\) \}\)/)
  assert.match(src, /const isPhoneCaller = participant\.kind === ParticipantKind\.SIP/)
  assert.match(src, /controllingUserIdentity = join\.controller/)
  assert.match(src, /process\.env\.OSBORN_OWNER_USER_ID/)
})

// Behavioural: replay joins/leaves the way participantConnectedHandler and
// handleParticipantDisconnected do. A '-' prefix is a leave (controller cleared
// if it was the leaver). `session` is who the voice session was last built for.
// A '~' prefix is a SIP (phone) joiner; `phoneRoom` says whether the agent
// joined this room through an authorised phone connect.
type Step = [string, string | undefined]
const replay = (owner: string, steps: Step[], phoneRoom = false) => {
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
    const sip = identity.startsWith('~')
    const d = sip
      ? resolveJoin(identity.slice(1), userId, owner, controller, { sip: true, phoneRoom })
      : resolveJoin(identity, userId, owner, controller, { phoneRoom })
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
// Phone calls (#361): a SIP caller is adopted only in an authorised phone room
// and never becomes the controller, so it can never drive data commands.
for (const owner of ['uid-x', '']) {
  const mode = owner ? 'owner configured' : 'single-tenant'
  t(`${mode}: SIP caller in an authorised phone room is adopted but is not the controller`, () => {
    const r = replay(owner, [['~sip_+15551230000', undefined]], true)
    assert.deepEqual(r.adopts, [true])
    assert.equal(r.controller, null)
    assert.equal(checkControlSender('user_text', 'sip_+15551230000', r.controller).ok, false)
    assert.equal(checkControlSender('permission_response', 'sip_+15551230000', r.controller).ok, false)
  })
  t(`${mode}: SIP caller outside an authorised phone room is ignored`, () => {
    const r = replay(owner, [['~sip_+15551230000', undefined]], false)
    assert.deepEqual(r.adopts, [false])
    assert.equal(r.controller, null)
  })
  t(`${mode}: SIP caller joining after the owner does not take the session or control`, () => {
    const r = replay(owner, [['user-x', 'uid-x'], ['~sip_+15551230000', undefined]], true)
    assert.deepEqual(r.adopts, [true, false])
    assert.equal(r.controller, 'user-x')
    assert.equal(r.session, 'user-x')
    assert.equal(checkControlSender('user_text', 'user-x', r.controller).ok, true)
  })
  t(`${mode}: SIP caller with a user-* identity or the owner's userId never becomes the controller`, () => {
    const r = replay(owner, [['~user-x', 'uid-x']], true)
    assert.equal(r.controller, null)
    const r2 = replay(owner, [['~osborn-agent', undefined]], false)
    assert.deepEqual(r2.adopts, [false])
  })
  t(`${mode}: watch gateway joining a phone call does not take the caller's session`, () => {
    const r = replay(owner, [['~sip_+15551230000', undefined], ['osborn-agent', undefined]], true)
    assert.deepEqual(r.adopts, [true, false])
    assert.equal(r.session, '~sip_+15551230000')
    assert.equal(r.controller, null)
  })
  t(`${mode}: owner joining after a SIP caller takes control (ab9fe45 rules unchanged)`, () => {
    const r = replay(owner, [['~sip_+15551230000', undefined], ['user-x', 'uid-x']], true)
    assert.equal(r.controller, 'user-x')
    assert.equal(r.session, 'user-x')
  })
}
t('isPhoneRoomName: only call- rooms with a safe charset', () => {
  assert.equal(isPhoneRoomName('call-_+15551230000_AbC123'), true)
  assert.equal(isPhoneRoomName('call-x'), true)
  assert.equal(isPhoneRoomName('osborn-abc-123'), false)
  assert.equal(isPhoneRoomName('call-'), true)
  assert.equal(isPhoneRoomName('call-a/b'), false)
  assert.equal(isPhoneRoomName('call- x'), false)
  assert.equal(isPhoneRoomName('call-' + 'a'.repeat(200)), false)
  assert.equal(isPhoneRoomName(undefined), false)
  assert.equal(isPhoneRoomName(42), false)
})
t('keypadAnswer: 1 allows, 2 denies, everything else ignored', () => {
  assert.equal(keypadAnswer('1'), true)
  assert.equal(keypadAnswer('2'), false)
  for (const d of ['0', '3', '9', '*', '#', '', undefined, null]) assert.equal(keypadAnswer(d as any), null, String(d))
})
t('index.ts: /connect-room roomName is behind the sync-token check and validated', () => {
  const start = src.indexOf("url.pathname === '/connect-room'")
  const body = src.slice(start, start + 1500)
  const parsed = body.indexOf('parsed.roomName !== undefined')
  const gate = body.indexOf('if (unauthorized()) return', parsed)
  const valid = body.indexOf('isPhoneRoomName(parsed.roomName)', parsed)
  const hook = body.indexOf('connectRoomHook(phoneRoom)')
  assert.ok(parsed > 0 && gate > parsed && valid > gate && hook > valid, 'roomName must pass unauthorized() then isPhoneRoomName before the hook')
})
t('index.ts: keypad goes through handlePhoneKeypad with the shared settle function', () => {
  const start = src.indexOf('RoomEvent.DtmfReceived')
  const body = src.slice(start, start + 600)
  assert.match(body, /handlePhoneKeypad\(\{ sip: participant\?\.kind === ParticipantKind\.SIP, inPhoneRoom: inPhoneRoom\(\), digit \}, settlePendingPermission\)/)
  assert.doesNotMatch(body, /settlePendingPermission\(true\)/)
  assert.equal((src.match(/target\.respondToPermission\(allow\)/g) || []).length, 1, 'one settle implementation')
})
// Interim (#361): caller ID can be spoofed, so a phone call approves nothing.
t('keypad approvals are off by default', () => {
  assert.equal(PHONE_KEYPAD_APPROVALS_ENABLED, false)
})
t('SIP caller presses 1 while a permission is pending: nothing is approved', () => {
  let pending = true
  const settled: boolean[] = []
  const settle = (allow: boolean) => { if (!pending) return false; settled.push(allow); pending = false; return true }
  assert.equal(handlePhoneKeypad({ sip: true, inPhoneRoom: true, digit: '1' }, settle), 'ignored')
  assert.deepEqual(settled, [])
  assert.equal(pending, true)
  // 2 still denies; other keys and non-callers do nothing.
  for (const press of [{ sip: true, inPhoneRoom: true, digit: '5' }, { sip: false, inPhoneRoom: true, digit: '2' }, { sip: true, inPhoneRoom: false, digit: '2' }]) {
    assert.equal(handlePhoneKeypad(press, settle), 'ignored')
  }
  assert.equal(handlePhoneKeypad({ sip: true, inPhoneRoom: true, digit: '2' }, settle), 'denied')
  assert.deepEqual(settled, [false])
  assert.equal(handlePhoneKeypad({ sip: true, inPhoneRoom: true, digit: '2' }, settle), 'no pending permission')
})
t('with keypad approvals switched on, 1 approves (the slice-2 path is still wired)', () => {
  const settled: boolean[] = []
  assert.equal(handlePhoneKeypad({ sip: true, inPhoneRoom: true, digit: '1' }, (a) => { settled.push(a); return true }, true), 'approved')
  assert.deepEqual(settled, [true])
})
t('phonePermissionPolicy: every permission during a phone call is denied while approvals are off', () => {
  assert.equal(phonePermissionPolicy(true), 'deny')
  assert.equal(phonePermissionPolicy(false), 'ask')
  assert.equal(phonePermissionPolicy(true, true), 'ask')
})
t('index.ts: permission requests in a phone room are denied before the always-allow list or the prompt', () => {
  const start = src.indexOf("directLLM.events.on('permission_request'")
  const deny = src.indexOf("if (phonePermissionPolicy(inPhoneRoom()) === 'deny')", start)
  const respond = src.indexOf('directLLM.respondToPermission(false', deny)
  const allowList = src.indexOf('sessionAlwaysAllowPaths.has(filePath)', start)
  const prompt = src.indexOf("type: 'permission_request'", start)
  assert.ok(start > 0 && deny > start && respond > deny && respond < allowList && allowList < prompt, 'deny must come first')
})

// Fix round 2: a phone call is talk-only; the caller's room never goes to a browser.
t('phone tools are off by default; phoneToolPolicy denies every tool on a call only', () => {
  assert.equal(PHONE_TOOLS_ENABLED, false)
  assert.equal(phoneToolPolicy(true), 'deny')
  assert.equal(phoneToolPolicy(false), 'allow')
  assert.equal(phoneToolPolicy(true, true), 'allow')
})
t('isPhoneCallLive: the authorised phone room with a SIP participant in it, false once the caller leaves', () => {
  assert.equal(isPhoneCallLive('call-abc', 'call-abc', true), true)
  assert.equal(isPhoneCallLive('call-abc', 'call-abc', false), false, 'caller left')
  assert.equal(isPhoneCallLive('call-abc', null, true), false, 'phone room cleared')
  assert.equal(isPhoneCallLive(null, 'call-abc', true), false, 'room session destroyed')
  assert.equal(isPhoneCallLive('osborn-x-1', 'call-abc', true), false, 'another room')
})
t('planConnectRoom: a browser connect during a live phone call is busy, never the caller\'s room', () => {
  assert.equal(planConnectRoom({ activeRoomName: 'call-abc', occupied: true, phoneCallLive: true }), 'busy')
  // No phone call: the browser reuses an occupied room or gets a fresh one.
  assert.equal(planConnectRoom({ activeRoomName: 'osborn-x-1', occupied: true, phoneCallLive: false }), 'reuse')
  assert.equal(planConnectRoom({ activeRoomName: 'osborn-x-1', occupied: false, phoneCallLive: false }), 'fresh')
  assert.equal(planConnectRoom({ activeRoomName: null, occupied: false, phoneCallLive: false }), 'fresh')
  // The caller has left and the call room is empty: torn down, fresh room.
  assert.equal(planConnectRoom({ activeRoomName: 'call-abc', occupied: false, phoneCallLive: false }), 'fresh')
})
t('planConnectRoom: phone connects keep their rules', () => {
  assert.equal(planConnectRoom({ activeRoomName: 'osborn-x-1', occupied: true, phoneCallLive: false, phoneRoom: 'call-abc' }), 'busy')
  assert.equal(planConnectRoom({ activeRoomName: 'call-abc', occupied: true, phoneCallLive: true, phoneRoom: 'call-abc' }), 'reuse')
  assert.equal(planConnectRoom({ activeRoomName: 'osborn-x-1', occupied: false, phoneCallLive: false, phoneRoom: 'call-abc' }), 'fresh')
})
t('index.ts: connect-room plans with planConnectRoom; a browser never gets a call- room back', () => {
  const start = src.indexOf('connectRoomHook = async (phoneRoom?: string)')
  const body = src.slice(start, start + 4000)
  assert.ok(start > 0)
  assert.match(body, /planConnectRoom\(\{/)
  assert.match(body, /phoneCallLive: inPhoneRoom\(\) \|\| isPhoneRoomName\(activeRoomName\)/)
  assert.match(body, /if \(plan === 'busy'\)[\s\S]{0,200}throw busy\(\)/)
  assert.match(body, /if \(!phoneRoom && isPhoneRoomName\(activeRoomName\)\) throw busy\(\)/)
})
t('index.ts: inPhoneRoom needs a SIP participant; phoneRoomName clears on caller leave and room destroy', () => {
  assert.match(src, /const inPhoneRoom = \(\) => isPhoneCallLive\([\s\S]{0,200}p\.kind === ParticipantKind\.SIP/)
  const leave = src.indexOf('const handleParticipantDisconnected')
  const leaveBody = src.slice(leave, leave + 6000)
  assert.match(leaveBody, /const phoneCallerLeft = participant\.kind === ParticipantKind\.SIP\s+if \(phoneCallerLeft\) phoneRoomName = null/)
  assert.match(leaveBody, /KEEP_WARM && currentLLM && \(currentLLM as any\)\.sessionId && !phoneCallerLeft/, 'a caller\'s brain is never parked')
  const destroy = src.indexOf('const destroyRoomSession = async')
  assert.match(src.slice(destroy, destroy + 1500), /activeRoomName = null\s+phoneRoomName = null/)
})
t('index.ts: each voice session sets the tool-deny flag from inPhoneRoom()', () => {
  const start = src.indexOf('async function createDirectSession(')
  const body = src.slice(start, start + 2500)
  const set = body.indexOf('directLLM?.setPhoneCall?.(inPhoneRoom())')
  const assign = body.indexOf('currentLLM = directLLM')
  assert.ok(set > 0 && assign > set, 'flag set before the LLM goes live')
})
t('index.ts: /connect-room reads a capped body and answers 413', () => {
  const start = src.indexOf("url.pathname === '/connect-room'")
  const body = src.slice(start, start + 800)
  assert.match(body, /readBodyCapped\(req\.iterator\(\{ destroyOnReturn: false \}\), CONNECT_ROOM_MAX_BODY\)/)
  assert.match(body, /res\.writeHead\(413/)
  assert.doesNotMatch(body, /for await \(const chunk of req\)/)
})
t('index.ts: the spoken permission prompt stays commented out', () => {
  assert.match(src, /\/\/ if \(currentSession\) \{\n\s*\/\/   const ttsMessage/)
})
t('index.ts: gateway not adopted returns before the session teardown', () => {
  const start = src.indexOf('const join = resolveJoin(')
  const bail = src.indexOf('if (!join.adoptSession)', start)
  const teardown = src.indexOf('currentSession.close()', start)
  const uid = src.indexOf("currentUserId = ''", start)
  assert.ok(start > 0 && bail > start && bail < teardown && bail < uid, 'adoptSession=false must return before teardown and currentUserId reset')
})

// /connect-room body cap, through a real HTTP server wired the way index.ts is.
const ta = async (name: string, fn: () => Promise<unknown>) => {
  try { await fn(); pass++; console.log('ok   ', name) } catch (e: any) { console.log('FAIL ', name, '\n     ', e.message.split('\n')[0]); process.exitCode = 1 }
}
await ta('readBodyCapped: 4 KB cap, 413 over it, body intact under it', async () => {
  assert.equal(CONNECT_ROOM_MAX_BODY, 4096)
  const server = createServer(async (req, res) => {
    const raw = await readBodyCapped(req.iterator({ destroyOnReturn: false }), CONNECT_ROOM_MAX_BODY)
    if (raw === null) {
      res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' })
      res.end(JSON.stringify({ ok: false, error: 'body too large' }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ got: raw }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const small = JSON.stringify({ roomName: 'call-x' })
    const r1 = await fetch(base, { method: 'POST', body: small })
    assert.equal(r1.status, 200)
    assert.equal((await r1.json()).got, small)
    const atCap = 'a'.repeat(4096)
    assert.equal((await fetch(base, { method: 'POST', body: atCap })).status, 200)
    const r2 = await fetch(base, { method: 'POST', body: 'a'.repeat(4097) })
    assert.equal(r2.status, 413)
    const r3 = await fetch(base, { method: 'POST', body: 'a'.repeat(5 * 1024 * 1024) })
    assert.equal(r3.status, 413)
  } finally {
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
  }
})

console.log(`\n${pass} passed${process.exitCode ? ', some FAILED' : ''}`)
