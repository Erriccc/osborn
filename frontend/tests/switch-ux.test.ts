// Run: cd frontend && npx tsx tests/switch-ux.test.ts
// #74 phase 2 frontend (session-switch-scope.md S8–S12):
//   S8  /session-messages query carries the session's cwd
//   S9  switch UX: cwd sent, pending/cancel handlers, history replaced via fetch
//   S10 Rooms "Switching…" row state
//   S11 URL pin prefers the agent-reported workingDirectory
//   S12 duplicate assistant bubble (isFinal) dropped
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { sessionMessagesQuery, pinnedSessionCwd } from '../src/lib/chat-url'
import { switchFailureText, pendingSwitchLabel, switchPendingReducer } from '../src/lib/switch-ui'
import { buildRoomRows } from '../src/lib/rooms'

let pass = 0, fail = 0
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('PASS', name) }
  catch (e: any) { fail++; console.log('FAIL', name, '-', String(e?.message).split('\n')[0].slice(0, 300)) }
}
const vr = fs.readFileSync(path.join(__dirname, '../src/components/VoiceRoom.tsx'), 'utf8')
const S = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'

// ── S8 ──
t('S8 sessionMessagesQuery: session + limit, cwd only when known', () => {
  assert.equal(sessionMessagesQuery(S), `?session=${S}&limit=50`)
  assert.equal(sessionMessagesQuery(S, '/w/proj b', 20), `?session=${S}&limit=20&workingDirectory=%2Fw%2Fproj+b`)
  assert.equal(sessionMessagesQuery(S, ''), `?session=${S}&limit=50`)
})
t('S8 mount hydration passes the launch cwd', () => {
  const i = vr.indexOf("agentReadUrl(base, 'session-messages')")
  assert.ok(i > 0)
  assert.ok(/sessionMessagesQuery\(preSelectedSessionId, launchCwd/.test(vr.slice(i - 50, i + 200)))
})

// ── S9 ──
t('S9 failure copy names the reason', () => {
  assert.match(switchFailureText({ reason: 'meeting_active' }), /meeting/i)
  assert.match(switchFailureText({ reason: 'target_busy_in_background' }), /background/i)
  assert.match(switchFailureText({ reason: 'needs_you' }), /permission/i)
  assert.match(switchFailureText({ reason: 'not_found' }), /not found/i)
  assert.equal(switchFailureText({ error: 'Custom agent text' }), 'Custom agent text')
  assert.ok(switchFailureText({}).length > 0)
})
t('S9 pending label: finish-then-switch wording', () => {
  assert.equal(pendingSwitchLabel('Fix the login bug'), 'Switching to “Fix the login bug” when the current step finishes')
  assert.match(pendingSwitchLabel('X', 2), /2 sub-agents/)
})
t('S9 pending reducer: start / replace / cancel / switched', () => {
  let st = switchPendingReducer(null, { type: 'pending', sessionId: 'b', cwd: '/w/b', runningTasks: 1, now: 5 })
  assert.deepEqual(st, { sessionId: 'b', cwd: '/w/b', runningTasks: 1, startedAt: 5 })
  st = switchPendingReducer(st, { type: 'pending', sessionId: 'c', now: 9 })
  assert.equal(st?.sessionId, 'c')
  assert.equal(switchPendingReducer(st, { type: 'cancelled', sessionId: 'other' })?.sessionId, 'c', 'stale cancel ignored')
  assert.equal(switchPendingReducer(st, { type: 'cancelled', sessionId: 'c' }), null)
  assert.equal(switchPendingReducer(st, { type: 'cancelled', sessionId: null }), null)
  assert.equal(switchPendingReducer(st, { type: 'switched' }), null)
})
function block(anchor: string, len = 3000) {
  const i = vr.indexOf(anchor)
  assert.ok(i > 0, `missing ${anchor}`)
  return vr.slice(i, i + len)
}
t('S9 handleSwitchSession sends workingDirectory + force', () => {
  const b = block('const handleSwitchSession = useCallback(', 900)
  assert.ok(/workingDirectory: cwd/.test(b) && /force/.test(b))
})
t('S9 Rooms passes room.cwd; ControlMenu passes session.cwd and honest copy', () => {
  assert.ok(/handleSwitchSession\(room\.id, room\.cwd\)/.test(vr))
  const cm = fs.readFileSync(path.join(__dirname, '../src/components/voice/ControlMenu.tsx'), 'utf8')
  assert.ok(!/Current context will be saved/.test(cm))
  assert.ok(/finishes the current step here first/.test(cm))
  assert.ok(/onResumeSession\(session\.sessionId, session\.cwd\)/.test(cm))
})
t('S9 pending / cancelled handlers exist and Switch now resends with force', () => {
  assert.ok(vr.includes("data.type === 'session_switch_pending'"))
  assert.ok(vr.includes("data.type === 'session_switch_cancelled'"))
  assert.ok(/type: 'cancel_session_switch'/.test(vr))
  assert.ok(/handleSwitchSession\(switchPending\.sessionId, switchPending\.cwd, true\)/.test(vr))
})
t('S9 session_switched success replaces transcript from /session-messages (no 3-line dump)', () => {
  const b = block("data.type === 'session_switched'", 4000).split("data.type === 'plan_file_updated'")[0]
  assert.ok(/setMessages\(\[\]\)/.test(b))
  assert.ok(/setBackgroundFlows\(\[\]\)/.test(b))
  assert.ok(/setPendingPermission\(null\)/.test(b))
  assert.ok(/sessionMessagesQuery\(data\.sessionId, data\.workingDirectory/.test(b))
  assert.ok(!/Previous Session Context/.test(b), 'old dump still present')
  assert.ok(/switchFailureText\(data\)/.test(b))
})
t('S9 click does not set currentSessionId (only session_switched does)', () => {
  const b = block('const handleSwitchSession = useCallback(', 900)
  assert.ok(!/setCurrentSessionId/.test(b))
})

// ── S10 ──
const NOW = Date.parse('2026-11-10T12:00:00Z')
const sess = [
  { sessionId: 'aaaaaaaa-1', lastMessage: 'fix the login bug', timestamp: new Date(NOW - 3600e3).toISOString(), messageCount: 3 },
  { sessionId: 'bbbbbbbb-2', lastMessage: 'plan the offsite', timestamp: new Date(NOW - 7200e3).toISOString(), messageCount: 5 },
]
t('S10 pending target row is marked switching; LIVE stays on the running session', () => {
  const rows = buildRoomRows(sess, 'aaaaaaaa-1', { now: NOW, pendingId: 'bbbbbbbb-2' })
  const live = rows.filter((r) => r.isLive)
  assert.equal(live.length, 1)
  assert.equal(live[0].id, 'aaaaaaaa-1', 'LIVE must not move before session_switched')
  const b = rows.find((r) => r.id === 'bbbbbbbb-2')!
  assert.equal(b.switching, true)
  assert.equal(rows.find((r) => r.id === 'aaaaaaaa-1')!.switching, false)
})
t('S10 no pending -> no switching rows', () => {
  assert.ok(buildRoomRows(sess, 'aaaaaaaa-1', { now: NOW }).every((r) => r.switching === false))
})
t('S10 after the switch: one LIVE row equal to B', () => {
  const rows = buildRoomRows(sess, 'bbbbbbbb-2', { now: NOW })
  assert.deepEqual(rows.filter((r) => r.isLive).map((r) => r.id), ['bbbbbbbb-2'])
})
t('S10 RoomsRail renders the switching state; VoiceRoom passes the pending id', () => {
  const rail = fs.readFileSync(path.join(__dirname, '../src/components/voice/RoomsRail.tsx'), 'utf8')
  assert.ok(/room\.switching/.test(rail) && /Switching…/.test(rail))
  assert.ok(/pendingId=\{switchPending\?\.sessionId/.test(vr))
})

// ── S11 ──
t('S11 pinned cwd: agent-reported cwd for THIS session wins over the list', () => {
  const list = [{ sessionId: S, cwd: '/w/list' }]
  assert.equal(pinnedSessionCwd(S, { sessionId: S, cwd: '/w/agent' }, list), '/w/agent')
})
t('S11 pinned cwd: a fresh session not in the list yet uses the reported cwd', () => {
  assert.equal(pinnedSessionCwd(S, { sessionId: S, cwd: '/w/agent' }, []), '/w/agent')
})
t('S11 pinned cwd: a report for a different session is ignored (stale)', () => {
  assert.equal(pinnedSessionCwd(S, { sessionId: 'other', cwd: '/w/agent' }, [{ sessionId: S, cwd: '/w/list' }]), '/w/list')
  assert.equal(pinnedSessionCwd(S, null, []), undefined)
})
t('S11 VoiceRoom: URL effect uses pinnedSessionCwd; current_session/session_switched record the reported cwd', () => {
  assert.ok(/pinnedSessionCwd\(currentSessionId, reportedCwd, sessions\)/.test(vr))
  const cs = vr.slice(vr.indexOf("data.type === 'current_session'"), vr.indexOf("data.type === 'current_session'") + 600)
  assert.ok(/setReportedCwd\(/.test(cs))
  const sw = vr.slice(vr.indexOf("data.type === 'session_switched'"), vr.indexOf("data.type === 'session_switched'") + 2500)
  assert.ok(/setReportedCwd\(/.test(sw))
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
