// Follow-through (#378) flush: what is sent, what is marked filed, the per-session lock.
// Run: npx tsx agent/tests/loops-flush.test.ts
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'loops-flush-test-'))
process.env.CLAUDE_CONFIG_DIR = join(home, '.claude')
const cwd = join(home, 'proj')
mkdirSync(cwd, { recursive: true })
const L = await import('../src/loops-ledger.js')
const { flushSession } = await import('../src/loops-flush.js')
const { acquireLock, releaseLock } = await import('../src/content/lens-paths.js')

let pass = 0
const t = async (name: string, fn: () => unknown) => {
  try { await fn(); pass++; console.log('ok   ', name) }
  catch (e: any) { console.log('FAIL ', name, '\n     ', String(e?.message ?? e).split('\n')[0]); process.exitCode = 1 }
}

let sent: any[] = []
// A stand-in for the route: files everything explicit, holds inferred (as for a public repo).
const routeStub = (mode: 'ok' | 'fail' = 'ok') => (async (_url: string, init: any) => {
  const body = JSON.parse(init.body)
  sent.push(body)
  if (mode === 'fail') return new Response('{}', { status: 503 })
  const results = body.items.map((i: any, n: number) => i.source === 'explicit'
    ? { key: i.key, action: 'created', url: `https://github.com/o/r/issues/${n + 1}` }
    : { key: i.key, action: 'held' })
  return new Response(JSON.stringify({ results }), { status: 200 })
}) as unknown as typeof fetch
const deps = (extra: any = {}) => ({ syncToken: 'tok-0123456789abcdef', frontendUrl: 'https://f', repoFor: () => 'o/r', fetchFn: routeStub(), ...extra })

function seed(sid: string) {
  L.appendLoopRecord(sid, cwd, { kind: 'prompt', text: 'remind me to ship', origin: 'user_mic', fg: true })
  L.appendLoopRecord(sid, cwd, { kind: 'ask', id: L.loopIds.ask('remind me to ship'), text: 'remind me to ship', source: 'explicit', origin: 'user_mic', fg: true })
  L.appendLoopRecord(sid, cwd, { kind: 'todo', id: L.loopIds.todo('wire the route'), text: 'wire the route', status: 'pending', source: 'inferred', origin: 'tool', fg: true })
  L.appendLoopRecord(sid, cwd, { kind: 'ask', id: L.loopIds.ask('remind me bg'), text: 'remind me bg', source: 'explicit', origin: 'user_mic', fg: false })
}

await t('posts only unfiled items; explicit-only for public repos', async () => {
  seed('s1'); sent = []
  const r = await flushSession('s1', cwd, deps())
  assert.equal(r.status, 'done')
  assert.equal(sent.length, 1)
  const kinds = sent[0].items.map((i: any) => i.kind).sort()
  assert.deepEqual(kinds, ['ask', 'todo'], 'prompt lines and background items are never sent')
  assert.ok(sent[0].items.every((i: any) => /^[0-9a-f]{12}$/.test(i.key)))
  // Second flush: the explicit one is filed and the inferred one was held by this repo: nothing is sent.
  sent = []
  const again = await flushSession('s1', cwd, deps())
  assert.equal(again.status, 'nothing')
  assert.equal(sent.length, 0)
  const held = L.readLoopRecords('s1', cwd).filter((x) => x.kind === 'held')
  assert.deepEqual(held.map((h) => [h.id, h.repo]), [[L.loopIds.todo('wire the route'), 'o/r']])
  // A different repo has not held it: it would be sent there.
  sent = []
  await flushSession('s1', cwd, deps({ repoFor: () => 'o/other' }))
  assert.deepEqual(sent[0].items.map((i: any) => i.kind), ['todo'])
})

