import assert from 'node:assert/strict'
import { buildTodayRows } from '../src/lib/today'
import { groupByDay } from '../src/lib/outputs-model'

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
