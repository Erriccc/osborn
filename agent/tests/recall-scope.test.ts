// Run: npx tsx agent/tests/recall-scope.test.ts
// #657: recall returns nothing from another project unless cross-project recall is on.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'

process.env.HOME = mkdtempSync(join(tmpdir(), 'osborn-recall-scope-'))
process.env.OSBORN_EMBED = '0'
delete process.env.OSBORN_CROSS_PROJECT_RECALL

const { getSessionDir } = await import('../src/config.js')
const { openStore, recall, updateSessionStore, getStorePath, rowInScope } = await import('../src/session-store.js')

const A = join(process.env.HOME, 'projA'), B = join(process.env.HOME, 'projB')
mkdirSync(A, { recursive: true }); mkdirSync(B, { recursive: true })
const sid = '11111111-2222-4333-8444-555555555555'
const dir = getSessionDir(A)
mkdirSync(dir, { recursive: true })
const line = (cwd: string, text: string, n: number) => JSON.stringify({
  type: 'user', uuid: `u${n}`, timestamp: `2026-11-19T10:00:0${n}.000Z`, sessionId: sid, cwd,
  message: { role: 'user', content: text },
}) + '\n'
writeFileSync(join(dir, `${sid}.jsonl`), line(A, 'zebrafish decision for project A', 1) + line(B, 'zebrafish secret of project B', 2))
await updateSessionStore(sid, A)

const texts = async (scope?: string) => {
  const db = openStore(getStorePath(sid, A), { readonly: true })
  try { return (await recall(db, 'zebrafish', { mode: 'keyword', scopeCwd: scope })).map(h => h.text) } finally { db.close() }
}

let t = await texts(A)
assert.equal(t.length, 1); assert.match(t[0], /project A/); assert.ok(!t.some(x => /project B/.test(x)))
process.env.OSBORN_CROSS_PROJECT_RECALL = 'on'
assert.equal((await texts(A)).length, 2)
delete process.env.OSBORN_CROSS_PROJECT_RECALL
assert.equal((await texts()).length, 2) // no scope given: unfiltered
assert.ok(rowInScope(join(A, 'sub'), A) && rowInScope(null, A) && !rowInScope(B, A) && !rowInScope(process.env.HOME, A))

// osborn-recall refuses another project's store by default (--cwd, --list, --session escaping the project)
const bStore = getStorePath(sid, B); mkdirSync(dirname(bStore), { recursive: true }); writeFileSync(bStore, '')
const cli = (args: string[], env: Record<string, string> = {}) => spawnSync('npx', ['tsx', join(import.meta.dirname, '../src/recall-cli.ts'), ...args], {
  env: { ...process.env, OSBORN_CWD: A, ...env }, encoding: 'utf-8' })
for (const args of [['zebrafish', '--cwd', B], ['--list', '--cwd', B], ['zebrafish', '--session', relative(dirname(dirname(getStorePath(sid, A))), dirname(bStore))]]) {
  const r = cli(args)
  assert.equal(r.status, 1, args.join(' ')); assert.match(r.stderr, /Cross-project recall is off/)
}
assert.doesNotMatch(cli(['zebrafish', '--mode', 'keyword', '--cwd', B], { OSBORN_CROSS_PROJECT_RECALL: 'on' }).stderr, /Cross-project recall is off/)
const own = cli(['zebrafish', '--mode', 'keyword'])
assert.equal(own.status, 0); assert.match(own.stdout, /project A/); assert.doesNotMatch(own.stdout, /project B/)
console.log('recall-scope: ok')
