import assert from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSessionSubAgents, projectPathToSlug } from '../src/session-access.js'

const claude = mkdtempSync(join(tmpdir(), 'osb-sub-'))
const proj = '/tmp/some-project'
const dir = join(claude, 'projects', projectPathToSlug(proj))
mkdirSync(dir, { recursive: true })
const file = join(dir, 's1.jsonl')
const line = (id: string) => JSON.stringify({ toolUseResult: { agentId: id, prompt: 'p', status: 'completed' } }) + '\n'
const opts = { claudeDir: claude } as any

writeFileSync(file, line('a1') + JSON.stringify({ type: 'user' }) + '\n')
let r = getSessionSubAgents('s1', proj, opts)
assert.deepStrictEqual(r.map(a => a.agentId), ['a1'])
assert.strictEqual(r[0].agentFileExists, false)

// appended data is picked up without losing earlier agents; duplicates ignored
appendFileSync(file, line('a1') + line('a2'))
writeFileSync(join(dir, 'agent-a2.jsonl'), '')
r = getSessionSubAgents('s1', proj, opts)
assert.deepStrictEqual(r.map(a => a.agentId), ['a1', 'a2'])
assert.strictEqual(r[1].agentFileExists, true)

// a half-written last line waits for its newline
appendFileSync(file, line('a3').slice(0, 20))
assert.strictEqual(getSessionSubAgents('s1', proj, opts).length, 2)
appendFileSync(file, line('a3').slice(20))
assert.strictEqual(getSessionSubAgents('s1', proj, opts).length, 3)

// a truncated/rewritten file restarts the scan
writeFileSync(file, line('b1'))
assert.deepStrictEqual(getSessionSubAgents('s1', proj, opts).map(a => a.agentId), ['b1'])
console.log('subagent-scan-incremental: ok')
