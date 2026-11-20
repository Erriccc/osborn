// #166: a small-limit scan must not answer a later larger one. npx tsx agent/tests/session-list-cache.test.ts
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'session-list-cache-'))
process.env.HOME = home
const dir = join(home, '.claude', 'projects', '-tmp')
mkdirSync(dir, { recursive: true })
const line = (role: string, text: string) => JSON.stringify({ type: role, cwd: '/tmp', timestamp: new Date().toISOString(), message: { role, content: text } })
const write = (id: string, turns: number, ageSec: number) => {
  const f = join(dir, `${id}.jsonl`)
  const rows = Array.from({ length: turns }, (_, i) => line(i % 2 ? 'assistant' : 'user', `message ${i} ${'x'.repeat(200)}`))
  writeFileSync(f, rows.join('\n') + '\n')
  const t = new Date(Date.now() - ageSec * 1000)
  utimesSync(f, t, t)
}
write('11111111-1111-4111-8111-111111111111', 4, 0)
write('22222222-2222-4222-8222-222222222222', 4, 60)

const { listAllClaudeSessions } = await import('../src/config.js')
// The phone path asks for 1 first; /sessions then asks for 500 within the cache TTL.
assert.equal((await listAllClaudeSessions(1)).length, 1, 'a 1-file scan')
const all = await listAllClaudeSessions(500)
assert.equal(all.length, 2, 'the larger scan is not served from the 1-file cache')
assert.equal((await listAllClaudeSessions(1)).length, 1, 'a full scan still answers a smaller limit')
console.log('session-list-cache: ok')
