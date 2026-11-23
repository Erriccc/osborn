// A large session's list count becomes the real turn count after one background pass; a session
// still being written (live) keeps its sampled count instead of being recounted every turn.
// npx tsx agent/tests/session-exact-count.test.ts
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
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
const idle = join(dir, '44444444-4444-4444-8444-444444444444.jsonl')
const live = join(dir, '55555555-5555-4555-8555-555555555555.jsonl')
writeFileSync(idle, rows.join('\n') + '\n')
writeFileSync(live, rows.join('\n') + '\n')
const hourAgo = new Date(Date.now() - 3600_000)
utimesSync(idle, hourAgo, hourAgo)

const { listAllClaudeSessions } = await import('../src/config.js')
const count = async (id: string) => ((await listAllClaudeSessions(10)) as any[]).find((s) => s.filePath === id).messageCount
assert.ok((await count(idle)) < 200, 'sampled lower bound first')
let real = 0
for (let i = 0; i < 100 && real !== 200; i++) {
  await new Promise((r) => setTimeout(r, 100))
  real = await count(idle)
}
assert.equal(real, 200, 'the background pass supplies the real turn count')
assert.ok((await count(live)) < 200, 'a file written in the last few minutes is not counted yet')
const manifest = JSON.parse(readFileSync(join(home, '.claude', 'session-manifest.json'), 'utf-8'))
assert.equal(manifest.entries[idle].exact, true, 'the count is persisted, so a restart serves it')
console.log('session-exact-count: ok')
