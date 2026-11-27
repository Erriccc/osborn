// Run: npx tsx agent/tests/recall-setting.test.ts
// #657: cross-project recall setting (config.yaml), env override, refusal text, scoped session tail and recent entries.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HOME = mkdtempSync(join(tmpdir(), 'osborn-recall-setting-'))
process.env.OSBORN_EMBED = '0'
delete process.env.OSBORN_CROSS_PROJECT_RECALL

const { readCrossProjectRecall, getSessionDir } = await import('../src/config.js')
const { crossProjectRecallEnabled, updateSessionStore, getStorePath, getOsbRoot } = await import('../src/session-store.js')
const { buildSessionTail } = await import('../src/pipeline-direct-llm.js')
const fb = await import('../src/pipeline-fastbrain.js') as any

const cfgDir = join(process.env.HOME, '.osborn'); mkdirSync(cfgDir, { recursive: true })
const cfg = join(cfgDir, 'config.yaml')

// setting: missing, bad, off, on
assert.equal(readCrossProjectRecall(join(cfgDir, 'none.yaml')), false)
writeFileSync(cfg, ': : not yaml ['); assert.equal(readCrossProjectRecall(cfg), false)
writeFileSync(cfg, 'crossProjectRecall: false\n'); assert.equal(readCrossProjectRecall(cfg), false)
writeFileSync(cfg, 'crossProjectRecall: true\n'); assert.equal(readCrossProjectRecall(cfg), true)
writeFileSync(cfg, 'crossProjectRecall: "yes"\n'); assert.equal(readCrossProjectRecall(cfg), false)

// crossProjectRecallEnabled reads the default config file; env wins when set
writeFileSync(cfg, 'crossProjectRecall: true\n')
assert.equal(crossProjectRecallEnabled(), true)
process.env.OSBORN_CROSS_PROJECT_RECALL = 'off'; assert.equal(crossProjectRecallEnabled(), false)
writeFileSync(cfg, 'crossProjectRecall: false\n')
process.env.OSBORN_CROSS_PROJECT_RECALL = 'on'; assert.equal(crossProjectRecallEnabled(), true)
delete process.env.OSBORN_CROSS_PROJECT_RECALL; assert.equal(crossProjectRecallEnabled(), false)

// refusal text names neither the key nor the env var; skill text too
const cliSrc = readFileSync(new URL('../src/recall-cli.ts', import.meta.url), 'utf-8')
const refusal = cliSrc.match(/const REFUSED = '((?:[^'\\]|\\.)*)'/)![1]
assert.match(refusal, /Cross-project recall is off/); assert.match(refusal, /settings/)
assert.doesNotMatch(refusal, /crossProjectRecall|CROSS_PROJECT_RECALL/i)
assert.doesNotMatch(readFileSync(new URL('../.claude/skills/recall/SKILL.md', import.meta.url), 'utf-8'), /crossProjectRecall|CROSS_PROJECT_RECALL/i)

// slug helper reuse
assert.equal(getOsbRoot('/a/b').endsWith(join('projects', '-a-b', 'osb')), true)

// scoped session tail and recent entries
const A = join(process.env.HOME, 'projA'), B = join(process.env.HOME, 'projB')
mkdirSync(A, { recursive: true }); mkdirSync(B, { recursive: true })
const sid = '11111111-2222-4333-8444-555555555556'
const dir = getSessionDir(A); mkdirSync(dir, { recursive: true })
const line = (cwd: string, text: string, n: number) => JSON.stringify({
  type: 'user', uuid: `u${n}`, timestamp: `2026-11-19T10:00:${String(n).padStart(2, '0')}.000Z`, sessionId: sid, cwd,
  message: { role: 'user', content: text },
}) + '\n'
let body = ''
for (let i = 1; i <= 3; i++) body += line(A, `alpha note ${i}`, i)
for (let i = 4; i <= 12; i++) body += line(B, `bravo secret ${i}`, i) // newest rows are other-project
writeFileSync(join(dir, `${sid}.jsonl`), body)
await updateSessionStore(sid, A)
assert.ok(getStorePath(sid, A).startsWith(getOsbRoot(A)))

const tail = buildSessionTail(sid, A)
assert.match(tail, /alpha note 3/); assert.doesNotMatch(tail, /bravo/)
process.env.OSBORN_CROSS_PROJECT_RECALL = 'on'
assert.match(buildSessionTail(sid, A), /bravo/)
delete process.env.OSBORN_CROSS_PROJECT_RECALL

const recent = await fb.getRecentEntries(sid, A, undefined, 3)
assert.match(recent, /last 3 entries/); assert.doesNotMatch(recent, /bravo/); assert.match(recent, /alpha note 1/)

const sid2 = '11111111-2222-4333-8444-555555555557'
writeFileSync(join(dir, `${sid2}.jsonl`), line(B, 'only bravo', 1).replace(sid, sid2))
await updateSessionStore(sid2, A)
assert.equal(await fb.getRecentEntries(sid2, A, undefined, 3), 'No entries yet.')
console.log('recall-setting: ok')
