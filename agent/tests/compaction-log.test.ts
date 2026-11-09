// Compaction integrity — durable persist / reconstruct / ordering / self-check.
// Covers the agent side of the "Conversation compacted" marker surviving resume:
// the sidecar append + read, chronological ordering (what the frontend interleaves),
// and the append-only integrity check that flags dropped transcript content.
// Run: npx tsx agent/tests/compaction-log.test.ts
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const {
  serializeCompactionRecord,
  parseCompactionLog,
  checkCompactionIntegrity,
  toCompactionMarker,
  appendCompactionRecord,
  readCompactionRecords,
  readCompactionMarkers,
  getCompactionLogPath,
} = await import('../src/compaction-log.js')

let pass = 0
const t = (name: string, fn: () => unknown) => {
  try { fn(); pass++; console.log('ok   ', name) }
  catch (e: any) { console.log('FAIL ', name, '\n     ', String(e?.message ?? e).split('\n')[0]); process.exitCode = 1 }
}

const tempRoots: string[] = []
function makeEnv() {
  const root = mkdtempSync(join(tmpdir(), 'compaction-log-test-'))
  tempRoots.push(root)
  // getStorePath() → getOsbDir() reads CLAUDE_CONFIG_DIR, so the sidecar lands under temp.
  process.env.CLAUDE_CONFIG_DIR = join(root, 'claude')
  return {
    workingDir: join(root, 'proj'),
    sessionId: 'sess-' + Math.random().toString(36).slice(2, 10),
  }
}

// ── pure: serialize / parse round-trip ──────────────────────────────────────
t('serialize + parse round-trips a record', () => {
  const rec = { v: 1 as const, at: '2026-11-09T10:00:00.000Z', trigger: 'auto', skillsWritten: 2, skillNames: ['decisions', 'user-context'], transcriptRows: 40 }
  const [back] = parseCompactionLog(serializeCompactionRecord(rec))
  assert.deepEqual(back, rec)
})

// ── pure: parse tolerance ───────────────────────────────────────────────────
t('parse skips blank, malformed, and wrong-version lines', () => {
  const good = serializeCompactionRecord({ v: 1, at: '2026-11-09T10:00:00.000Z', skillsWritten: 0, skillNames: [], transcriptRows: 1 })
  const blob = ['', '  ', '{not json', JSON.stringify({ v: 2, at: 'x', skillsWritten: 0, skillNames: [] }), good, '{"half":'].join('\n')
  const recs = parseCompactionLog(blob)
  assert.equal(recs.length, 1)
  assert.equal(recs[0].at, '2026-11-09T10:00:00.000Z')
})

// ── pure: ordering (reconstruct position) ───────────────────────────────────
t('parse returns records chronological by `at` regardless of file order', () => {
  const mk = (at: string, rows: number) => serializeCompactionRecord({ v: 1, at, skillsWritten: 0, skillNames: [], transcriptRows: rows })
  const blob = [
    mk('2026-11-09T12:00:00.000Z', 90),
    mk('2026-11-09T10:00:00.000Z', 30),
    mk('2026-11-09T11:00:00.000Z', 60),
  ].join('\n')
  assert.deepEqual(parseCompactionLog(blob).map(r => r.transcriptRows), [30, 60, 90])
})

// ── pure: integrity self-check ──────────────────────────────────────────────
t('integrity: no prev → no warning', () => {
  assert.equal(checkCompactionIntegrity(undefined, 10), undefined)
})
t('integrity: rows grew or held → no warning', () => {
  const prev = { v: 1 as const, at: 'x', skillsWritten: 0, skillNames: [], transcriptRows: 50 }
  assert.equal(checkCompactionIntegrity(prev, 50), undefined)
  assert.equal(checkCompactionIntegrity(prev, 73), undefined)
})
t('integrity: rows shrank → warning (append-only violated = content dropped)', () => {
  const prev = { v: 1 as const, at: 'x', skillsWritten: 0, skillNames: [], transcriptRows: 50 }
  const w = checkCompactionIntegrity(prev, 42)
  assert.ok(w && /50/.test(w) && /42/.test(w), 'warning names the row counts')
})

