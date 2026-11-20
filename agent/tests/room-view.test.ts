// Read-only room view (#383): a `viewer-*` participant watches, never controls.
// Run: npx tsx agent/tests/room-view.test.ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CONTROL_MESSAGE_TYPES,
  READ_ONLY_MESSAGE_TYPES,
  VIEWER_IDENTITY_PREFIX,
  checkControlSender,
  isViewerIdentity,
  resolveJoin,
  roomOccupants,
} from '../src/data-sender-auth.js'

let pass = 0
const t = (name: string, fn: () => unknown) => {
  try { fn(); pass++; console.log('ok   ', name) } catch (e: any) { console.log('FAIL ', name, '\n     ', e.message.split('\n')[0]); process.exitCode = 1 }
}

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'src', 'index.ts'), 'utf8')
const VIEWER = `${VIEWER_IDENTITY_PREFIX}ab12cd34`
const OWNER = 'owner-uid'
const CTRL = 'user-owner'

t('viewer identities are recognised; users, the agent and the canvas are not', () => {
  assert.equal(isViewerIdentity(VIEWER), true)
  for (const id of ['user-viewer-1', 'osborn-agent', 'meeting-canvas', 'sip_+15551234', '', null, undefined]) {
    assert.equal(isViewerIdentity(id as any), false, String(id))
  }
})

t('a viewer is never adopted or made controller, owner configured or not', () => {
  for (const owner of [OWNER, null]) {
    for (const ctrl of [CTRL, null]) {
      // Even with metadata naming the owner (a viewer token never carries one, but the rule does not rely on it).
      for (const uid of [OWNER, undefined]) {
        assert.deepEqual(resolveJoin(VIEWER, uid, owner, ctrl), { adoptSession: false, controller: ctrl })
      }
    }
  }
})

t('a viewer can join while a phone call is live: not adopted, the call keeps the session', () => {
  // The caller holds the session without being the controller (controller null in a phone room).
  assert.deepEqual(resolveJoin(VIEWER, undefined, OWNER, null, { phoneRoom: true }), { adoptSession: false, controller: null })
  assert.deepEqual(resolveJoin(VIEWER, undefined, null, null, { phoneRoom: true }), { adoptSession: false, controller: null })
})

t('a viewer is rejected as a data sender for every type, read-only queries included', () => {
  for (const type of [...CONTROL_MESSAGE_TYPES, ...READ_ONLY_MESSAGE_TYPES, 'some_future_type']) {
    assert.equal(checkControlSender(type, VIEWER, CTRL).ok, false, type)
    // Even if it somehow were recorded as the controller.
    assert.equal(checkControlSender(type, VIEWER, VIEWER).ok, false, type)
  }
})

t('the controller still sends while a viewer watches', () => {
  assert.equal(checkControlSender('user_text', CTRL, CTRL).ok, true)
  assert.equal(checkControlSender('get_busy', 'user-other', CTRL).ok, true)
})

t('viewers do not count as people in the room (leave and idle timers)', () => {
  assert.equal(roomOccupants([VIEWER, `${VIEWER_IDENTITY_PREFIX}2`]), 0)
  assert.equal(roomOccupants([VIEWER, CTRL]), 1)
  assert.equal(roomOccupants([]), 0)
})

// Wiring in index.ts.
const between = (from: string, to: string) => {
  const a = src.indexOf(from)
  assert.ok(a >= 0, `missing: ${from}`)
  const b = src.indexOf(to, a + from.length)
  assert.ok(b > a, `missing after ${from}: ${to}`)
  return src.slice(a, b)
}

t('index.ts: join handler returns for a viewer before anything else runs', () => {
  const head = between('participantConnectedHandler = async (participant: RemoteParticipant) => {', 'keepWorkingRequested = false')
  assert.match(head, /if \(isViewerIdentity\(participant\.identity\)\)[^\n]*return/)
})

t('index.ts: a viewer leaving tears nothing down', () => {
  assert.match(src, /room\.on\(RoomEvent\.ParticipantDisconnected, \(p: RemoteParticipant\) => \{ if \(!isViewerIdentity\(p\.identity\)\) handleParticipantDisconnected\(p\) \}\)/)
  assert.equal(src.match(/RoomEvent\.ParticipantDisconnected/g)?.length, 1, 'the only registration is the guarded one')
})

t('index.ts: leave/idle timers count people with peopleIn, never the raw participant count', () => {
  assert.doesNotMatch(src, /remoteParticipants\.size/)
  assert.match(src, /const peopleIn = \(room: Room \| null\): number => room \? roomOccupants\(/)
})

t('index.ts: the viewer token is hidden, subscribe-only and a viewer-* identity', () => {
  const hook = between('viewTokenHook = async (withToken) => {', 'connectRoomHook = async')
  assert.match(hook, /identity: `\$\{VIEWER_IDENTITY_PREFIX\}/)
  assert.match(hook, /canPublish: false/)
  assert.match(hook, /canPublishData: false/)
  assert.match(hook, /hidden: true/)
  assert.match(hook, /canUpdateOwnMetadata: false/)
  // Minted for whatever room is live, a caller's room included: no connect-room busy check.
  assert.doesNotMatch(hook, /planConnectRoom|busy\(\)/)
})

t('index.ts: /view-token is behind the sync-token gate', () => {
  const route = between("url.pathname === '/view-token'", 'return\n    }')
  assert.match(route, /if \(unauthorized\(\)\) return/)
})

t('frontend proxy forwards view-token (GET only)', () => {
  const proxy = readFileSync(join(here, '..', '..', 'frontend', 'src', 'app', 'api', 'agent', '[...path]', 'route.ts'), 'utf8')
  assert.match(proxy, /PROXYABLE_GET = new Set\(\[[^\]]*'view-token'/)
  assert.doesNotMatch(proxy, /PROXYABLE_POST = new Set\(\[[^\]]*'view-token'/)
})

console.log(`\n${pass} passed${process.exitCode ? ', some FAILED' : ''}`)
