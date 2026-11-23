// Follow-through (#378) shared sidecar helpers: torn-line safe reads and appends.
// Run: npx tsx agent/tests/jsonl-sidecar.test.ts
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const root = mkdtempSync(join(tmpdir(), 'jsonl-sidecar-test-'))
process.env.CLAUDE_CONFIG_DIR = root
const { appendJsonlLine, readJsonlLines } = await import('../src/jsonl-sidecar.js')
const { getSidecarPath, getStorePath } = await import('../src/session-store.js')
const { getCompactionLogPath, appendCompactionRecord, readCompactionRecords } = await import('../src/compaction-log.js')
const { getStewardLogPath, appendStewardRecord, readStewardRecords } = await import('../src/steward-verdict.js')

let pass = 0
const t = (name: string, fn: () => unknown) => {
  try { fn(); pass++; console.log('ok   ', name) }
  catch (e: any) { console.log('FAIL ', name, '\n     ', String(e?.message ?? e).split('\n')[0]); process.exitCode = 1 }
}

t('torn final line is skipped on read', () => {
  const p = join(root, 'a', 'x.jsonl')
  appendJsonlLine(p, JSON.stringify({ n: 1 }))
  appendFileSync(p, '{"n":2, "half')
  assert.deepEqual(readJsonlLines(p), [{ n: 1 }])
})

t('append after a torn line starts a fresh line (no gluing)', () => {
  const p = join(root, 'b', 'x.jsonl')
  appendJsonlLine(p, JSON.stringify({ n: 1 }))
  appendFileSync(p, '{"n":2, "torn')
  appendJsonlLine(p, JSON.stringify({ n: 3 }))
  assert.deepEqual(readJsonlLines(p), [{ n: 1 }, { n: 3 }])
  assert.ok(readFileSync(p, 'utf-8').endsWith('{"n":3}\n'))
})

t('missing file reads as empty', () => {
  assert.deepEqual(readJsonlLines(join(root, 'nope.jsonl')), [])
})

t('sidecar path is beside session.db', () => {
  const p = getSidecarPath('sid-1', '/work/proj', 'loops.jsonl')
  assert.equal(dirname(p), dirname(getStorePath('sid-1', '/work/proj')))
  assert.ok(p.endsWith('loops.jsonl'))
})

t('compaction and steward helpers delegate and keep their outputs byte-identical', () => {
  assert.equal(getCompactionLogPath('s2', '/w'), getSidecarPath('s2', '/w', 'compactions.jsonl'))
  assert.equal(getStewardLogPath('s2', '/w'), getSidecarPath('s2', '/w', 'steward.jsonl'))
  const rec = appendCompactionRecord('s2', '/w', { at: '2026-11-01T00:00:00.000Z', skillsWritten: 1, skillNames: ['a'], transcriptRows: 3 })
  assert.equal(readFileSync(getCompactionLogPath('s2', '/w'), 'utf-8'), JSON.stringify(rec) + '\n')
  assert.equal(readCompactionRecords('s2', '/w').length, 1)
  const gate = { gate: 'deny', message: 'm', at: '2026-11-01T00:00:00.000Z' } as any
  appendStewardRecord('s2', '/w', gate)
  assert.equal(readFileSync(getStewardLogPath('s2', '/w'), 'utf-8'), JSON.stringify(gate) + '\n')
  // A torn steward line is skipped, the next record still reads.
  appendFileSync(getStewardLogPath('s2', '/w'), '{"gate":"de')
  appendStewardRecord('s2', '/w', { ...gate, message: 'n' })
  assert.deepEqual(readStewardRecords('s2', '/w').map((r: any) => r.message), ['m', 'n'])
})

rmSync(root, { recursive: true, force: true })
console.log(`\n${pass} passed`)
