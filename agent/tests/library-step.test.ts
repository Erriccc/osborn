// Library step tests: period selection at compaction seams, idempotency, opt-out, fail-open.
// Run: npx tsx agent/tests/library-step.test.ts   (one file at a time; no network — fetch is stubbed)
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync } from 'node:zlib'
import Database from 'better-sqlite3'

const tmp = mkdtempSync(join(tmpdir(), 'library-test-'))
process.env.CLAUDE_CONFIG_DIR = join(tmp, 'claude')
const deny = join(tmp, 'deny.json')
writeFileSync(deny, JSON.stringify({ terms: { '[client]': ['Acme'] } }))
process.env.OSBORN_LENS_DENYLIST = deny
process.env.OPENROUTER_API_KEY = 'dummy-not-a-key'
delete process.env.OSBORN_CONTENT_LENS
delete process.env.OSBORN_CONTENT_LENS_MODEL
process.env.OSBORN_LIBRARY_MIN_PERIOD_H = '4' // fixtures are built on 4h periods; the default is now 1h
delete process.env.OSBORN_SYNC_TOKEN // cloud ingest is covered by library-ingest.test.ts; keep this file offline

const { segmentPeriods, pickLibraryPeriod, pageFileName } = await import('../src/content/lens-library-select.js')
const { runLibraryStep, readManifest, libraryDirFor, librarySegments, MANIFEST_FILE } = await import('../src/content/lens-library.js')
const { parsePage } = await import('../src/content/lens-library-index.js')
const { launchCompactionLens } = await import('../src/content/lens-launch.js')
const { LOCK_FILE } = await import('../src/content/lens-paths.js')

let pass = 0
const t = async (name: string, fn: () => unknown) => {
  try { await fn(); pass++; console.log('ok   ', name) } catch (e: any) { console.log('FAIL ', name, '\n     ', e.message.split('\n')[0]); process.exitCode = 1 }
}

const H = 3_600_000
const T0 = Date.UTC(2026, 0, 1, 8, 0)
const iso = (h: number) => new Date(T0 + h * H).toISOString()
const seam = (words: string) => `<session_tail>\n2026-01-01T09:00  Assistant: replayed\n</session_tail>\n\n${words}`
// [msg_type, text, hour]
const ROWS: [string, string, number][] = [
  ['user', 'Kick off the lens work for Acme today', 0],                     // 1
  ['assistant', 'Starting the lens worker now', 1],                         // 2
  ['user', 'Keep going with the worker please', 2],                         // 3
  ['assistant', 'Worker is wired and logging', 5],                          // 4  P1 = #1–#4 (5h)
  ['user', seam('Right after compaction, back to the library'), 6],         // 5  seam
  ['assistant', 'Picking the library up again', 6.2],                       // 6
  ['user', seam('Compacted again already, keep going'), 6.5],               // 7  seam (cluster: merged forward)
  ['user', 'We finally shipped the period library writer today', 7],        // 8
  ['assistant', 'The library writer is live and tested', 9],                // 9
  ['user', 'Great, the index table looks right to me', 11],                 // 10 P2 = #5–#10 (5h)
  ['user', seam('New period: start on the ingest seam'), 12],               // 11 seam
  ['assistant', 'Ingest stays a no-op for now', 13],                        // 12 tail #11–#12 (1h)
]
const pd = join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-zz-library')
const sid = 'library-test-session-0001'
mkdirSync(join(pd, 'osb', sid), { recursive: true })
const dbPath = join(pd, 'osb', sid, 'session.db')
const db = new Database(dbPath)
db.exec(`CREATE TABLE content(id INTEGER PRIMARY KEY, source TEXT, line_num INT, byte_offset INT, ts TEXT, msg_type TEXT, model TEXT, git_branch TEXT, cwd TEXT, tool_name TEXT, blob BLOB)`)
const addRow = (type: string, text: string, h: number) =>
  db.prepare('INSERT INTO content(source, ts, msg_type, blob) VALUES (?,?,?,?)').run('main', iso(h), type, brotliCompressSync(Buffer.from(text)))
for (const [type, text, h] of ROWS) addRow(type, text, h)
const libDir = libraryDirFor(dbPath, sid)

