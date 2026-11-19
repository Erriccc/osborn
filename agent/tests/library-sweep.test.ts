// Library catch-up sweep + daily digests: older periods, the per-run cap, live sessions skipped,
// idempotence, digests grouped by LOCAL day (never today, updated when a day gains a chat), status file.
// Run: npx tsx agent/tests/library-sweep.test.ts   (no network — fetch is stubbed)
process.env.TZ = 'America/New_York' // before any Date: local days differ from UTC days
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync } from 'node:zlib'
import Database from 'better-sqlite3'

const tmp = mkdtempSync(join(tmpdir(), 'library-sweep-test-'))
process.env.OPENROUTER_API_KEY = 'dummy-not-a-key'
delete process.env.OSBORN_CONTENT_LENS
delete process.env.OSBORN_CONTENT_LENS_MODEL
delete process.env.OSBORN_LIBRARY_MIN_PERIOD_H // default 1h
delete process.env.OSBORN_SYNC_TOKEN // no cloud ingest here (library-ingest.test.ts covers the seam)
delete process.env.OSBORN_LENS_DENYLIST

const { runLibrarySweep } = await import('../src/content/lens-library-sweep.js')
const { runLibraryStep, readManifest, libraryDirFor } = await import('../src/content/lens-library.js')
const { readDigestManifest, digestDir, localDay } = await import('../src/content/lens-library-digest.js')
const { libraryHomeDir, readSweepStatus, acquireLock, releaseLock, LOCK_FILE, SWEEP_STATUS_FILE } = await import('../src/content/lens-paths.js')
const { launchLibrarySweep, librarySweepHealth } = await import('../src/content/lens-launch.js')

let pass = 0
const t = async (name: string, fn: () => unknown) => {
  try { await fn(); pass++; console.log('ok   ', name) } catch (e: any) { console.log('FAIL ', name, '\n     ', e.message.split('\n')[0]); process.exitCode = 1 }
}

// ── stubbed OpenRouter ──
let periodCalls = 0
let digestCalls = 0
let failPeriods: 'none' | 'http500' | 'garbage' = 'none'
const PERIOD_REPLY = JSON.stringify({ high_leverage: [], period_goal: { text: 'Catch up.', quotes: [] }, arc: [], what_worked: { held_up: [], didnt: [] }, stories: [], angles: [] })
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url)
  if (u.endsWith('/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'minimax/minimax-m3', context_length: 1_048_576, pricing: { prompt: '0.0000003', completion: '0.0000012' } }] }), { status: 200 })
  }
  const body = JSON.parse(String(init?.body ?? '{}'))
  const user = String(body.messages?.[1]?.content ?? '')
  let content: string
  if (user.startsWith('DAILY DIGEST')) {
    digestCalls++
    const ns = [...user.matchAll(/<chat n="(\d+)">\n([^\n]*)/g)]
    content = JSON.stringify({ chats: ns.map(m => ({ n: Number(m[1]), title: `Title: ${m[2].replace(/^user: /, '').slice(0, 30)}`, summary: `Summary of chat ${m[1]}.` })) })
  } else {
    periodCalls++
    if (failPeriods === 'http500') return new Response('upstream down', { status: 500 })
    content = failPeriods === 'garbage' ? 'sorry, no JSON today' : PERIOD_REPLY
  }
  return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 500, completion_tokens: 100, cost: 0.001 }, provider: 'stub' }), { status: 200 })
}) as typeof fetch

// ── fixtures ──
const H = 3_600_000
const M = 60_000
const seam = (words: string) => `<session_tail>\nreplayed\n</session_tail>\n\n${words}`
function makeSession(sid: string, rows: [string, string, number][], slug = '-zz-sweep'): string {
  const pd = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', slug)
  mkdirSync(join(pd, 'osb', sid), { recursive: true })
  const path = join(pd, 'osb', sid, 'session.db')
  const db = new Database(path)
  db.exec(`CREATE TABLE IF NOT EXISTS content(id INTEGER PRIMARY KEY, source TEXT, line_num INT, byte_offset INT, ts TEXT, msg_type TEXT, model TEXT, git_branch TEXT, cwd TEXT, tool_name TEXT, blob BLOB)`)
  for (const [type, text, ms] of rows) db.prepare('INSERT INTO content(source, ts, msg_type, blob) VALUES (?,?,?,?)').run('main', new Date(ms).toISOString(), type, brotliCompressSync(Buffer.from(text)))
  db.close()
  return path
}
const pagesOf = (db: string, sid: string) => {
  const d = libraryDirFor(db, sid)
  return existsSync(d) ? readdirSync(d).filter(f => /-period-\d+\.md$/.test(f)).sort() : []
}
const okKeys = (db: string, sid: string) => Object.values(readManifest(libraryDirFor(db, sid), sid).periods).filter(e => e.status === 'ok').map(e => e.startRowId).sort((a, b) => a - b)

