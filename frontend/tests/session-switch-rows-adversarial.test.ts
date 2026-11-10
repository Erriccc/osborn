// Run: cd frontend && npx tsx tests/session-switch-rows-adversarial.test.ts
// buildRoomRows (#75): exactly one live row, even when the live session isn't in the list.
import assert from 'node:assert/strict'
import { buildRoomRows } from '../src/lib/rooms'

let pass = 0, fail = 0
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('PASS', name) } catch (e: any) { fail++; console.log('FAIL', name, '-', String(e.message).split('\n')[0].slice(0, 300)) }
}
const now = Date.now()
const iso = (ms: number) => new Date(now - ms).toISOString()
const S = (id: string, extra: any = {}) => ({ sessionId: id, lastMessage: `[time: x] hello ${id.slice(0, 4)}`, timestamp: iso(60e3), messageCount: 3, cwd: '/w/proj', ...extra })
const list = [S('c97588f4-aaaa'), S('73b234e6-bbbb'), S('19c77344-cccc'), S('4ba9e287-dddd')]
const live = (r: any[]) => r.filter((x) => x.isLive)

t('live in list => exactly one live row, the right one', () => {
  const r = buildRoomRows(list, 'c97588f4-aaaa', { now })
  assert.equal(live(r).length, 1); assert.equal(live(r)[0].id, 'c97588f4-aaaa')
  assert.equal(r.length, list.length, 'no duplicates')
})
t('live NOT in list => still exactly one live row', () => {
  const r = buildRoomRows(list, 'ffffffff-9999', { now })
  assert.equal(live(r).length, 1); assert.equal(live(r)[0].id, 'ffffffff-9999')
  assert.ok(live(r)[0].title.length > 0 && !/^[\[<]/.test(live(r)[0].title))
})
t('live not in empty list => one live row', () => {
  assert.equal(live(buildRoomRows([], 'abc12345-x', { now })).length, 1)
})
t('no live id => zero live rows', () => {
  assert.equal(live(buildRoomRows(list, null, { now })).length, 0)
})
t('8-char live id matches the full id: single live, no duplicate', () => {
  const r = buildRoomRows(list, 'c97588f4', { now })
  assert.equal(live(r).length, 1); assert.equal(r.length, list.length)
})
t('focused/duplicate slot of the live session never adds a second live', () => {
  const r = buildRoomRows(list, 'c97588f4-aaaa', { now, slots: [
    { id: 'c97588f4', isFocused: true, hasSession: true },
    { id: 'c97588f4-aaaa', isFocused: false, hasSession: true },
    { id: '73b234e6', isFocused: false, hasSession: true },
  ] })
  assert.equal(live(r).length, 1)
  assert.equal(r.filter((x) => x.id.startsWith('c97588f4')).length, 1)
  assert.equal(r.find((x) => x.id === '73b234e6')?.status, 'background')
})
t('every row: clean non-empty title, never starts [ or <', () => {
  const r = buildRoomRows([...list, S('e1', { lastMessage: '<task-notification>' }), S('e2', { title: '[CONTEXT]', lastMessage: 'plan trip' })], 'zzzzzzzz', { now, liveFallbackTitle: '[time: x] my first message' })
  for (const x of r) assert.ok(x.title && !/^[\[<]/.test(x.title), JSON.stringify(x.title))
})
t('rows with timestamps have a relative time; live-first ordering', () => {
  const r = buildRoomRows(list, '73b234e6-bbbb', { now })
  assert.equal(r[0].id, '73b234e6-bbbb')
  for (const x of r) assert.ok(x.time.length > 0, x.id)
})
t('missing/garbage timestamp does not throw', () => {
  const r = buildRoomRows([S('g1', { timestamp: 'nope' }), S('g2', { timestamp: undefined })], null, { now })
  assert.equal(r.length, 2)
})
t('maxIdle caps idle rows but never drops the live row', () => {
  const many = Array.from({ length: 30 }, (_, i) => S(`s${String(i).padStart(7, '0')}-x`))
  const r = buildRoomRows(many, 's0000029-x', { now, maxIdle: 5 })
  assert.equal(live(r).length, 1); assert.ok(r.length <= 6)
})
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
