// Run: npx tsx agent/tests/recall-setting.test.ts
// #657: cross-project recall setting (config.yaml), env override, refusal text, scoped session tail and recent entries.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HOME = mkdtempSync(join(tmpdir(), 'osborn-recall-setting-'))
process.env.OSBORN_EMBED = '0'
delete process.env.OSBORN_CROSS_PROJECT_RECALL

const { readCrossProjectRecall, getSessionDir } = await import('../src/config.js')
const { updateSessionStore, getStorePath, getOsbRoot } = await import('../src/session-store.js')
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

// recallScope reads the default config file once per process; env wins when set (and is read each time)
const { recallScope, resetCrossProjectRecallCache, recall, rowInScope, openStore } = await import('../src/session-store.js')
const X = '/some/project'
writeFileSync(cfg, 'crossProjectRecall: true\n'); resetCrossProjectRecallCache()
assert.equal(recallScope(X), undefined)
process.env.OSBORN_CROSS_PROJECT_RECALL = 'off'; assert.equal(recallScope(X), X)
writeFileSync(cfg, 'crossProjectRecall: false\n')
process.env.OSBORN_CROSS_PROJECT_RECALL = 'on'; assert.equal(recallScope(X), undefined)
// empty env falls through to the config
process.env.OSBORN_CROSS_PROJECT_RECALL = ''; resetCrossProjectRecallCache()
assert.equal(recallScope(X), X)
writeFileSync(cfg, 'crossProjectRecall: true\n'); resetCrossProjectRecallCache()
assert.equal(recallScope(X), undefined)
delete process.env.OSBORN_CROSS_PROJECT_RECALL
// once per process: editing the file after the first read changes nothing
writeFileSync(cfg, 'crossProjectRecall: false\n')
assert.equal(recallScope(X), undefined)
resetCrossProjectRecallCache(); assert.equal(recallScope(X), X)

// refusal text names neither the key nor the env var; skill text too
const cliSrc = readFileSync(new URL('../src/recall-cli.ts', import.meta.url), 'utf-8')
const refusal = cliSrc.match(/const REFUSED = '((?:[^'\\]|\\.)*)'/)![1]
assert.match(refusal, /Cross-project recall is off/); assert.match(refusal, /Ask the user/)
assert.doesNotMatch(refusal, /crossProjectRecall|CROSS_PROJECT_RECALL|settings/i)
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

// cross-project on lifts the recall() filter (config, env unset)
writeFileSync(cfg, 'crossProjectRecall: false\n'); resetCrossProjectRecallCache()
{
  const db = openStore(getStorePath(sid, A), { readonly: true })
  try {
    const off = await recall(db, 'bravo', { mode: 'keyword', scopeCwd: A })
    assert.equal(off.length, 0)
    writeFileSync(cfg, 'crossProjectRecall: true\n'); resetCrossProjectRecallCache()
    assert.ok((await recall(db, 'bravo', { mode: 'keyword', scopeCwd: A })).length > 0)
  } finally { db.close() }
}
writeFileSync(cfg, 'crossProjectRecall: false\n'); resetCrossProjectRecallCache()

// out-of-scope rows do not eat the count: 3 in-scope rows come back for count 3 though 9 newer rows are out of scope
{
  const { recentRows } = await import('../src/session-store.js')
  const db = openStore(getStorePath(sid, A), { readonly: true })
  try {
    assert.equal(recentRows(db, 3, undefined, { scope: A }).length, 3)
    assert.ok(recentRows(db, 3, undefined, { scope: A }).every((r: any) => r.cwd === A))
    assert.equal(recentRows(db, 20, undefined, { scope: A }).length, 3)
    assert.equal(recentRows(db, 5).length, 5) // unscoped unchanged
  } finally { db.close() }
}

// a symlinked working dir still scopes correctly
{
  const real = join(process.env.HOME, 'realproj'); mkdirSync(real, { recursive: true })
  const link = join(process.env.HOME, 'linkproj'); symlinkSync(real, link)
  const sid3 = '11111111-2222-4333-8444-555555555558'
  const d3 = getSessionDir(link); mkdirSync(d3, { recursive: true })
  let b3 = ''
  for (let i = 1; i <= 2; i++) b3 += line(realpathSync(real), `real form ${i}`, i).replace(sid, sid3)
  b3 += line(B, 'bravo other', 3).replace(sid, sid3)
  writeFileSync(join(d3, `${sid3}.jsonl`), b3)
  await updateSessionStore(sid3, link)
  assert.ok(rowInScope(realpathSync(real), link) && rowInScope(link, realpathSync(real)) && !rowInScope(B, link))
  const t3 = buildSessionTail(sid3, link)
  assert.match(t3, /real form 2/); assert.doesNotMatch(t3, /bravo/)
  const r3 = await fb.getRecentEntries(sid3, link, undefined, 5)
  assert.match(r3, /real form 1/); assert.doesNotMatch(r3, /bravo/)
}
console.log('recall-setting: ok')