// ── stubbed OpenRouter ──
let chatCalls = 0
let chatMode: 'ok' | 'http500' = 'ok'
const MODEL_REPLY = JSON.stringify({
  high_leverage: [{ title: 'Period library writer shipped', why: 'one page per period, automatically', evidence: 'shipped', quotes: [{ row: 8, text: 'We finally shipped the period library writer today' }] }],
  period_goal: { text: 'Ship the automatic period library.', quotes: [{ row: 8, text: 'shipped the period library writer' }] },
  arc: [], what_worked: { held_up: [], didnt: [] },
  stories: [{ title: 'The library writer', why_it_matters: 'no manual runs', from_row: 8, to_row: 10, turning_points: [{ moment: 'index looks right', user_lines: [{ row: 10, text: 'the index table looks right to me' }] }] }],
  angles: [],
})
globalThis.fetch = (async (url: any) => {
  const u = String(url)
  if (u.endsWith('/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'minimax/minimax-m3', context_length: 1_048_576, pricing: { prompt: '0.0000003', completion: '0.0000012' } }] }), { status: 200 })
  }
  chatCalls++
  if (chatMode === 'http500') return new Response('upstream down', { status: 500 })
  return new Response(JSON.stringify({ choices: [{ message: { content: MODEL_REPLY }, finish_reason: 'stop' }], usage: { prompt_tokens: 900, completion_tokens: 300, cost: 0.0012 }, provider: 'stub' }), { status: 200 })
}) as typeof fetch

const stamps = (n = Infinity) => ROWS.slice(0, n).map((r, i) => ({ id: i + 1, timestamp: iso(r[2]) }))
const pages = () => (existsSync(libDir) ? readdirSync(libDir).filter(f => /-period-\d+\.md$/.test(f)).sort() : [])

// ── boundary selection (pure) ──
await t('segment: closes at a seam only once the group spans >= 4h; seam clusters merge forward', () => {
  const s = segmentPeriods(stamps(), [5, 7, 11], 4 * H)
  assert.deepEqual(s.closed.map(p => [p.index, p.startRowId, p.endRowId, p.closedBy]), [[1, 1, 4, 5], [2, 5, 10, 11]])
  assert.deepEqual([s.tail?.index, s.tail?.startRowId, s.tail?.endRowId, s.tail?.closedBy], [3, 11, 12, null])
})
await t('segment: numbering/keys of earlier periods never change when later seams arrive', () => {
  const early = segmentPeriods(stamps(10), [5, 7])
  const late = segmentPeriods(stamps(), [5, 7, 11])
  assert.deepEqual(early.closed[0], late.closed[0])
  assert.equal(early.tail?.startRowId, late.closed[1].startRowId)
})
await t('segment: no seams → whole session is the tail (first compaction); empty → nothing', () => {
  const s = segmentPeriods(stamps(), [])
  assert.deepEqual([s.closed.length, s.tail?.startRowId, s.tail?.endRowId], [0, 1, 12])
  assert.deepEqual(segmentPeriods([], [3]), { closed: [], tail: null })
})
await t('pick: short tail → last seam-closed period; long tail → tail; done → deferred / already-written', () => {
  const s = segmentPeriods(stamps(), [5, 7, 11], 4 * H)
  const a = pickLibraryPeriod(s, () => false, 4 * H)
  assert.equal(a.reason, 'last-closed'); assert.equal(a.period?.startRowId, 5)
  assert.equal(pickLibraryPeriod(s, k => k === 5, 4 * H).reason, 'deferred')
  const long = segmentPeriods([...stamps(), { id: 13, timestamp: iso(17) }], [5, 7, 11], 4 * H)
  const b = pickLibraryPeriod(long, () => false, 4 * H)
  assert.equal(b.reason, 'tail'); assert.equal(b.period?.startRowId, 11)
  assert.equal(pickLibraryPeriod(long, () => true, 4 * H).reason, 'already-written')
})
await t('daily run: a written tail closes its period, so the next run picks up after it (no compaction)', () => {
  const rows = [{ id: 1, timestamp: iso(0) }, { id: 2, timestamp: iso(1.5) }, { id: 3, timestamp: iso(2) }, { id: 4, timestamp: iso(3.5) }]
  const first = pickLibraryPeriod(segmentPeriods(rows.slice(0, 2), [], H), () => false, H)
  assert.equal(first.reason, 'tail'); assert.equal(first.period?.endRowId, 2)
  const next = pickLibraryPeriod(segmentPeriods(rows, [first.period!.endRowId + 1], H), (k) => k === 1, H)
  assert.equal(next.reason, 'tail'); assert.equal(next.period?.startRowId, 3)
})
await t('pageFileName: <start date>-period-<NN>.md (backfill scheme)', () => {
  assert.equal(pageFileName({ index: 2, fromTs: '2026-08-23T03:09:52.058Z' }), '2026-08-23-period-02.md')
  assert.equal(pageFileName({ index: 11, fromTs: '' }), 'undated-period-11.md')
})

// ── opt-out ──
await t('opt-out: OSBORN_CONTENT_LENS=0 → step disabled, launcher disabled, nothing written', async () => {
  process.env.OSBORN_CONTENT_LENS = '0'
  try {
    const r = await runLibraryStep({ sessionId: sid })
    assert.equal(r.status, 'disabled')
    assert.equal(launchCompactionLens({ sessionId: sid, cwd: '/zz/library' }).status, 'disabled')
    assert.equal(chatCalls, 0)
    assert.ok(!existsSync(libDir))
  } finally { delete process.env.OSBORN_CONTENT_LENS }
})
await t('opt-out: worker --library exits 0 with status=disabled and releases its lock', () => {
  const worker = fileURLToPath(new URL('../src/content/compaction-lens-worker.ts', import.meta.url))
  const res = spawnSync('npx', ['tsx', worker, '--library', sid], {
    env: { ...process.env, OSBORN_CONTENT_LENS: '0' }, encoding: 'utf-8', timeout: 60_000,
  })
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /"status":"disabled"/)
  assert.ok(!existsSync(join(pd, LOCK_FILE)))
  assert.ok(!existsSync(libDir))
})

