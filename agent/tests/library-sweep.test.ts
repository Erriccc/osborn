// Library catch-up sweep + daily digests: older periods, the per-run cap, live sessions skipped,
// idempotence, digests grouped by LOCAL day (never today, updated when a day gains a chat), status file.
// Run: npx tsx agent/tests/library-sweep.test.ts   (no network — fetch is stubbed)
process.env.TZ = 'America/New_York' // before any Date: local days differ from UTC days
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
process.env.OSBORN_HOME = join(tmp, 'osborn-home') // the machine's daily spend ledger
delete process.env.OSBORN_CONTENT_DAILY_USD
delete process.env.OSBORN_CONTENT_DAY_CAP_USD
delete process.env.OSBORN_LIBRARY_DAILY_USD
delete process.env.OSBORN_LENS_DENYLIST

const { runLibrarySweep } = await import('../src/content/lens-library-sweep.js')
const { runLibraryStep, readManifest, writeManifest, libraryDirFor, libraryBacklog } = await import('../src/content/lens-library.js')
const { readDigestManifest, writeDigestManifest, digestDir, localDay, removeDigestDay } = await import('../src/content/lens-library-digest.js')
const { loadRowStamps } = await import('../src/content/lens-db.js')
const { libraryHomeDir, readSweepStatus, writeSweepStatus, acquireLock, releaseLock, LOCK_FILE, SWEEP_STATUS_FILE } = await import('../src/content/lens-paths.js')
const { launchLibrarySweep, librarySweepHealth } = await import('../src/content/lens-launch.js')
const { daySpent, LIBRARY_LEDGER_SCOPE } = await import('../src/content/content-llm.js')
const daySpentNow = () => daySpent(Date.now(), LIBRARY_LEDGER_SCOPE)

let pass = 0
const t = async (name: string, fn: () => unknown) => {
  try { await fn(); pass++; console.log('ok   ', name) } catch (e: any) { console.log('FAIL ', name, '\n     ', e.message.split('\n')[0]); process.exitCode = 1 }
}

