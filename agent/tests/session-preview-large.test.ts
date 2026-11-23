// A long session whose head and tail samples hold no user turn still gets a title and
// a last message. npx tsx agent/tests/session-preview-large.test.ts
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'session-preview-large-'))
process.env.HOME = home
delete process.env.CLAUDE_CONFIG_DIR
const dir = join(home, '.claude', 'projects', '-tmp')
mkdirSync(dir, { recursive: true })
const ts = () => new Date().toISOString()
const user = (text: string) => JSON.stringify({ type: 'user', cwd: '/tmp', timestamp: ts(), message: { role: 'user', content: text } })
const asst = (text: string) => JSON.stringify({ type: 'assistant', cwd: '/tmp', timestamp: ts(), message: { role: 'assistant', content: [{ type: 'text', text }] } })
const toolResult = (kb: number) => JSON.stringify({ type: 'user', cwd: '/tmp', timestamp: ts(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'y'.repeat(kb * 1024) }] } })

const rows = [
  toolResult(100), // the head sample (64 KB) is one cut-off line
  user('Build the session title fix'),
  asst('On it.'),
  user('And the latest ask'),
  asst('Done.'),
  ...Array.from({ length: 30 }, () => toolResult(10)), // the tail sample (128 KB) is tool results only
]
writeFileSync(join(dir, '33333333-3333-4333-8333-333333333333.jsonl'), rows.join('\n') + '\n')

const { listAllClaudeSessions } = await import('../src/config.js')
const [s] = await listAllClaudeSessions(10) as any[]
assert.ok(s, 'the session is listed')
assert.equal(s.title, 'Build the session title fix', 'title from the widened head')
assert.equal(s.lastMessage, 'And the latest ask', 'last message from the widened tail')
console.log('session-preview-large: ok')
