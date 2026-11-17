import assert from 'node:assert/strict'
import { buildTodayRows, dayGroup, groupByDay } from '../src/lib/today'

const now = new Date(2026, 10, 17, 20, 0)
const at = (d: number, h = 12) => new Date(2026, 10, d, h).toISOString()

assert.equal(dayGroup(at(17, 9), now), 'Today')
assert.equal(dayGroup(at(16, 23), now), 'Yesterday')
assert.equal(dayGroup(at(12), now), 'This week')
assert.equal(dayGroup(at(1), now), 'Earlier')
assert.equal(dayGroup('not a date', now), 'Earlier')

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
assert.deepEqual(groupByDay(rows, now).map(g => [g.group, g.rows.length]), [['Today', 2], ['Yesterday', 1], ['Earlier', 1]])
console.log('today: ok')