// ── stubbed OpenRouter ──
let periodCalls = 0
let digestCalls = 0
let failPeriods: 'none' | 'http500' | 'garbage' = 'none'
const PERIOD_REPLY = JSON.stringify({ high_leverage: [], period_goal: { text: 'Catch up.', quotes: [] }, arc: [], what_worked: { held_up: [], didnt: [] }, stories: [], angles: [] })
let ingestCalls = 0
let captureMid = false
let midStatus: any = null
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url)
  if (u.includes('/rest/v1/rpc/content_ingest')) {
    ingestCalls++
    return new Response(JSON.stringify('00000000-0000-4000-8000-000000000001'), { status: 200 })
  }
  if (u.endsWith('/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'minimax/minimax-m3', context_length: 1_048_576, pricing: { prompt: '0.0000003', completion: '0.0000012' } }] }), { status: 200 })
  }
  const body = JSON.parse(String(init?.body ?? '{}'))
  const user = String(body.messages?.[1]?.content ?? '')
  let content: string
  if (user.startsWith('DAILY DIGEST')) {
    digestCalls++
    if (captureMid) midStatus = readSweepStatus()
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
  const s = await runLibrarySweep({ cooldownMs: 0, trigger: 'test' })
  assert.equal(s.status, 'done', JSON.stringify(s.errors))
  assert.equal(periodCalls, 10)
  assert.equal(s.pagesWritten, 10)
  assert.equal(s.modelCalls, 10)
  assert.equal(s.capHit, true)
  assert.deepEqual(s.backlog, { periods: 3, digestDays: 0, todayChats: 0 })
  assert.deepEqual(okKeys(capDb, capSid), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(groupStart))
})
await t('cap: the next sweep picks up the older periods (gap before the written pages), same keys and numbering', async () => {
  const s = await runLibrarySweep({ cooldownMs: 0, trigger: 'test' })
  assert.equal(s.pagesWritten, 3)
  assert.equal(periodCalls, 13)
  assert.deepEqual(s.backlog, { periods: 0, digestDays: 0, todayChats: 0 })
  assert.deepEqual(okKeys(capDb, capSid), Array.from({ length: 13 }, (_, g) => groupStart(g)))
  const m = readManifest(libraryDirFor(capDb, capSid), capSid)
  assert.deepEqual(Object.values(m.periods).map(e => e.index).sort((a, b) => a - b), Array.from({ length: 13 }, (_, i) => i + 1))
  assert.equal(pagesOf(capDb, capSid).length, 13)
})
await t('idempotent: a third sweep makes no model call and writes nothing', async () => {
  const s = await runLibrarySweep({ cooldownMs: 0, trigger: 'test' })
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
const lDb = makeSession(lSid, [['user', 'Live work', day(9, 8)], ['assistant', 'still going', day(9, 10)]], '-zz-live')
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
  const s = await runLibrarySweep({ cooldownMs: 0, trigger: 'test', exclude: [lSid], now: NOW })
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
  assert.ok(md.includes('in America/New_York'), 'the page says which time zone its day is in')
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
  const pub = JSON.stringify(h)
  assert.ok(!/costUsd|"ref"|sweep-|\/tmp|\$/.test(pub), `public /health stays counts, times and codes: ${pub}`)
  assert.ok(daySpentNow() > 0, 'page and digest calls are charged to the Library\'s own daily cap')
  assert.equal(daySpent(), 0, 'nothing is charged to the content step\'s cap')
  assert.ok(!existsSync(join(home, LOCK_FILE)), 'the sweep does not leave the lock behind (the worker owns it)')
})
await t('idempotent: second sweep → no model call; digest pages unchanged', async () => {
  const before = readFileSync(join(dDir, '2026-03-02-digest.md'), 'utf-8')
  const s = await runLibrarySweep({ cooldownMs: 0, trigger: 'test', exclude: [lSid], now: NOW })
  assert.equal(s.modelCalls, 0)
  assert.equal(periodCalls + digestCalls, 4)
  assert.equal(readFileSync(join(dDir, '2026-03-02-digest.md'), 'utf-8'), before)
})
await t('digest: a day that gains a chat is rewritten in place (one call, same file)', async () => {
  makeSession('sweep-s4-0001', [['user', 'Afternoon follow up', day(2, 14)], ['assistant', 'answer', day(2, 14, 20)]])
  const s = await runLibrarySweep({ cooldownMs: 0, trigger: 'test', exclude: [lSid], now: NOW })
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
      const s = await runLibrarySweep({ cooldownMs: 0, trigger: 'test', exclude: [lSid], now: NOW })
      assert.equal(periodCalls - before, 1, `sweep ${i}: one attempt`)
      assert.ok(s.errors.some(e => e.kind === 'period' && e.ref === 'sweep-er'))
      assert.equal(readManifest(libraryDirFor(eDb, eSid), eSid).periods['1'].failures, i)
    }
    const before = periodCalls
    const s = await runLibrarySweep({ cooldownMs: 0, trigger: 'test', exclude: [lSid], now: NOW })
    assert.equal(periodCalls, before, 'given up after 3 failures')
    assert.equal(s.backlog?.periods, 0)
  } finally { failPeriods = 'none' }
})
await t('outage: two failed calls in a row stop the sweep, and an outage never counts toward giving up', async () => {
  const dbs = [1, 2, 3].map(n => [`sweep-out-000${n}`, makeSession(`sweep-out-000${n}`, [['user', `Outage work ${n}`, day(7, 8 + n)], ['assistant', 'done', day(7, 9 + n, 30)]])] as const)
  failPeriods = 'http500'
  try {
    const before = periodCalls
    const s = await runLibrarySweep({ cooldownMs: 0, trigger: 'test', exclude: [lSid], now: NOW })
    assert.equal(periodCalls - before, 2, 'stopped after two failures, not all three')
    assert.ok(s.errors.some(e => /twice in a row/.test(e.message ?? '')))
    assert.equal(s.backlog?.periods, 3)
    for (const [sid, db] of dbs) assert.equal(readManifest(libraryDirFor(db, sid), sid).periods['1']?.failures ?? 0, 0)
  } finally { failPeriods = 'none' }
  const s = await runLibrarySweep({ cooldownMs: 0, trigger: 'test', exclude: [lSid], now: NOW })
  assert.equal(s.pagesWritten, 3, 'recovered on the next run')
})
await t('overlap: a digested chat that grows into a period page leaves its digest (rewritten, or removed when empty)', async () => {
  // s1 (2 Mar, 23:00) and s3 (4 Mar, alone on its day) carry on for over an hour → period pages.
  makeSession('sweep-s1-0001', [['assistant', 'more', day(3, 0, 30)]])
  makeSession('sweep-s3-0001', [['assistant', 'more', day(4, 10, 30)]])
  const before = { p: periodCalls, d: digestCalls }
  const s = await runLibrarySweep({ cooldownMs: 0, trigger: 'test', exclude: [lSid], now: NOW })
  assert.equal(s.pagesWritten, 2, JSON.stringify(s.errors))
  assert.deepEqual([periodCalls - before.p, digestCalls - before.d], [2, 0], 'the pages first')
  assert.match(readFileSync(join(dDir, '2026-03-02-digest.md'), 'utf-8'), /Late night question/, 'not stale until a written page covers it')
  // Next run: an ok page now covers those chats' start rows.
  await runLibrarySweep({ cooldownMs: 0, trigger: 'test', exclude: [lSid], now: NOW })
  assert.deepEqual([periodCalls - before.p, digestCalls - before.d], [2, 1], 'one digest rewrite, no call for the removal')
  const md = readFileSync(join(dDir, '2026-03-02-digest.md'), 'utf-8')
  assert.match(md, /^- Chats: 2$/m)
  assert.ok(!md.includes('Late night question') && md.includes('Morning question'), md)
  assert.ok(!existsSync(join(dDir, '2026-03-04-digest.md')), 'a day with no short chat left loses its page')
  assert.equal(readDigestManifest(dDir).days['2026-03-04'], undefined)
  assert.ok(!readFileSync(join(dDir, 'INDEX.md'), 'utf-8').includes('2026-03-04'))
})
await t('a busy day (over 60 chats) records every chat, so it is not re-digested next run', async () => {
  for (let i = 0; i < 61; i++) makeSession(`sweep-busy-${String(i).padStart(4, '0')}`, [['user', `Busy question ${i}`, day(5, 8, i % 60) + Math.floor(i / 60) * H], ['assistant', 'answer', day(5, 8, i % 60) + Math.floor(i / 60) * H + 30_000]])
  const before = digestCalls
  await runLibrarySweep({ cooldownMs: 0, trigger: 'test', exclude: [lSid], now: NOW })
  assert.equal(digestCalls - before, 1)
  const md = readFileSync(join(dDir, '2026-03-05-digest.md'), 'utf-8')
  assert.match(md, /^- Chats: 61$/m)
  assert.match(md, /1 more short chat\(s\) that day are not summarised/)
  assert.equal(readDigestManifest(dDir).days['2026-03-05'].chats.length, 61)
  const s = await runLibrarySweep({ cooldownMs: 0, trigger: 'test', exclude: [lSid], now: NOW })
  assert.equal(digestCalls - before, 1, 'no second call for the same day')
  assert.equal(s.backlog?.digestDays, 0)
})
await t('spend: every call is charged to the Library\'s own daily cap; the sweep stops at it', async () => {
  const cSid = 'sweep-cap-day-0001'
  makeSession(cSid, [['user', 'Capped work', day(6, 8)], ['assistant', 'done', day(6, 10)]])
  process.env.OSBORN_LIBRARY_DAILY_USD = String(daySpentNow() + 0.1) // less than one page's worst case
  try {
    const before = periodCalls
    const s = await runLibrarySweep({ cooldownMs: 0, trigger: 'test', exclude: [lSid], now: NOW })
    assert.equal(periodCalls, before, 'no call once the cap would be crossed')
    assert.equal(s.capHit, true)
    assert.ok(s.errors.some(e => e.kind === 'cap'))
    assert.equal(s.backlog?.periods, 1)
  } finally { delete process.env.OSBORN_LIBRARY_DAILY_USD }
  const spent = daySpentNow()
  const s = await runLibrarySweep({ cooldownMs: 0, trigger: 'test', exclude: [lSid], now: NOW })
  assert.equal(s.pagesWritten, 1)
  assert.ok(daySpentNow() > spent && daySpentNow() - spent < 0.1, 'settled to the actual cost, not the worst case')
})
await t('cooldown: no sweep starts within 30 min of the last one; the last result stays', async () => {
  const before = periodCalls + digestCalls
  const s = await runLibrarySweep({ trigger: 'test-cooldown', exclude: [lSid], now: NOW })
  assert.equal(s.status, 'cooldown')
  assert.equal(periodCalls + digestCalls, before)
  assert.equal(readSweepStatus()?.trigger, 'test', 'status file not overwritten')
  assert.equal(launchLibrarySweep([], 'test').status, 'cooldown', 'the launcher does not spawn either')
  assert.ok(!existsSync(join(home, LOCK_FILE)))
})
await t('live project: a backlog period in a project a live session uses waits (counted, not written)', async () => {
  const wSid = 'sweep-liveproj-0001'
  const wDb = makeSession(wSid, [['user', 'Same project as the live one', day(9, 1)], ['assistant', 'done', day(9, 3)]], '-zz-live')
  const before = periodCalls
  const s = await runLibrarySweep({ cooldownMs: 0, trigger: 'test', exclude: [lSid], now: NOW })
  assert.equal(periodCalls, before, 'no page while that project is live')
  assert.deepEqual(pagesOf(wDb, wSid), [])
  assert.equal(s.backlog?.periods, 1, 'still counted as backlog')
})
await t('dry run: writes only under <home>/dry; real digests, manifests, scan cache and status untouched', async () => {
  const snap = () => ({
    status: readFileSync(join(home, SWEEP_STATUS_FILE), 'utf-8'),
    cache: readFileSync(join(home, 'sweep-scan.json'), 'utf-8'),
    digests: readdirSync(dDir).sort().map(f => [f, statSync(join(dDir, f)).mtimeMs]),
    manifest: readFileSync(join(dDir, '.digest-manifest.json'), 'utf-8'),
  })
  const before = snap()
  const calls = periodCalls + digestCalls
  const s = await runLibrarySweep({ cooldownMs: 0, dry: true, trigger: 'dry', now: NOW }) // nothing excluded: the live-project period is pending
  assert.equal(periodCalls + digestCalls, calls, 'no model call')
  assert.ok(s.modelCalls >= 1)
  assert.deepEqual(snap(), before)
  assert.ok(readdirSync(join(home, 'dry')).length > 0, 'dry output went to the dry dir')
  assert.deepEqual(pagesOf(lDb, lSid), [], 'no dry page in the real library')
})
await t('cooldown also follows a sweep that errored or died (from finishedAt, else its start)', async () => {
  const saved = readFileSync(join(home, SWEEP_STATUS_FILE), 'utf-8')
  try {
    writeSweepStatus({ status: 'error', at: new Date().toISOString(), finishedAt: new Date().toISOString() })
    assert.equal((await runLibrarySweep({ trigger: 'cool', now: NOW })).status, 'cooldown')
    writeSweepStatus({ status: 'running', pid: 2 ** 22 + 12345, at: new Date().toISOString(), finishedAt: undefined })
    assert.equal(readSweepStatus()?.status, 'died')
    assert.equal((await runLibrarySweep({ trigger: 'cool', now: NOW })).status, 'cooldown')
    writeSweepStatus({ status: 'error', at: new Date(Date.now() - 2 * H).toISOString(), finishedAt: new Date(Date.now() - 2 * H).toISOString() })
    assert.notEqual((await runLibrarySweep({ trigger: 'cool', exclude: [lSid], now: NOW })).status, 'cooldown', 'an old one does not hold it back')
  } finally { writeFileSync(join(home, SWEEP_STATUS_FILE), saved) }
})
await t('an emptied day that was already ingested is rewritten in place and re-sent; a never-ingested one is deleted', async () => {
  process.env.OSBORN_SYNC_TOKEN = 'test-token'
  try {
    const m = readDigestManifest(dDir)
    const day = '2026-03-02'
    m.days[day].ingest = { status: 'ok', contentHash: 'x', at: new Date().toISOString() }
    writeDigestManifest(dDir, m)
    const before = ingestCalls
    await removeDigestDay(dDir, day)
    assert.equal(ingestCalls - before, 1, 'the rewrite went through ingest')
    assert.ok(existsSync(join(dDir, `${day}-digest.md`)))
    assert.match(readFileSync(join(dDir, `${day}-digest.md`), 'utf-8'), /^- Chats: 0$/m)
    assert.deepEqual(readDigestManifest(dDir).days[day].chats, [])
    const m2 = readDigestManifest(dDir)
    m2.days['2026-03-05'].ingest = undefined
    writeDigestManifest(dDir, m2)
    await removeDigestDay(dDir, '2026-03-05')
    assert.ok(!existsSync(join(dDir, '2026-03-05-digest.md')) && !readDigestManifest(dDir).days['2026-03-05'])
  } finally { delete process.env.OSBORN_SYNC_TOKEN }
})
await t('segmentation reads ids and timestamps only (a row whose blob cannot be read still has its stamp)', () => {
  const sid = 'sweep-stamps-0001'
  const dbp = makeSession(sid, [['user', 'one', day(1, 1)], ['assistant', 'two', day(1, 2)]], '-zz-stamps')
  const raw = new Database(dbp)
  raw.prepare('INSERT INTO content(source, ts, msg_type, blob) VALUES (?,?,?,?)').run('main', new Date(day(1, 3)).toISOString(), 'user', Buffer.from('not brotli'))
  raw.close()
  assert.deepEqual(loadRowStamps(dbp).map(r => r.id), [1, 2, 3])
})
await t('a gap period whose file name is another page\'s is logged, not silently skipped', () => {
  const sid = 'sweep-collide-0001'
  const dbp = makeSession(sid, [
    ['user', 'first', day(1, 1)], ['assistant', 'first done', day(1, 2, 30)],
    ['user', seam('second'), day(1, 3)], ['assistant', 'second done', day(1, 4, 30)],
  ], '-zz-collide')
  const m = { version: 1, sessionId: sid, periods: { '3': { startRowId: 3, endRowId: 4, closedBy: 'compaction', index: 1, file: '2026-03-01-period-01.md', status: 'ok', costUsd: 0, errors: [], updatedAt: '' } } } as any
  const logs: string[] = []
  const b = libraryBacklog(dbp, m, H, l => logs.push(l))
  assert.deepEqual(b.periods, [])
  assert.ok(logs.some(l => /period #1–#2 would be 2026-03-01-period-01\.md, which is period #3's page/.test(l)), logs.join('\n'))
})
await t('a day whose chats are all injected context costs nothing and publishes nothing', async () => {
  const tail = '<session_tail>\n2026-03-07T09:00  Assistant: replayed\n</session_tail>'
  await runLibrarySweep({ cooldownMs: 0, trigger: 'test', exclude: [lSid], now: NOW }) // settle what earlier tests left pending
  makeSession('sweep-empty-0001', [['user', tail, day(7, 9)], ['user', tail, day(7, 9, 5)]], '-zz-empty')
  const before = { d: digestCalls, i: ingestCalls, spent: daySpentNow() }
  const s = await runLibrarySweep({ cooldownMs: 0, trigger: 'test', exclude: [lSid], now: NOW })
  assert.equal(digestCalls, before.d, 'no model call')
  assert.equal(ingestCalls, before.i, 'no ingest')
  assert.equal(daySpentNow(), before.spent, 'nothing charged')
  assert.ok(!existsSync(join(dDir, '2026-03-07-digest.md')), 'no page')
  assert.equal(readDigestManifest(dDir).days['2026-03-07']?.status, 'empty')
  assert.equal(s.digestsWritten, 0)
  assert.equal(s.backlog?.digestDays, 0, 'the day is settled, not pending')
  await runLibrarySweep({ cooldownMs: 0, trigger: 'test', exclude: [lSid], now: NOW })
  assert.equal(digestCalls, before.d, 'and it is not reprocessed')
})
await t('a day rewrite never drops a chat from a session not read this run; a live session\'s cached chats count', async () => {
  // s2 (2 Mar) is live but settled in the cache: its chat is kept when a new chat joins its day.
  makeSession('sweep-s5-0001', [['user', 'Evening question', day(2, 19)], ['assistant', 'answer', day(2, 19, 10)]])
  await runLibrarySweep({ cooldownMs: 0, trigger: 'test', exclude: [lSid, 'sweep-s2-0001'], now: NOW })
  let md = readFileSync(join(dDir, '2026-03-02-digest.md'), 'utf-8')
  assert.ok(md.includes('Morning question') && md.includes('Evening question'), md)
  // With no cache entry for the live s2, the day cannot be rewritten safely: it waits.
  rmSync(join(home, 'sweep-scan.json'), { force: true })
  makeSession('sweep-s6-0001', [['user', 'Night question', day(2, 21)], ['assistant', 'answer', day(2, 21, 10)]])
  const before = digestCalls
  const s = await runLibrarySweep({ cooldownMs: 0, trigger: 'test', exclude: [lSid, 'sweep-s2-0001'], now: NOW })
  assert.equal(digestCalls, before, 'the day waits')
  assert.ok(!readFileSync(join(dDir, '2026-03-02-digest.md'), 'utf-8').includes('Night question'))
  assert.ok(s.backlog!.digestDays >= 1, 'and is still counted')
  // Once s2 is readable again the day is rewritten with every chat. Meanwhile /health keeps the last backlog.
  const prevBacklog = readSweepStatus()!.backlog
  captureMid = true
  try {
    await runLibrarySweep({ cooldownMs: 0, trigger: 'test', exclude: [lSid], now: NOW })
  } finally { captureMid = false }
  md = readFileSync(join(dDir, '2026-03-02-digest.md'), 'utf-8')
  assert.ok(md.includes('Morning question') && md.includes('Evening question') && md.includes('Night question'), md)
  assert.equal(midStatus?.status, 'running')
  assert.equal(midStatus?.finishedAt, null, 'the previous end is cleared while running')
  assert.deepEqual(midStatus?.backlog, prevBacklog, 'the backlog is not wiped while a sweep runs')
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