// ── fail-open ──
await t('fail-open: model HTTP 500 → no throw, nothing published, manifest status=error', async () => {
  chatMode = 'http500'
  const r = await runLibraryStep({ sessionId: sid })
  assert.equal(r.status, 'model-error')
  assert.equal(r.page, null)
  assert.ok(r.errors.some(e => /HTTP 500/.test(e)), r.errors.join('; '))
  assert.deepEqual(pages(), [])
  assert.ok(!existsSync(join(libDir, 'INDEX.md')))
  assert.equal(readManifest(libDir, sid).periods['5'].status, 'error')
})
await t('fail-open: unexpected error (unknown model, cost cap unenforceable) → status=failed, no throw', async () => {
  process.env.OSBORN_CONTENT_LENS_MODEL = 'nope/not-a-model'
  try {
    const r = await runLibraryStep({ sessionId: sid })
    assert.equal(r.status, 'failed')
    assert.ok(r.errors.some(e => /model info unavailable/.test(e)))
    assert.deepEqual(pages(), [])
  } finally { delete process.env.OSBORN_CONTENT_LENS_MODEL }
})

// ── success + idempotency ──
await t('written: one page for the period that just ended + INDEX.md; errored period is retried', async () => {
  chatMode = 'ok'
  const before = chatCalls
  // A legacy (backfill-style) page with the same name must be replaced, not duplicated.
  writeFileSync(join(libDir, '2026-01-01-period-02.md'), '# legacy page\n')
  const r = await runLibraryStep({ sessionId: sid })
  assert.equal(r.status, 'written', r.errors.join('; '))
  assert.equal(chatCalls - before, 1)
  assert.deepEqual(pages(), ['2026-01-01-period-02.md'])
  const md = readFileSync(r.page!, 'utf-8')
  assert.ok(md.startsWith('<!-- osborn-library: key=5 rows=5-10 closed-by=11 period=2 -->'), md.slice(0, 120))
  assert.ok(md.includes('Period library writer shipped') && !md.includes('Acme'))
  const idx = readFileSync(join(libDir, 'INDEX.md'), 'utf-8')
  assert.ok(idx.includes('| 02 | 2026-01-01 14:00 → 2026-01-01 19:00 | #5–#10 | Ship the automatic period library.'), idx)
  assert.ok(idx.includes('The library writer') && idx.includes('(row #10)'))
  assert.equal(readManifest(libDir, sid).periods['5'].status, 'ok')
})
await t('idempotent: re-run on the same period → no model call, no new page, INDEX unchanged', async () => {
  const before = chatCalls
  const idx = readFileSync(join(libDir, 'INDEX.md'), 'utf-8')
  const r = await runLibraryStep({ sessionId: sid })
  assert.equal(r.status, 'deferred') // tail still < 4h, period 2 already written
  assert.equal(chatCalls, before)
  assert.deepEqual(pages(), ['2026-01-01-period-02.md'])
  assert.equal(readFileSync(join(libDir, 'INDEX.md'), 'utf-8'), idx)
})
await t('next compaction: once the tail spans 4h it becomes period 03; a third run writes nothing new', async () => {
  addRow('user', 'Four hours later the ingest seam is still a no-op', 17)
  const r = await runLibraryStep({ sessionId: sid })
  assert.equal(r.status, 'written')
  assert.equal(r.period?.closedBy, null)
  assert.deepEqual(pages(), ['2026-01-01-period-02.md', '2026-01-01-period-03.md'])
  assert.ok(readFileSync(r.page!, 'utf-8').includes('closed-by=compaction period=3'))
  // the real seam for that compaction lands later: same key → skipped
  addRow('user', seam('After the compaction'), 17.5)
  const again = await runLibraryStep({ sessionId: sid })
  assert.equal(again.status, 'deferred')
  assert.deepEqual(pages(), ['2026-01-01-period-02.md', '2026-01-01-period-03.md'])
  const idx = readFileSync(join(libDir, 'INDEX.md'), 'utf-8')
  assert.equal((idx.match(/\| 0[23] \|/g) ?? []).length, 2)
  assert.ok(existsSync(join(libDir, MANIFEST_FILE)))
})
await t('upgrade: pages written at 4h keep their rows, index and file when the period becomes 1h', () => {
  process.env.OSBORN_LIBRARY_MIN_PERIOD_H = '1'
  try {
    const m = readManifest(libraryDirFor(dbPath, sid), sid)
    const ok = Object.values(m.periods).filter((e) => e.status === 'ok')
    assert.ok(ok.length >= 2, 'fixture wrote pages at 4h')
    const seg = librarySegments(dbPath, m)
    for (const e of ok) {
      const p = seg.closed.find((c) => c.startRowId === e.startRowId)
      assert.ok(p, `written period #${e.startRowId} still present`)
      assert.deepEqual([p!.endRowId, p!.index], [e.endRowId, e.index], 'frozen: same rows and index')
    }
    // A 4h page that holds a seam an hour or more in: at 1h that seam would split it.
    const sid2 = 'library-test-session-0002'
    mkdirSync(join(pd, 'osb', sid2), { recursive: true })
    const db2Path = join(pd, 'osb', sid2, 'session.db')
    const db2 = new Database(db2Path)
    db2.exec(`CREATE TABLE content(id INTEGER PRIMARY KEY, source TEXT, line_num INT, byte_offset INT, ts TEXT, msg_type TEXT, model TEXT, git_branch TEXT, cwd TEXT, tool_name TEXT, blob BLOB)`)
    for (const [type, text, h] of [['user', 'start', 0], ['assistant', 'ok', 1], ['user', seam('after a compaction'), 2], ['assistant', 'more', 3], ['user', 'end of page one', 4.5], ['assistant', 'later work', 6]] as [string, string, number][])
      db2.prepare('INSERT INTO content(source, ts, msg_type, blob) VALUES (?,?,?,?)').run('main', iso(h), type, brotliCompressSync(Buffer.from(text)))
    db2.close()
    const m2 = { version: 1, sessionId: sid2, periods: { '1': { startRowId: 1, endRowId: 5, closedBy: 'compaction', index: 1, file: '2026-01-01-period-01.md', status: 'ok', costUsd: 0, errors: [], updatedAt: '' } } } as any
    const seg2 = librarySegments(db2Path, m2)
    assert.deepEqual(seg2.closed.map((p) => [p.startRowId, p.endRowId, p.index]), [[1, 5, 1]], 'the 4h page is not split at its inner seam')
    assert.deepEqual(seg2.tail && [seg2.tail.startRowId, seg2.tail.index], [6, 2], 'new rows continue as period 02')
    const maxIdx = Math.max(...ok.map((e) => e.index)), maxEnd = Math.max(...ok.map((e) => e.endRowId))
    for (const p of [...seg.closed.filter((c) => c.startRowId > maxEnd), ...(seg.tail ? [seg.tail] : [])])
      assert.ok(p.index > maxIdx && p.startRowId > maxEnd, 'new periods come after the written ones')
  } finally { process.env.OSBORN_LIBRARY_MIN_PERIOD_H = '4' }
})
await t('parsePage: reads goal / top item / stories from a renderPeriodMd page', () => {
  const p = parsePage('2026-01-01-period-02.md', readFileSync(join(libDir, '2026-01-01-period-02.md'), 'utf-8'))
  assert.equal(p.index, 2)
  assert.equal(p.topItem, 'Period library writer shipped [shipped]')
  assert.equal(p.stories.length, 1)
  assert.ok(p.costUsd > 0)
})

db.close()
console.log(`\n${pass} passed`)
