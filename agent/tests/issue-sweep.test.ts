import assert from 'node:assert/strict'
import { sweep, render, refs, parseClaim } from '../../scripts/issue-sweep.js'

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
assert.deepEqual(r.unclaimed, [1, 2, 5]) // a merged PR that mentioned #5 is not a claim
assert.deepEqual(r.claimable, [2, 5])
assert.deepEqual(r.stale7d, [3, 5])
assert.deepEqual(r.unlabelled, [1, 2])
assert.match(render(r), /#5 \(PR #9\)/)
const open2 = sweep({ issues, prs: [], openPrs: [{ number: 10, title: 'wip #2', body: '' }], comments, config: { parked: [4] }, now })
assert.deepEqual(open2.unclaimed, [1, 5])
assert.deepEqual(open2.claimable, [5])
assert.deepEqual(refs('#222 x #1e293b Erriccc/other#10 #10 closes #11'), [222, 10, 11])
assert.deepEqual(refs('see #10'), [10])
assert.deepEqual(refs('color #1e293b and Erriccc/other#10'), [])
assert.equal(parseClaim('claim: a s 2026-11-25T00:00:00Z.')!.ms, Date.parse('2026-11-25T00:00:00Z'))
assert.equal(parseClaim('claim: a s 2026-11-25T00:00:00+02:00')!.ms, Date.parse('2026-11-25T00:00:00+02:00'))
assert.ok(Number.isNaN(parseClaim('claim: a s 2026-11-25T00:00:00')!.ms))
assert.ok(Number.isNaN(parseClaim('claim: a s soon')!.ms))
const bad = sweep({ issues: [issue(7, 'x', 3, { labels: [{ name: 'q:claimed' }] }), issue(8, 'n', 30, { labels: [{ name: 'follow-through' }] })], prs: [], openPrs: [{ number: 99, title: 'wip #7', body: '' }], comments: { 7: [{ body: 'claim: a s 2026-12-01T00:00:00' }] }, now })
assert.deepEqual(bad.expiredClaims, [{ number: 7, agent: 'a', reason: 'bad expiry' }])
assert.deepEqual(bad.unclaimed, [])
assert.deepEqual(bad.stale7d, [])
const net = [issue(20, 'a', 3, { labels: [{ name: 'q:claimed' }] }), issue(21, 'b', 3, { labels: [{ name: 'q:claimed' }] }), issue(22, 'c', 3, { labels: [{ name: 'q:claimed' }] })]
assert.deepEqual(sweep({ issues: net, prs: [], openPrs: [{ number: 98, title: 'fix #21', body: '' }], branches: ['auto/20-x', 'auto/2-y', 'main'], now }).expiredClaims, [{ number: 22, reason: 'no claim comment' }])
const old = sweep({ issues: [issue(40, 'e', 3, { labels: [{ name: 'q:claimed' }] }), issue(41, 'f', 3, { labels: [{ name: 'q:claimed' }] })], prs: [], openPrs: [{ number: 97, title: 'fix #41', body: '' }], branches: ['auto/40-fix'], comments: { 40: [{ body: 'claim: local s 2026-11-20T00:00:00Z' }], 41: [{ body: 'claim: local s 2026-11-20T00:00:00Z' }] }, now })
assert.deepEqual(old.expiredClaims, [], 'an expired comment claim is not listed while a network branch or open PR holds the issue')
const dup = sweep({ issues: [issue(11, 'alpha beta gamma', 1), issue(12, 'beta gamma delta', 1), issue(13, 'gamma delta epsilon', 1), issue(14, 'Voice', 1), issue(15, 'Voice', 1)], prs: [], now, dupThreshold: 0.3 })
assert.deepEqual(dup.duplicates, [[11, 12], [12, 13]])
console.log('issue-sweep ok')
