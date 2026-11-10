// Run: cd frontend && npx tsx tests/rooms-rows.test.ts
// #75: the Rooms list must be recognisable — clean title (never a wrapper
// leak, never "Untitled session" when the session has user text), a relative
// time, project + message count, and exactly ONE live row: the session the
// agent is actually running.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { buildRoomRows } from '../src/lib/rooms'
import { UNTITLED_SESSION } from '../src/lib/sessions'

let pass = 0, fail = 0
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('PASS', name) }
  catch (e: any) { fail++; console.log('FAIL', name, '-', String(e.message).split('\n')[0].slice(0, 300)) }
}

const NOW = Date.parse('2026-11-10T12:00:00Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const MIN = 60e3, HOUR = 3600e3, DAY = 86400e3

const sessions = [
  { sessionId: 'aaaaaaaa-1', lastMessage: '[time: 2026-11-06 16:14 local] fix the login bug', timestamp: ago(HOUR), messageCount: 12, cwd: '/home/sprite/workspace/osborn' },
  { sessionId: 'bbbbbbbb-2', title: '[CONTEXT] leaked', lastMessage: 'plan the offsite trip', timestamp: ago(DAY), lastActivityAt: ago(3 * MIN), messageCount: 4, cwd: '/home/sprite/workspace' },
  { sessionId: 'cccccccc-3', title: 'Refactor the voice pipeline', lastMessage: 'x', timestamp: ago(2 * DAY), messageCount: 40 },
  { sessionId: 'dddddddd-4', timestamp: ago(30 * DAY), messageCount: 0 },
]

t('one row per session, most recently active first', () => {
  const rows = buildRoomRows(sessions, null, { now: NOW })
  assert.deepEqual(rows.map((r) => r.id), ['bbbbbbbb-2', 'aaaaaaaa-1', 'cccccccc-3', 'dddddddd-4'])
})

t('titles are clean and derived from user text, not "Untitled session"', () => {
  const rows = buildRoomRows(sessions, null, { now: NOW })
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
  assert.equal(byId['aaaaaaaa-1'].title, 'Fix the login bug')
  assert.equal(byId['bbbbbbbb-2'].title, 'Plan the offsite trip')
  assert.equal(byId['cccccccc-3'].title, 'Refactor the voice pipeline')
  for (const r of rows) assert.ok(r.title && !/^[\[<]/.test(r.title), r.id)
})

t('a session with no text at all is still labelled (Untitled) but distinguishable by time/id', () => {
  const r = buildRoomRows(sessions, null, { now: NOW }).find((x) => x.id === 'dddddddd-4')!
  assert.equal(r.title, UNTITLED_SESSION)
  assert.equal(r.shortId, 'dddddddd')
  assert.ok(r.time.length > 0)
})

t('relative time uses last activity, not file mtime', () => {
  const byId = Object.fromEntries(buildRoomRows(sessions, null, { now: NOW }).map((r) => [r.id, r]))
  assert.equal(byId['bbbbbbbb-2'].time, '3m ago')
  assert.equal(byId['aaaaaaaa-1'].time, '1h ago')
  assert.equal(byId['cccccccc-3'].time, '2d ago')
})

t('project (cwd basename) and message count are carried for disambiguation', () => {
  const byId = Object.fromEntries(buildRoomRows(sessions, null, { now: NOW }).map((r) => [r.id, r]))
  assert.equal(byId['aaaaaaaa-1'].project, 'osborn')
  assert.equal(byId['aaaaaaaa-1'].messageCount, 12)
  assert.equal(byId['cccccccc-3'].project, undefined)
})

t('exactly one LIVE row and it is the running session, listed first', () => {
  const rows = buildRoomRows(sessions, 'cccccccc-3', { now: NOW })
  const live = rows.filter((r) => r.isLive)
  assert.equal(live.length, 1)
  assert.equal(live[0].id, 'cccccccc-3')
  assert.equal(rows[0].id, 'cccccccc-3')
  assert.equal(live[0].status, 'live')
})

t('no live session -> no LIVE row', () => {
  assert.equal(buildRoomRows(sessions, null, { now: NOW }).filter((r) => r.isLive).length, 0)
})

t('running session not yet in the list still gets the single LIVE row', () => {
  const rows = buildRoomRows(sessions, 'eeeeeeee-new', { now: NOW, liveFallbackTitle: 'Check the deploy logs' })
  const live = rows.filter((r) => r.isLive)
  assert.equal(live.length, 1)
  assert.equal(live[0].id, 'eeeeeeee-new')
  assert.equal(live[0].title, 'Check the deploy logs')
  assert.equal(rows.length, sessions.length + 1)
})

t('background slots show as running rooms (not live), deduped against sessions', () => {
  const rows = buildRoomRows(sessions, 'cccccccc-3', {
    now: NOW,
    slots: [
      { id: 'cccccccc-3', isFocused: true, hasSession: true },
      { id: 'aaaaaaaa', isFocused: false, hasSession: true },
    ],
  })
  assert.equal(rows.filter((r) => r.isLive).length, 1)
  const a = rows.filter((r) => r.id.startsWith('aaaaaaaa'))
  assert.equal(a.length, 1, 'session that is also a background slot appears once')
  assert.equal(a[0].status, 'background')
  assert.equal(a[0].title, 'Fix the login bug', 'background row keeps its session title')
})

t('a live id that is an 8-char slot prefix does not create a second live row', () => {
  const rows = buildRoomRows(sessions, 'aaaaaaaa-1', { now: NOW, slots: [{ id: 'aaaaaaaa', isFocused: false, hasSession: true }] })
  assert.equal(rows.filter((r) => r.isLive).length, 1)
  assert.equal(rows.filter((r) => r.id.startsWith('aaaaaaaa')).length, 1)
})

t('idle rows are capped (default 12) but the live row always stays', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ sessionId: `s${String(i).padStart(2, '0')}`, lastMessage: `topic ${i}`, timestamp: ago(i * MIN), messageCount: 1 }))
  const rows = buildRoomRows(many, 's29', { now: NOW })
  assert.equal(rows.filter((r) => r.status === 'idle').length, 12)
  assert.ok(rows.some((r) => r.isLive && r.id === 's29'))
})

t('RoomsRail renders from buildRoomRows and shows the time', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/components/voice/RoomsRail.tsx'), 'utf8')
  assert.ok(/buildRoomRows\(/.test(src), 'RoomsRail must use buildRoomRows')
  assert.ok(/\.time\b/.test(src), 'RoomsRail must render the relative time')
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
