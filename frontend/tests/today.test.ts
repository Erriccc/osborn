import assert from 'node:assert/strict'
import { buildTodayRows } from '../src/lib/today'
import { groupByDay, timeUnderDay } from '../src/lib/outputs-model'

const now = new Date(2026, 10, 17, 20, 0)
const at = (d: number, h = 12) => new Date(2026, 10, d, h).toISOString()

const heads = (ats: string[]) => groupByDay(ats, a => a, now.getTime()).map(g => g.label)
assert.deepEqual(heads([at(17, 9)]), ['Today'])
assert.deepEqual(heads([at(16, 23)]), ['Yesterday'])
assert.deepEqual(heads([at(12)]), ['This week'])
assert.deepEqual(heads([at(1), 'not a date']), ['Earlier'])

const rows = buildTodayRows(
  [{ sessionId: 's1', timestamp: at(16), lastMessage: 'Fix the build' }, { sessionId: 's2', timestamp: at(17, 10), lastMessage: 'Plan the launch' }],
  [{ id: 'n1', text: 'Call the bank', created_at: at(17, 15), attachments: ['a.png'] }],
  [{ id: 'b1', type: 'blog', title: null, created_at: at(10) }],
)
assert.deepEqual(rows.map(r => r.key), ['note:n1', 'session:s2', 'session:s1', 'brief:b1'], 'one list, newest first, each item once')
assert.equal(rows[3].title, 'Untitled brief')
assert.equal(rows[3].label, 'Blog')
assert.equal(buildTodayRows([], [], [{ id: 'b2', type: 'source', title: 'x', created_at: at(9) }])[0].label, 'Session brief')
assert.deepEqual(rows[0].attachments, ['a.png'])
assert.deepEqual(groupByDay(rows, r => r.at, now.getTime()).map(g => [g.label, g.items.length]), [['Today', 2], ['Yesterday', 1], ['Earlier', 1]])
console.log('today: ok')

// Times agree with their day heading: clock time under Today/Yesterday, weekday this week, date earlier.
{
  const ref = new Date(2026, 10, 18, 1, 14).getTime()
  const t = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).toISOString()
  assert.equal(timeUnderDay(t(17, 19, 12), ref), '7:12 PM', 'yesterday shows the clock time, not "6h ago"')
  assert.equal(timeUnderDay(t(18, 0, 30), ref), '12:30 AM')
  assert.equal(timeUnderDay(t(16, 18), ref), 'Mon', 'this week shows the weekday, not "1d ago"')
  assert.equal(timeUnderDay(t(3, 9), ref), 'Nov 3')
  assert.equal(timeUnderDay(new Date(2025, 10, 3).toISOString(), ref), 'Nov 3, 2025')
  assert.equal(timeUnderDay('nope', ref), '')
}