await t('explicit asks are never starved: 25 inferred then 1 ask, through the public stand-in', async () => {
  for (let i = 0; i < 25; i++) {
    L.appendLoopRecord('s-many', cwd, { kind: 'todo', id: L.loopIds.todo(`todo ${i}`), text: `todo ${i}`, status: 'pending', source: 'inferred', origin: 'tool', fg: true })
  }
  L.appendLoopRecord('s-many', cwd, { kind: 'ask', id: L.loopIds.ask('remind me to call the bank'), text: 'remind me to call the bank', source: 'explicit', origin: 'user_mic', fg: true })
  sent = []
  const r = await flushSession('s-many', cwd, deps())
  assert.equal(r.filed, 1, 'the ask is filed on the first flush')
  assert.equal(sent[0].items[0].kind, 'ask', 'explicit first')
  assert.ok(sent[0].items.length <= 10, `batch ${sent[0].items.length}`)
  // The repo held inferred items, so it is known public: the second flush sends nothing.
  sent = []
  const last = await flushSession('s-many', cwd, deps())
  assert.equal(last.status, 'nothing')
  assert.equal(sent.length, 0)
})

await t('appends filed with url on success', async () => {
  const filed = L.readLoopRecords('s1', cwd).filter((r) => r.kind === 'filed')
  assert.equal(filed.length, 1)
  assert.equal(filed[0].url, 'https://github.com/o/r/issues/1')
  assert.equal(filed[0].id, L.loopIds.ask('remind me to ship'))
})

await t('leaves items open on route failure', async () => {
  seed('s2')
  const r = await flushSession('s2', cwd, deps({ fetchFn: routeStub('fail') }))
  assert.equal(r.status, 'error')
  assert.equal(L.readLoopRecords('s2', cwd).filter((x) => x.kind === 'filed').length, 0)
  assert.equal(L.fileableLoops(L.readLoopRecords('s2', cwd)).length, 2)
})

await t('second concurrent worker exits on the flush lock', async () => {
  seed('s3'); sent = []
  const dir = dirname(L.getLoopsPath('s3', cwd))
  assert.ok(acquireLock(dir, Date.now(), L.LOOPS_LOCK, L.LOOPS_LOCK_TTL_MS))
  const r = await flushSession('s3', cwd, deps())
  assert.equal(r.status, 'locked')
  assert.equal(sent.length, 0)
  releaseLock(dir, L.LOOPS_LOCK)
})

await t('stale flush lock (over the 90s TTL, shorter than the 120s startup drain) is replaced', async () => {
  assert.ok(L.LOOPS_LOCK_TTL_MS < 120_000, 'TTL must be shorter than the startup-drain delay')
  seed('s4'); sent = []
  const dir = dirname(L.getLoopsPath('s4', cwd))
  mkdirSync(dir, { recursive: true })
  const lock = join(dir, L.LOOPS_LOCK)
  writeFileSync(lock, '{}')
  const old = new Date(Date.now() - 3 * 60_000)
  utimesSync(lock, old, old)
  const r = await flushSession('s4', cwd, deps())
  assert.equal(r.status, 'done')
})

await t('no repo derivable (not github.com) leaves items open', async () => {
  seed('s5'); sent = []
  const r = await flushSession('s5', cwd, deps({ repoFor: () => undefined }))
  assert.equal(r.status, 'no-repo')
  assert.equal(sent.length, 0)
  assert.equal(L.fileableLoops(L.readLoopRecords('s5', cwd)).length, 2)
})

await t('no sync token leaves items open without a request', async () => {
  seed('s6'); sent = []
  const prev = process.env.OSBORN_SYNC_TOKEN
  delete process.env.OSBORN_SYNC_TOKEN
  const r = await flushSession('s6', cwd, deps({ syncToken: undefined }))
  if (prev !== undefined) process.env.OSBORN_SYNC_TOKEN = prev
  assert.equal(r.status, 'no-token')
  assert.equal(sent.length, 0)
})

await t('a background session\'s items stay local (nothing to send)', async () => {
  L.appendLoopRecord('s-bg', cwd, { kind: 'ask', id: L.loopIds.ask('remind me x'), text: 'remind me x', source: 'explicit', origin: 'user_mic', fg: false })
  sent = []
  const r = await flushSession('s-bg', cwd, deps())
  assert.equal(r.status, 'nothing')
  assert.equal(sent.length, 0)
})

rmSync(home, { recursive: true, force: true })
console.log(`\n${pass} passed`)
