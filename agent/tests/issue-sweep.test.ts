import assert from 'node:assert/strict'
import { sweep, render } from '../../scripts/issue-sweep.js'

const now = Date.parse('2026-11-24T00:00:00Z')
const d = (n: number) => new Date(now - n * 864e5).toISOString()
const issue = (number: number, title: string, age: number, extra: any = {}) =>
  ({ number, title, created_at: d(age), updated_at: d(extra.idle ?? age), comments: 0, labels: [], ...extra })
const issues = [
  issue(1, 'Rooms list unrecognisable on mobile', 1),
  issue(2, 'Rooms list unrecognisable on mobile view', 3),
  issue(3, 'Steward gate bypass', 40, { comments: 1, labels: [{ name: 'q:claimed' }] }),
  issue(4, 'Parked thing', 10),
  issue(5, 'Cloud say hangs', 8, { labels: [{ name: 'bug' }] }),
]
const comments = { 3: [{ body: 'claim: loop s1 2026-11-23T00:00:00Z' }, { body: 'claim: loop s1 2026-11-23T12:00:00Z' }] }
const r = sweep({ issues, prs: [{ number: 9, title: 'fix #5', body: '' }], comments, config: { parked: [4] }, now })
assert.equal(r.total, 4)
assert.equal(r.excluded, 1)
assert.deepEqual(r.buckets, { 'under 2d': 1, '2-7d': 1, '7-30d': 1, 'over 30d': 1 })
assert.deepEqual(r.closeCandidates, [{ number: 5, pr: 9 }])
assert.deepEqual(r.duplicates, [[1, 2]])
assert.deepEqual(r.expiredClaims, [{ number: 3, agent: 'loop', expiry: '2026-11-23T12:00:00Z' }])
assert.deepEqual(r.unclaimed, [1, 2])
assert.deepEqual(r.stale7d, [3, 5])
assert.deepEqual(r.unlabelled, [1, 2])
assert.match(render(r), /#5 \(PR #9\)/)
console.log('issue-sweep ok')
