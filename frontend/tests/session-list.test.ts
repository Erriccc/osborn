// Run: cd frontend && npx tsx tests/session-list.test.ts
// #107: the human-facing session lists (Rooms rail + dashboard) must be clean.
// This pins the pure core: dedupe copies (same id across slugs), collapse forks
// (different id, same first turn), hide system/auto sessions, and search.
import assert from 'node:assert/strict'
import {
  dedupeSessions,
  collapseForks,
  isSystemSession,
  sessionMatchesQuery,
  prepareSessions,
  type SessionListItem,
} from '../src/lib/session-list'

let pass = 0, fail = 0
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('PASS', name) }
  catch (e: any) { fail++; console.log('FAIL', name, '-', String(e.message).split('\n')[0].slice(0, 300)) }
}

const ISO = (d: string) => new Date(d).toISOString()

// ── Dedupe ────────────────────────────────────────────────────────────────
t('dedupe collapses the same id filed under several slugs into one row', () => {
  const sessions: SessionListItem[] = [
    { sessionId: 'id-A', lastMessage: 'hello', messageCount: 3 }, // no cwd
    { sessionId: 'id-A', lastMessage: 'hello', messageCount: 3, cwd: '/workspace/osborn' }, // resume copy
    { sessionId: 'id-B', lastMessage: 'world', messageCount: 1, cwd: '/workspace' },
  ]
  const out = dedupeSessions(sessions)
  assert.equal(out.length, 2)
  // id-A survivor is the copy with a resume cwd.
  const a = out.find((s) => s.sessionId === 'id-A')!
  assert.equal(a.cwd, '/workspace/osborn')
})

t('dedupe prefers the fuller copy when both have a resume cwd', () => {
  const out = dedupeSessions([
    { sessionId: 'x', cwd: '/w', messageCount: 2 },
    { sessionId: 'x', cwd: '/w', messageCount: 20 },
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].messageCount, 20)
})

// ── System detection ────────────────────────────────────────────────────────
t('system detection catches sub-agent / verify / meeting / task, not real chats', () => {
  assert.equal(isSystemSession({ sessionId: '1', title: 'Use the reasoner sub-agent to check X' }), true)
  assert.equal(isSystemSession({ sessionId: '2', lastMessage: 'Run tests and verify the build' }), true)
  assert.equal(isSystemSession({ sessionId: '3', lastMessage: '[MEETING — bot42]: standup notes' }), true)
  assert.equal(isSystemSession({ sessionId: '4', lastMessage: '<task-notification> <task-id>abc</task-id>' }), true)
  assert.equal(isSystemSession({ sessionId: '5', title: 'Fix the login bug' }), false)
  // A human's own "verify" task is NOT a system session (conservative patterns).
  assert.equal(isSystemSession({ sessionId: '6', title: 'Verify the invoice total with the vendor' }), false)
})

// ── Fork collapse ───────────────────────────────────────────────────────────
t('forks (same first turn + firstTs, different id) collapse under one primary', () => {
  const firstTs = ISO('2026-11-01T10:00:00Z')
  const groups = collapseForks([
    { sessionId: 'fork-short', title: 'Plan the offsite', firstTs, messageCount: 5 },
    { sessionId: 'fork-full', title: 'Plan the offsite', firstTs, messageCount: 42 },
  ])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].primary.sessionId, 'fork-full') // fullest = trunk
  assert.equal(groups[0].forkCount, 1)
  assert.deepEqual(groups[0].forkIds, ['fork-short'])
})

t('different first turns are NOT merged as forks', () => {
  const groups = collapseForks([
    { sessionId: 'a', title: 'Plan the offsite', firstTs: ISO('2026-11-01T10:00:00Z') },
    { sessionId: 'b', title: 'Plan the offsite', firstTs: ISO('2026-11-02T10:00:00Z') }, // different firstTs
  ])
  assert.equal(groups.length, 2)
  assert.equal(groups.every((g) => g.forkCount === 0), true)
})

t('sessions without firstTs or with a generic title never collapse', () => {
  const groups = collapseForks([
    { sessionId: 'a', title: 'Plan the offsite' }, // no firstTs
    { sessionId: 'b', title: 'Plan the offsite' },
    { sessionId: 'c', firstTs: ISO('2026-11-01T10:00:00Z') }, // untitled
    { sessionId: 'd', firstTs: ISO('2026-11-01T10:00:00Z') },
  ])
  assert.equal(groups.length, 4)
  assert.equal(groups.every((g) => g.forkCount === 0), true)
})

// ── Search ──────────────────────────────────────────────────────────────────
t('search matches title, preview and project; blank matches all', () => {
  const s: SessionListItem = { sessionId: '1', title: 'Refactor voice pipeline', cwd: '/workspace/osborn' }
  assert.equal(sessionMatchesQuery(s, 'voice'), true)
  assert.equal(sessionMatchesQuery(s, 'osborn'), true) // project leaf
  assert.equal(sessionMatchesQuery(s, 'nope'), false)
  assert.equal(sessionMatchesQuery(s, ''), true)
})

// ── Full pipeline ───────────────────────────────────────────────────────────
t('prepareSessions dedupes, collapses forks, hides system by default, counts them', () => {
  const firstTs = ISO('2026-11-01T10:00:00Z')
  const sessions: SessionListItem[] = [
    { sessionId: 'chat', title: 'Fix the login bug', cwd: '/workspace/osborn', messageCount: 10 },
    { sessionId: 'chat', title: 'Fix the login bug', messageCount: 10 }, // dup copy (no cwd)
    { sessionId: 'f1', title: 'Weekly plan', firstTs, messageCount: 3, cwd: '/workspace/osborn' },
    { sessionId: 'f2', title: 'Weekly plan', firstTs, messageCount: 9, cwd: '/workspace/osborn' }, // fork of f1
    { sessionId: 'sys1', title: 'Use the reasoner sub-agent to verify', cwd: '/workspace/osborn' },
    { sessionId: 'sys2', lastMessage: 'Run tests and verify the change', cwd: '/workspace/osborn' },
  ]
  const def = prepareSessions(sessions)
  // chat (deduped) + one fork primary = 2 visible; 2 system hidden.
  assert.equal(def.sessions.length, 2)
  assert.equal(def.systemCount, 2)
  assert.equal(def.sessions.some((s) => s.sessionId === 'chat'), true)
  assert.equal(def.sessions.some((s) => s.sessionId === 'f2'), true) // fuller fork kept
  assert.equal(def.forkCountById.get('f2'), 1)

  // Toggle on → system sessions appear.
  const withSys = prepareSessions(sessions, { hideSystem: false })
  assert.equal(withSys.sessions.length, 4)

  // Search narrows to matching rows (over visible, non-system set).
  const searched = prepareSessions(sessions, { search: 'login' })
  assert.equal(searched.sessions.length, 1)
  assert.equal(searched.sessions[0].sessionId, 'chat')
})

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
