// Run: npx tsx agent/tests/session-list-large.test.ts
// A large COMPACTED session must still appear in listSessions.
// Regression: getSessionPreview samples only a 64KB head for files over
// HEAD+TAIL, and a compacted transcript opens with a compact_boundary plus tool
// records — one tool result can fill 64KB — so head.count was 0 and the session
// failed the `messageCount > 2` gate. On a real machine this hid 59 of 64
// sessions over 1MB, including a 124MB conversation reporting count=0.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fakeHome = mkdtempSync(join(tmpdir(), 'osb-listlarge-'))
process.env.HOME = fakeHome

const { listSessions } = await import('../src/config.js')

let pass = 0, fail = 0
function t(name: string, fn: () => Promise<void> | void) {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log('PASS', name) })
    .catch((e: any) => { fail++; console.log('FAIL', name, '-', String(e?.message).split('\n')[0].slice(0, 300)) })
}

// A project whose slug encodes this cwd, the way the agent stores them.
const projectPath = '/workspace'
const slug = '-workspace'
const dir = join(fakeHome, '.claude', 'projects', slug)
mkdirSync(dir, { recursive: true })

function line(o: unknown) { return JSON.stringify(o) + '\n' }
// Must push the file past HEAD+TAIL (64KB+128KB) so the sampled path runs at
// all, while filling the 64KB head so head.count stays 0 — the real shape.
const bigToolResult = 'x'.repeat(250 * 1024)

function writeSession(id: string, body: string) {
  writeFileSync(join(dir, `${id}.jsonl`), body)
}

// Shaped like the real thing: compact_boundary first, then a tool result that
// swamps the head window, then genuine turns only at the very end.
writeSession('11111111-1111-4111-8111-111111111111',
  line({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted' }) +
  line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: bigToolResult }] } }) +
  line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'what happened to my sessions' }] } }) +
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'they are all still here' }] } }),
)

// Control: a genuinely trivial session must STILL be filtered out, so the fix
// does not simply disable the gate.
writeSession('22222222-2222-4222-8222-222222222222',
  line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
)

await t('a large compacted session is listed (was hidden by the >2 gate)', async () => {
  const sessions = await listSessions(projectPath)
  const ids = sessions.map(s => s.sessionId)
  assert.ok(ids.includes('11111111-1111-4111-8111-111111111111'),
    `large compacted session missing from list; got ${JSON.stringify(ids)}`)
})

await t('its reported messageCount clears the gate', async () => {
  const sessions = await listSessions(projectPath)
  const s = sessions.find(x => x.sessionId === '11111111-1111-4111-8111-111111111111')
  assert.ok(s, 'session not returned at all')
  assert.ok(s!.messageCount > 2, `messageCount must clear the >2 gate, got ${s!.messageCount}`)
})

await t('a genuinely trivial session is still filtered out', async () => {
  const sessions = await listSessions(projectPath)
  const ids = sessions.map(s => s.sessionId)
  assert.ok(!ids.includes('22222222-2222-4222-8222-222222222222'),
    'the >2 gate must still hide trivial sessions')
})

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