// ═══ 1. the cap: 13 eligible periods → 10 this run (newest first), 3 next run, then nothing ═══
process.env.CLAUDE_CONFIG_DIR = join(tmp, 'claude-cap')
const capSid = 'sweep-cap-0001'
const T1 = new Date(2026, 1, 1, 6, 0).getTime()
const capRows: [string, string, number][] = []
for (let g = 0; g < 13; g++) {
  const at = T1 + g * 2 * H
  capRows.push(['user', g ? seam(`group ${g} starts`) : 'group 0 starts', at], ['assistant', `group ${g} done`, at + 1.5 * H])
}
const capDb = makeSession(capSid, capRows)
const groupStart = (g: number) => 2 * g + 1

await t('cap: one sweep writes at most 10 pages, the newest first, and reports the rest as backlog', async () => {
  const s = await runLibrarySweep({ trigger: 'test' })
  assert.equal(s.status, 'done', JSON.stringify(s.errors))
  assert.equal(periodCalls, 10)
  assert.equal(s.pagesWritten, 10)
  assert.equal(s.modelCalls, 10)
  assert.equal(s.capHit, true)
  assert.deepEqual(s.backlog, { periods: 3, digestDays: 0, todayChats: 0 })
  assert.deepEqual(okKeys(capDb, capSid), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(groupStart))
})
await t('cap: the next sweep picks up the older periods (gap before the written pages), same keys and numbering', async () => {
  const s = await runLibrarySweep({ trigger: 'test' })
  assert.equal(s.pagesWritten, 3)
  assert.equal(periodCalls, 13)
  assert.deepEqual(s.backlog, { periods: 0, digestDays: 0, todayChats: 0 })
  assert.deepEqual(okKeys(capDb, capSid), Array.from({ length: 13 }, (_, g) => groupStart(g)))
  const m = readManifest(libraryDirFor(capDb, capSid), capSid)
  assert.deepEqual(Object.values(m.periods).map(e => e.index).sort((a, b) => a - b), Array.from({ length: 13 }, (_, i) => i + 1))
  assert.equal(pagesOf(capDb, capSid).length, 13)
})
await t('idempotent: a third sweep makes no model call and writes nothing', async () => {
  const s = await runLibrarySweep({ trigger: 'test' })
  assert.equal(periodCalls, 13)
  assert.equal(s.pagesWritten + s.digestsWritten + s.modelCalls, 0)
})

// ═══ 2. older periods, live session, digests by local day, status file ═══
process.env.CLAUDE_CONFIG_DIR = join(tmp, 'claude-main')
periodCalls = digestCalls = 0
const NOW = new Date(2026, 2, 10, 15, 0).getTime() // 10 Mar 2026, 15:00 New York
const day = (d: number, h: number, m = 0) => new Date(2026, 2, d, h, m).getTime()
// A: three 1.5h periods on 1 Mar; the session-end step writes only the newest (the tail).
const aSid = 'sweep-a-0001'
const aDb = makeSession(aSid, [
  ['user', 'Start A one', day(1, 8)], ['assistant', 'A one done', day(1, 9, 30)],
  ['user', seam('A two'), day(1, 10)], ['assistant', 'A two done', day(1, 11, 30)],
  ['user', seam('A three'), day(1, 12)], ['assistant', 'A three done', day(1, 13, 30)],
])
// L: the live session (a 2h period) — must not be touched.
const lSid = 'sweep-live-0001'
const lDb = makeSession(lSid, [['user', 'Live work', day(9, 8)], ['assistant', 'still going', day(9, 10)]])
// Short chats: two on 2 Mar (one at 23:00 local = 04:00 UTC on 3 Mar), one on 4 Mar, one today.
makeSession('sweep-s1-0001', [['user', 'Late night question', day(2, 23)], ['assistant', 'answer', day(2, 23, 20)]])
makeSession('sweep-s2-0001', [['user', 'Morning question', day(2, 10)], ['assistant', 'answer', day(2, 10, 15)]])
makeSession('sweep-s3-0001', [['user', 'Fourth of March chat', day(4, 9)], ['assistant', 'answer', day(4, 9, 10)]])
makeSession('sweep-t-0001', [['user', 'Chat from today', day(10, 8)], ['assistant', 'answer', day(10, 8, 10)]])
const home = libraryHomeDir()
const dDir = digestDir(home)

