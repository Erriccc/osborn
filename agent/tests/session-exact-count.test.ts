// A large session's list count becomes the real turn count after one background pass.
// npx tsx agent/tests/session-exact-count.test.ts
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'session-exact-count-'))
process.env.HOME = home
delete process.env.CLAUDE_CONFIG_DIR
const dir = join(home, '.claude', 'projects', '-tmp')
mkdirSync(dir, { recursive: true })
const row = (role: string, text: string) => JSON.stringify({ type: role, cwd: '/tmp', timestamp: new Date().toISOString(), message: role === 'user' ? { role, content: text } : { role, content: [{ type: 'text', text }] } })
const filler = JSON.stringify({ type: 'user', cwd: '/tmp', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'z'.repeat(20 * 1024) }] } })
// 200 real turns, with tool-result bulk in between so the file is far beyond head + tail.
const rows: string[] = []
for (let i = 0; i < 100; i++) { rows.push(row('user', `question ${i}`), row('assistant', `answer ${i}`)); for (let k = 0; k < 6; k++) rows.push(filler) }
writeFileSync(join(dir, '44444444-4444-4444-8444-444444444444.jsonl'), rows.join('\n') + '\n')

const { listAllClaudeSessions } = await import('../src/config.js')
const first = (await listAllClaudeSessions(10))[0] as any
assert.ok(first.messageCount < 200, `sampled lower bound first, got ${first.messageCount}`)
let real = 0
for (let i = 0; i < 100 && real !== 200; i++) {
  await new Promise((r) => setTimeout(r, 100))
  real = ((await listAllClaudeSessions(10))[0] as any).messageCount
}
assert.equal(real, 200, 'the background pass supplies the real turn count')
console.log('session-exact-count: ok')
