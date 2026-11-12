// Run: cd frontend && npx tsx tests/session-list.test.ts
// #107: the human-facing session lists (Rooms rail + dashboard) must be clean
// WITHOUT hiding real work. This pins the pure core: duplicate copies of the
// same session fold into one row, machine-written meeting/task rows can be
// hidden only on request, and nothing else is ever filtered out.
import assert from 'node:assert/strict'
import { prepareSessions, sessionMatchesQuery, type SessionListItem } from '../src/lib/session-list'

let pass = 0, fail = 0
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('PASS', name) }
  catch (e: any) { fail++; console.log('FAIL', name, '-', String(e.message).split('\n')[0].slice(0, 300)) }
}

// ── Dedupe ────────────────────────────────────────────────────────────────
t('dedupe collapses the same id filed under several slugs into one row', () => {
  const sessions: SessionListItem[] = [
    { sessionId: 'id-A', lastMessage: 'hello', messageCount: 3 }, // no cwd
    { sessionId: 'id-A', lastMessage: 'hello', messageCount: 3, cwd: '/workspace/osborn' }, // resume copy
    { sessionId: 'id-B', lastMessage: 'world', messageCount: 1, cwd: '/workspace' },
  ]
  const out = prepareSessions(sessions).sessions
  assert.equal(out.length, 2)
  // id-A survivor is the copy with a resume cwd.
  assert.equal(out.find((s) => s.sessionId === 'id-A')!.cwd, '/workspace/osborn')
})

t('dedupe prefers the fuller copy when both have a resume cwd', () => {
  const out = prepareSessions([
    { sessionId: 'x', cwd: '/w', messageCount: 2 },
    { sessionId: 'x', cwd: '/w', messageCount: 20 },
  ]).sessions
  assert.equal(out.length, 1)
  assert.equal(out[0].messageCount, 20)
})

t('the 8-char short form of a session is the SAME session, not a second row', () => {
  // The rail's `sameSession` already treats an 8-char id as the full one; the
  // list pass has to agree or the prefix copy renders twice.
  const out = prepareSessions([
    { sessionId: 'abcdef12-3456-7890-aaaa-bbbbbbbbbbbb', cwd: '/w', messageCount: 9 },
    { sessionId: 'abcdef12', messageCount: 1 },
  ]).sessions
  assert.equal(out.length, 1)
  assert.equal(out[0].messageCount, 9)
})

t('two different sessions that merely share an id prefix stay separate', () => {
  const out = prepareSessions([
    { sessionId: 'abcdef12-0000-0000-0000-000000000001', cwd: '/w' },
    { sessionId: 'abcdef12-0000-0000-0000-000000000002', cwd: '/w' },
  ]).sessions
  assert.equal(out.length, 2)
})

// ── System detection: machine markers only ────────────────────────────────
t('only the agent\'s own meeting / task markers count as system sessions', () => {
  const out = prepareSessions([
    { sessionId: 'm', lastMessage: '[MEETING — bot42]: standup notes' },
    { sessionId: 't', lastMessage: '<task-notification> <task-id>abc</task-id>' },
    { sessionId: 'c', title: 'Fix the login bug' },
  ], { hideSystem: true })
  assert.equal(out.systemCount, 2)
  assert.deepEqual(out.sessions.map((s) => s.sessionId), ['c'])
})

// REGRESSION (#126 review): these four are HUMAN sessions. The prompt-text
// patterns that used to classify them ("sub-agent", "use the … agent",
// "verifier|tester") matched all four and hid them from BOTH lists. `lastMessage`
// is the session's LAST user turn (agent/src/config.ts), so anchored patterns
// were reading the wrong text as well. None of them may ever be hidden.
t('real human sessions are never hidden, even when they talk about agents', () => {
  const humans: SessionListItem[] = [
    { sessionId: 'h1', lastMessage: 'can you run the tester on that?' },
    { sessionId: 'h2', lastMessage: 'use the reasoner agent next time' },
    { sessionId: 'h3', title: 'Hire a QA tester' },
    { sessionId: 'h4', lastMessage: 'what does the sub-agent cost?' },
    { sessionId: 'h5', lastMessage: 'Run tests and verify the invoice total' },
    { sessionId: 'h6', title: 'Verify the invoice total with the vendor' },
  ]
  for (const opts of [{}, { hideSystem: true }]) {
    const out = prepareSessions(humans, opts)
    assert.equal(out.systemCount, 0, JSON.stringify(opts))
    assert.equal(out.sessions.length, humans.length, JSON.stringify(opts))
  }
})

t('nothing is hidden unless hideSystem is asked for', () => {
  const sessions: SessionListItem[] = [
    { sessionId: 'm', lastMessage: '[MEETING — bot42]: standup notes' },
    { sessionId: 'c', title: 'Fix the login bug' },
  ]
  const def = prepareSessions(sessions)
  assert.equal(def.sessions.length, 2, 'default must show every row')
  assert.equal(def.systemCount, 1, 'but still count what the toggle would hide')
})

// ── Search (the one shared matcher — SessionBrowser's list) ────────────────
t('search matches title, preview, project and id; blank matches all', () => {
  const s: SessionListItem = { sessionId: 'abc123', title: 'Refactor voice pipeline', cwd: '/workspace/osborn' }
  assert.equal(sessionMatchesQuery(s, 'voice'), true)
  assert.equal(sessionMatchesQuery(s, 'osborn'), true) // project leaf
  assert.equal(sessionMatchesQuery(s, 'abc123'), true) // id
  assert.equal(sessionMatchesQuery(s, 'nope'), false)
  assert.equal(sessionMatchesQuery(s, ''), true)
})

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
