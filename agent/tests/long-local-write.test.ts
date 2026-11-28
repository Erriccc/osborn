// Running-time check for local writer work (#651). Run: npx tsx agent/tests/long-local-write.test.ts
import assert from 'node:assert/strict'
import { getLongLocalWriteNote } from '../src/prompts.js'

const now = 10_000_000
const row = (taskId: string, ageMs: number, description = 'fix') => ({ taskId, description, startedAt: now - ageMs })
const noted = new Set<string>()
assert.equal(getLongLocalWriteNote([], now, noted), null)
assert.equal(getLongLocalWriteNote([row('a', 5 * 60_000)], now, noted), null, 'at the limit is not over it')
assert.equal(noted.size, 0, 'a task under the limit is not consumed')
const note = getLongLocalWriteNote([row('b', 7 * 60_000, 'rename\nthe  tab')], now, noted)!
assert.match(note, /7 min: "rename the tab"/)
assert.match(note, /past 5 minutes/)
assert.equal(getLongLocalWriteNote([row('b', 9 * 60_000)], now, noted), null, 'each task is flagged once')
assert.match(getLongLocalWriteNote([row('b', 9 * 60_000), row('c', 6 * 60_000)], now, noted)!, /6 min: "fix"/, 'a new late task still is')
assert.match(getLongLocalWriteNote([row('d', 6 * 60_000, "pay $& and $'")], now, noted)!, /"pay \$& and \$'"/, 'task text is inserted literally')
console.log('ok   long-local-write')

// Issue-filing gate (#651)
import { issueGate } from '../src/issue-gate.js'
{
  const pub = { publicSince: () => '2026-01-01T00:00:00.000Z', repoFor: () => 'o/r' }
  const inc = { publicSince: () => undefined, repoFor: () => 'o/r' }
  assert.equal(issueGate('ls', '/x', pub).decision, 'allow')
  assert.equal(issueGate('gh issue create -t a -F b.md', '/x', inc).decision, 'deny', 'incognito files nothing')
  assert.equal(issueGate('gh issue create -t a -F b.md', '/x', pub).decision, 'ask', 'public asks the user')
  assert.equal(issueGate('gh issue create -R o/r -t a', '/x', pub).decision, 'ask')
  assert.equal(issueGate('gh issue create --repo=evil/x -t a', '/x', pub).decision, 'deny', 'only the project repo')
  assert.equal(issueGate('gh issue create -t a', '/x', { ...pub, repoFor: () => undefined }).decision, 'deny', 'no nameable repo')
  assert.equal(issueGate("bash -c 'gh issue create -t a'", '/x', inc).decision, 'deny', 'wrapped')
  assert.equal(issueGate("echo 'gh issue create'", '/x', inc).decision, 'allow', 'quoted text is not a command')
  assert.equal(issueGate('gh repo create foo --public', '/x', pub).decision, 'deny')
  assert.equal(issueGate('gh repo create foo', '/x', pub).decision, 'deny')
  assert.equal(issueGate('gh repo create foo --private', '/x', pub).decision, 'ask', 'a private repo still uploads: ask')
  assert.equal(issueGate('gh issue new -t a', '/x', inc).decision, 'deny', 'gh alias')
  assert.equal(issueGate('gh repo new foo --public', '/x', pub).decision, 'deny', 'gh alias')
  assert.equal(issueGate('gh issue create -Revil/x -t a', '/x', pub).decision, 'deny', 'attached -R')
  assert.equal(issueGate('cd "$P" && gh issue create -t a', '/x', pub).decision, 'deny', 'unknown dir')
  // Push and PR (#689)
  assert.equal(issueGate('git push origin HEAD', '/x', inc).decision, 'deny', 'incognito pushes nothing')
  assert.equal(issueGate('git commit -am x', '/x', inc).decision, 'allow', 'a local commit is not gated')
  assert.equal(issueGate('gh pr create --fill', '/x', inc).decision, 'deny', 'incognito opens no PR')
  assert.equal(issueGate("bash -c 'git push'", '/x', inc).decision, 'deny', 'wrapped push')
  assert.equal(issueGate('git push origin HEAD', '/x', pub).decision, 'ask', 'public asks')
  assert.equal(issueGate('git push', '/x', { ...pub, repoFor: () => undefined }).decision, 'ask', 'a push needs no github origin')
  assert.equal(issueGate('gh pr create --repo evil/x', '/x', pub).decision, 'deny', 'PR only on the project repo')
  assert.equal(issueGate('gh pr create --fill', '/x', pub).decision, 'ask')
  assert.equal(issueGate('cd "$P" && git push', '/x', pub).decision, 'deny', 'unknown dir')
  assert.equal(issueGate('cd sub && git push', '/x', { publicSince: (d: string) => d === '/x' ? 'now' : undefined, repoFor: () => 'o/r' }).decision, 'ask', 'a subfolder uses the session folder mode')
  assert.equal(issueGate("echo 'git push'", '/x', inc).decision, 'allow', 'quoted text is not a command')
}
console.log('issue-gate ok')
