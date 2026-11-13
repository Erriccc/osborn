// Steward verdict parser + sidecar (#221, #224).
// Run: npx tsx agent/tests/steward-verdict.test.ts
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { parseStewardVerdict, appendStewardVerdict, readStewardVerdicts, getStewardLogPath } = await import('../src/steward-verdict.js')

let pass = 0
const t = (name: string, fn: () => unknown) => {
  try { fn(); pass++; console.log('ok   ', name) }
  catch (e: any) { console.log('FAIL ', name, '\n     ', String(e?.message ?? e).split('\n')[0]); process.exitCode = 1 }
}

const REFACTORED = `I checked the diff and history.

VERDICT: REFACTORED — reused the existing marker sidecar instead of a new table
REUSE MAP: stewardPath → getStorePath (extended); parseStewardVerdict → NET-NEW: no parser for agent returns exists
REMOVED: duplicate path helper in index.ts (second copy of compaction-log path)
REGRESSION MAP: getStorePath → session-store, compaction-log → ok
LINES: +120 -10 before → +90 -10 after, excluding tests; tests +40
HISTORY:
- churn: claude-llm.ts 14 commits / 60 days
- re-touched lines: 3 hunks checked / 0 found
- coupled: VoiceRoom.tsx present
ROOT CAUSE: new feature, no earlier fault`

t('REFACTORED: verdict, summary and every field', () => {
  const v = parseStewardVerdict(REFACTORED, '2026-11-13T00:00:00.000Z')!
  assert.equal(v.verdict, 'REFACTORED')
  assert.equal(v.summary, 'reused the existing marker sidecar instead of a new table')
  assert.equal('reuse' in v || 'regressions' in v, false)
  assert.deepEqual(v.netNew, ['parseStewardVerdict — no parser for agent returns exists'])
  assert.deepEqual(v.removed, ['duplicate path helper in index.ts (second copy of compaction-log path)'])
  assert.equal(v.lines, '+120 -10 before → +90 -10 after, excluding tests; tests +40')
  assert.deepEqual(v.history, ['churn: claude-llm.ts 14 commits / 60 days', 're-touched lines: 3 hunks checked / 0 found', 'coupled: VoiceRoom.tsx present'])
  assert.equal(v.rootCause, 'new feature, no earlier fault')
  assert.equal(v.decision, undefined)
  assert.equal(v.at, '2026-11-13T00:00:00.000Z')
  assert.ok(v.raw.startsWith('I checked'))
})

t('CLEAN with markdown bold labels and "none" lists', () => {
  const v = parseStewardVerdict('**VERDICT:** CLEAN - nothing to cut\n**REMOVED:** none\n- **NET-NEW:** steward card; gate note\n**HISTORY:** none')!
  assert.equal(v.verdict, 'CLEAN')
  assert.equal(v.summary, 'nothing to cut')
  assert.deepEqual(v.removed, [])
  assert.deepEqual(v.history, [])
  assert.deepEqual(v.netNew, ['steward card', 'gate note'])
})

t('BLOCK: labelled decision', () => {
  const v = parseStewardVerdict('VERDICT: BLOCK — retry hides the timeout\nROOT CAUSE: no evidence given anywhere\nDECISION: keep the retry, or find the cause first?')!
  assert.equal(v.verdict, 'BLOCK')
  assert.equal(v.decision, 'keep the retry, or find the cause first?')
  assert.equal(v.rootCause, 'no evidence given anywhere')
})

t('BLOCK: unlabelled decision text after the verdict is used', () => {
  const v = parseStewardVerdict('Decide whether the second copy stays.\nVERDICT: BLOCK — third copy of the slug rule')!
  assert.equal(v.decision, 'Decide whether the second copy stays.')
})

t('no VERDICT line → null', () => {
  assert.equal(parseStewardVerdict('Here is the reuse map for the plan: ...'), null)
  assert.equal(parseStewardVerdict(''), null)
  assert.equal(parseStewardVerdict('VERDICT: maybe'), null)
})

t('prose that starts with a label word is not a section', () => {
  const v = parseStewardVerdict('VERDICT: CLEAN — ok\nHISTORY: churn low\nHistory shows no reverts')!
  assert.deepEqual(v.history, ['churn low', 'History shows no reverts'])
})

t('sidecar: append + read back, torn line skipped', () => {
  const root = mkdtempSync(join(tmpdir(), 'steward-verdict-test-'))
  process.env.CLAUDE_CONFIG_DIR = join(root, 'claude')
  try {
    const sid = 'sess-x', wd = join(root, 'proj')
    assert.deepEqual(readStewardVerdicts(sid, wd), [])
    appendStewardVerdict(sid, wd, parseStewardVerdict(REFACTORED)!)
    appendFileSync(getStewardLogPath(sid, wd), '{"verdict":"CLE')
    const got = readStewardVerdicts(sid, wd)
    assert.equal(got.length, 1)
    assert.equal(got[0].verdict, 'REFACTORED')
    assert.ok(getStewardLogPath(sid, wd).endsWith('/steward.jsonl'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

console.log(`\n${pass} passed`)