await t('session end alone writes one page (the tail) and leaves the older periods', async () => {
  const r = await runLibraryStep({ sessionId: aSid })
  assert.equal(r.status, 'written')
  assert.deepEqual(okKeys(aDb, aSid), [5])
  periodCalls = 0
})
await t('sweep: writes the older periods, skips the live session, digests past days only', async () => {
  const s = await runLibrarySweep({ trigger: 'test', exclude: [lSid], now: NOW })
  assert.equal(s.status, 'done', JSON.stringify(s.errors))
  assert.deepEqual(okKeys(aDb, aSid), [1, 3, 5], 'periods 1 and 2 written by the sweep')
  assert.deepEqual(pagesOf(lDb, lSid), [], 'live session untouched')
  assert.equal(existsSync(libraryDirFor(lDb, lSid)), false)
  assert.equal(periodCalls, 2)
  assert.equal(digestCalls, 2, 'one call per day')
  assert.deepEqual([s.pagesWritten, s.digestsWritten, s.modelCalls], [2, 2, 4])
})
await t('digest: grouped by LOCAL day (23:00 New York stays on its day), never today', () => {
  assert.equal(localDay(day(2, 23)), '2026-03-02')
  assert.equal(new Date(day(2, 23)).toISOString().slice(0, 10), '2026-03-03', 'fixture crosses UTC midnight')
  const files = readdirSync(dDir).filter(f => f.endsWith('-digest.md')).sort()
  assert.deepEqual(files, ['2026-03-02-digest.md', '2026-03-04-digest.md'])
  const md = readFileSync(join(dDir, '2026-03-02-digest.md'), 'utf-8')
  assert.match(md, /^- Chats: 2$/m)
  assert.ok(md.includes('Late night question') && md.includes('Morning question'), md)
  assert.ok(md.indexOf('Morning question') < md.indexOf('Late night question'), 'chronological')
  assert.ok(!md.includes('Chat from today'))
  const idx = readFileSync(join(dDir, 'INDEX.md'), 'utf-8')
  assert.ok(idx.includes('daily digests') && idx.includes('[2026-03-02-digest.md](2026-03-02-digest.md)'), idx)
  assert.equal(readDigestManifest(dDir).days['2026-03-02'].chats.length, 2)
})
await t('status file: written next to the sweep lock, survives (read back), /health view has no messages', () => {
  assert.ok(existsSync(join(home, SWEEP_STATUS_FILE)))
  const s = readSweepStatus()!
  assert.equal(s.status, 'done')
  assert.equal(s.trigger, 'test')
  assert.ok(s.at && s.finishedAt)
  assert.deepEqual(s.backlog, { periods: 0, digestDays: 0, todayChats: 1 })
  const h = librarySweepHealth() as any
  assert.deepEqual(h.backlog, s.backlog)
  assert.equal(h.lastSweep.pagesWritten, 2)
  assert.equal(h.lastSweep.digestsWritten, 2)
  assert.ok(!existsSync(join(home, LOCK_FILE)), 'the sweep does not leave the lock behind (the worker owns it)')
})
await t('idempotent: second sweep → no model call; digest pages unchanged', async () => {
  const before = readFileSync(join(dDir, '2026-03-02-digest.md'), 'utf-8')
  const s = await runLibrarySweep({ trigger: 'test', exclude: [lSid], now: NOW })
  assert.equal(s.modelCalls, 0)
  assert.equal(periodCalls + digestCalls, 4)
  assert.equal(readFileSync(join(dDir, '2026-03-02-digest.md'), 'utf-8'), before)
})
await t('digest: a day that gains a chat is rewritten in place (one call, same file)', async () => {
  makeSession('sweep-s4-0001', [['user', 'Afternoon follow up', day(2, 14)], ['assistant', 'answer', day(2, 14, 20)]])
  const s = await runLibrarySweep({ trigger: 'test', exclude: [lSid], now: NOW })
  assert.equal(s.digestsWritten, 1)
  assert.equal(digestCalls, 3)
  const md = readFileSync(join(dDir, '2026-03-02-digest.md'), 'utf-8')
  assert.match(md, /^- Chats: 3$/m)
  assert.ok(md.includes('Afternoon follow up') && md.includes('Late night question'))
  assert.equal(readdirSync(dDir).filter(f => f.startsWith('2026-03-02')).length, 1)
  assert.equal(readDigestManifest(dDir).days['2026-03-02'].chats.length, 3)
  assert.ok(!readFileSync(join(dDir, '2026-03-04-digest.md'), 'utf-8').includes('Afternoon'), 'other days untouched')
})
await t('no retry storm: a period with an unusable reply is tried once per sweep and dropped after 3', async () => {
  const eSid = 'sweep-err-0001'
  const eDb = makeSession(eSid, [['user', 'Long failing work', day(8, 8)], ['assistant', 'done', day(8, 10)]])
  failPeriods = 'garbage'
  try {
    for (let i = 1; i <= 3; i++) {
      const before = periodCalls
      const s = await runLibrarySweep({ trigger: 'test', exclude: [lSid], now: NOW })
      assert.equal(periodCalls - before, 1, `sweep ${i}: one attempt`)
      assert.ok(s.errors.some(e => e.kind === 'period' && e.ref === 'sweep-er'))
      assert.equal(readManifest(libraryDirFor(eDb, eSid), eSid).periods['1'].failures, i)
    }
    const before = periodCalls
    const s = await runLibrarySweep({ trigger: 'test', exclude: [lSid], now: NOW })
    assert.equal(periodCalls, before, 'given up after 3 failures')
    assert.equal(s.backlog?.periods, 0)
  } finally { failPeriods = 'none' }
})
await t('outage: two failed calls in a row stop the sweep, and an outage never counts toward giving up', async () => {
  const dbs = [1, 2, 3].map(n => [`sweep-out-000${n}`, makeSession(`sweep-out-000${n}`, [['user', `Outage work ${n}`, day(7, 8 + n)], ['assistant', 'done', day(7, 9 + n, 30)]])] as const)
  failPeriods = 'http500'
  try {
    const before = periodCalls
    const s = await runLibrarySweep({ trigger: 'test', exclude: [lSid], now: NOW })
    assert.equal(periodCalls - before, 2, 'stopped after two failures, not all three')
    assert.ok(s.errors.some(e => /twice in a row/.test(e.message ?? '')))
    assert.equal(s.backlog?.periods, 3)
    for (const [sid, db] of dbs) assert.equal(readManifest(libraryDirFor(db, sid), sid).periods['1']?.failures ?? 0, 0)
  } finally { failPeriods = 'none' }
  const s = await runLibrarySweep({ trigger: 'test', exclude: [lSid], now: NOW })
  assert.equal(s.pagesWritten, 3, 'recovered on the next run')
})
await t('never two at once: a held sweep lock → launch returns locked (no spawn)', () => {
  assert.ok(acquireLock(home))
  try {
    assert.equal(launchLibrarySweep([], 'test').status, 'locked')
  } finally { releaseLock(home) }
})
await t('worker --sweep: kill switch → status disabled, exits 0, lock released', () => {
  const worker = fileURLToPath(new URL('../src/content/compaction-lens-worker.ts', import.meta.url))
  const res = spawnSync('npx', ['tsx', worker, '--sweep'], { env: { ...process.env, OSBORN_CONTENT_LENS: '0' }, encoding: 'utf-8', timeout: 60_000 })
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /"status":"disabled"/)
  assert.ok(!existsSync(join(home, LOCK_FILE)))
  assert.equal(readSweepStatus()?.status, 'disabled')
})

console.log(`\n${pass} passed`)