// ── pure: marker projection ─────────────────────────────────────────────────
t('toCompactionMarker drops store internals, keeps surface fields', () => {
  const m = toCompactionMarker({ v: 1, at: '2026-11-09T10:00:00.000Z', trigger: 'auto', skillsWritten: 1, skillNames: ['decisions'], transcriptRows: 99, integrityWarning: 'oops' })
  assert.deepEqual(m, { at: '2026-11-09T10:00:00.000Z', trigger: 'auto', skillNames: ['decisions'], skillsWritten: 1, integrityWarning: 'oops' })
  assert.ok(!('transcriptRows' in m))
})

// ── io: append → read round-trip (persist/reconstruct) ──────────────────────
t('append then read reconstructs the markers from the sidecar', () => {
  const { sessionId, workingDir } = makeEnv()
  assert.equal(readCompactionRecords(sessionId, workingDir).length, 0, 'empty before any write')
  appendCompactionRecord(sessionId, workingDir, { at: '2026-11-09T10:00:00.000Z', trigger: 'auto', skillsWritten: 2, skillNames: ['decisions', 'user-context'], transcriptRows: 30 })
  assert.ok(existsSync(getCompactionLogPath(sessionId, workingDir)), 'sidecar file created')
  const recs = readCompactionRecords(sessionId, workingDir)
  assert.equal(recs.length, 1)
  assert.deepEqual(recs[0].skillNames, ['decisions', 'user-context'])
  assert.equal(recs[0].transcriptRows, 30)
  const markers = readCompactionMarkers(sessionId, workingDir)
  assert.equal(markers[0].skillsWritten, 2)
})

// ── io: second append with fewer rows persists the integrity warning ────────
t('append flags + persists an integrity warning when rows drop', () => {
  const { sessionId, workingDir } = makeEnv()
  const first = appendCompactionRecord(sessionId, workingDir, { at: '2026-11-09T10:00:00.000Z', skillsWritten: 1, skillNames: ['a'], transcriptRows: 80 })
  assert.equal(first.integrityWarning, undefined, 'first compaction never warns')
  const second = appendCompactionRecord(sessionId, workingDir, { at: '2026-11-09T11:00:00.000Z', skillsWritten: 1, skillNames: ['b'], transcriptRows: 55 })
  assert.ok(second.integrityWarning, 'drop 80→55 warns')
  // Durable: the warning is on disk, so a reload surfaces it too.
  const reread = readCompactionRecords(sessionId, workingDir)
  assert.equal(reread.length, 2)
  assert.ok(reread[1].integrityWarning, 'warning persisted to the sidecar')
})

// ── io: a healthy growing session never warns ───────────────────────────────
t('monotonic growth across compactions → no warnings persisted', () => {
  const { sessionId, workingDir } = makeEnv()
  appendCompactionRecord(sessionId, workingDir, { at: '2026-11-09T10:00:00.000Z', skillsWritten: 0, skillNames: [], transcriptRows: 20 })
  appendCompactionRecord(sessionId, workingDir, { at: '2026-11-09T11:00:00.000Z', skillsWritten: 0, skillNames: [], transcriptRows: 45 })
  appendCompactionRecord(sessionId, workingDir, { at: '2026-11-09T12:00:00.000Z', skillsWritten: 0, skillNames: [], transcriptRows: 45 })
  const recs = readCompactionRecords(sessionId, workingDir)
  assert.equal(recs.length, 3)
  assert.ok(recs.every(r => !r.integrityWarning), 'no warnings when append-only holds')
  // Durable file is literally newline-delimited JSON (append-only sidecar).
  const raw = readFileSync(getCompactionLogPath(sessionId, workingDir), 'utf-8').trim().split('\n')
  assert.equal(raw.length, 3)
})

for (const r of tempRoots) { try { rmSync(r, { recursive: true, force: true }) } catch {} }

console.log(`\n${pass} passed`)
