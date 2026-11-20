// Steward verdict parser + sidecar (#221, #224).
// Run: npx tsx agent/tests/steward-verdict.test.ts
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { parseStewardVerdict, appendStewardRecord, readStewardRecords, getStewardLogPath, stewardPushRecords, githubIssueBase, issueBaseFromRemote } = await import('../src/steward-verdict.js')

let pass = 0
const t = (name: string, fn: () => unknown) => {
  try { fn(); pass++; console.log('ok   ', name) }
  catch (e: any) { console.log('FAIL ', name, '\n     ', String(e?.message ?? e).split('\n')[0]); process.exitCode = 1 }
}

const REFACTORED = `I checked the diff and history.

VERDICT: REFACTORED — reused the existing marker sidecar instead of a new table
REUSE MAP: stewardPath → getStorePath (extended); parseStewardVerdict → NET-NEW: no parser for agent returns exists
REMOVED: duplicate path helper in index.ts (second copy of compaction-log path)
IMPACT: getStorePath → session-store, compaction-log → ok
LINES: +120 -10 before → +90 -10 after, excluding tests; tests +40
HISTORY:
- churn: claude-llm.ts 14 commits / 60 days
- re-touched lines: 3 hunks checked / 0 found
- coupled: VoiceRoom.tsx present
ROOT CAUSE: new feature, no earlier fault`

t('USER TIME after HISTORY never lands in the history card', () => {
  const v = parseStewardVerdict(`VERDICT: CLEAN — ok
HISTORY:
- churn: x.ts 2 commits
USER TIME: saves the user a reload
- no added waiting`, '2026-11-20T00:00:00.000Z')!
  assert.deepEqual(v.history, ['churn: x.ts 2 commits'])
})

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

t('a CHALLENGED section stays in raw and does not break the history split', () => {
  const v = parseStewardVerdict('VERDICT: CLEAN — ok\nHISTORY: churn 3; re-touched 4/0\nCHALLENGED: no dup → git grep -F x → held')!
  assert.deepEqual(v.history, ['churn 3', 're-touched 4/0'])
  assert.ok(v.raw.includes('CHALLENGED'))
})

t('sidecar: append + read back, torn line skipped', () => {
  const root = mkdtempSync(join(tmpdir(), 'steward-verdict-test-'))
  process.env.CLAUDE_CONFIG_DIR = join(root, 'claude')
  try {
    const sid = 'sess-x', wd = join(root, 'proj')
    assert.deepEqual(readStewardRecords(sid, wd), [])
    appendStewardRecord(sid, wd, parseStewardVerdict(REFACTORED)!)
    appendStewardRecord(sid, wd, { gate: 'deny', message: 'not signed off', at: '2026-11-13T00:00:01.000Z' })
    appendFileSync(getStewardLogPath(sid, wd), '{"verdict":"CLE')
    const got: any[] = readStewardRecords(sid, wd)
    assert.equal(got.length, 2)
    assert.equal(got[0].verdict, 'REFACTORED')
    assert.deepEqual(got[1], { gate: 'deny', message: 'not signed off', at: '2026-11-13T00:00:01.000Z' })
    assert.ok(getStewardLogPath(sid, wd).endsWith('/steward.jsonl'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

t('#250: CRLF and lone-CR returns parse like LF', () => {
  const lf = parseStewardVerdict(REFACTORED, 'x')!
  assert.deepEqual(parseStewardVerdict(REFACTORED.replace(/\n/g, '\r\n'), 'x'), { ...lf, raw: REFACTORED.replace(/\n/g, '\r\n') })
  assert.equal(parseStewardVerdict('VERDICT: CLEAN — ok\r\nNET-NEW: alpha')!.netNew[0], 'alpha')
  const mixed = parseStewardVerdict('VERDICT: CLEAN — ok\nNET-NEW: alpha\r\nREMOVED: beta\n')!
  assert.equal(mixed.summary, 'ok')
  assert.deepEqual(mixed.netNew, ['alpha'])
  assert.deepEqual(mixed.removed, ['beta'])
  assert.equal(parseStewardVerdict('VERDICT: BLOCK — x\rDECISION: y')!.decision, 'y')
})

t('#250: caps hold after the reuse lift; joined fields and raw are capped with a marker', () => {
  const many = (p: string) => Array.from({ length: 20 }, (_, i) => `- ${p}${i}`).join('\n')
  const v = parseStewardVerdict(`VERDICT: CLEAN — ${'s'.repeat(5000)}\nNET-NEW:\n${many('n')}\nREUSE MAP:\n${many('r → NET-NEW: x')}\nROOT CAUSE: ${'c'.repeat(5000)}`)!
  assert.equal(v.netNew.length, 20)
  assert.ok(v.summary.length <= 1020 && v.summary.endsWith('… [truncated]'))
  assert.ok(v.rootCause!.length <= 1020 && v.rootCause!.endsWith('… [truncated]'))
  assert.ok(v.raw.length <= 6020 && v.raw.endsWith('… [truncated]'))
  assert.ok(!parseStewardVerdict(REFACTORED)!.raw.includes('[truncated]'))
})

t('#259: IMPACT is its own bounded field, SIBLINGS included; TESTS does not join it', () => {
  const v = parseStewardVerdict('VERDICT: CLEAN — ok\nIMPACT: getFoo → a, b → ok; SIBLINGS: copy1 → out of scope\nTESTS: steward-verdict → pass\nLINES: +1 -0')!
  assert.deepEqual(v.impact, ['getFoo → a, b → ok', 'SIBLINGS: copy1 → out of scope'])
  assert.equal(v.lines, '+1 -0')
  assert.equal(parseStewardVerdict('VERDICT: CLEAN — ok')!.impact, undefined)
  assert.equal(parseStewardVerdict(REFACTORED)!.impact![0], 'getStorePath → session-store, compaction-log → ok')
})

t('#259: an IMPACT-looking bullet inside HISTORY stays history', () => {
  for (const b of ['- IMPACT: getFoo changed, caller missed', '> IMPACT: getFoo changed, caller missed', '- impact: getFoo changed, caller missed']) {
    const v = parseStewardVerdict(`VERDICT: CLEAN — ok\nHISTORY:\n- churn low\n${b}\n- coupled: VoiceRoom.tsx present\nROOT CAUSE: new feature`)!
    assert.deepEqual(v.history, ['churn low', b.slice(2), 'coupled: VoiceRoom.tsx present'], b)
    assert.equal(v.impact, undefined)
    assert.equal(v.rootCause, 'new feature')
  }
  // The labels that follow HISTORY still end it, bulleted or not.
  const v = parseStewardVerdict('VERDICT: BLOCK — x\nHISTORY:\n- churn low\n- CHALLENGED: no dup → held\n- ROOT CAUSE: none found\n- DECISION: keep it?')!
  assert.deepEqual(v.history, ['churn low'])
  assert.equal(v.rootCause, 'none found')
  assert.equal(v.decision, 'keep it?')
})

t('prior_messages push: last 10 verdicts and last 10 gates kept apart, raw and impact stripped, file order', () => {
  const v = parseStewardVerdict(REFACTORED, '2026-11-13T00:00:00.000Z')!
  const recs: any[] = [
    ...Array.from({ length: 12 }, (_, i) => ({ ...v, summary: `v${i}` })),
    ...Array.from({ length: 15 }, (_, i) => ({ gate: 'deny', message: `g${i}`, at: v.at })),
  ]
  const out: any[] = stewardPushRecords(recs)
  assert.deepEqual(out.filter((r) => r.verdict).map((r) => r.summary), Array.from({ length: 10 }, (_, i) => `v${i + 2}`))
  assert.deepEqual(out.filter((r) => r.gate).map((r) => r.message), Array.from({ length: 10 }, (_, i) => `g${i + 5}`))
  assert.ok(out.every((r) => r.raw === undefined && r.impact === undefined))
  assert.ok(!JSON.stringify(out).includes('"raw"') && !JSON.stringify(out).includes('getStorePath'))
  assert.ok(recs[0].raw && recs[0].impact, 'source records untouched')
})


t('#224: HISTORY sorted into four rows; a warning row is flagged, a benign one is not', () => {
  const v = parseStewardVerdict(`VERDICT: CLEAN — ok
HISTORY:
- churn: x.ts 4 commits / 60 days
- re-touched: 2 hunks checked / 1 found (#212 changed L40-60)
- coupled: index.ts, missing: VoiceRoom.tsx
- decisions: #210, #212
ROOT CAUSE: retry storm in pushMessage, log in #212 (#210 → #212 → this)`, 'x', 'https://github.com/o/r/issues/')!
  assert.deepEqual(v.historyRows.map((r) => r.key), ['churn', 'retouched', 'coupled', 'decisions'])
  assert.deepEqual(v.historyRows.map((r) => r.warn), [false, true, true, false])
  assert.deepEqual(v.chain, [210, 212])
  assert.equal(v.issueBase, 'https://github.com/o/r/issues/')
})

t('#224: none / 0 found do not warn; a feature has an empty chain', () => {
  const v = parseStewardVerdict(REFACTORED, 'x')!
  assert.ok(v.historyRows.every((r) => !r.warn))
  assert.deepEqual(v.chain, [])
  assert.equal(v.issueBase, undefined)
  const w = parseStewardVerdict(`VERDICT: CLEAN — ok\nHISTORY:\n- coupled: missing: none\n- decisions: gh unavailable (unauthenticated)`, 'x')!
  assert.equal(w.historyRows[3].warn, true)
})

t('#224: githubIssueBase is undefined outside a git repo', () => {
  assert.equal(githubIssueBase('/nonexistent-dir-xyz'), undefined)
})


t('#224: the prompt\'s re-touched format warns when found is 1 or more, not 0', () => {
  const row = (line: string) => parseStewardVerdict(`VERDICT: CLEAN — ok\nHISTORY: ${line}`, 'x')!.historyRows.find((r) => r.key === 'retouched')!
  assert.equal(row('re-touched: 4 / 2').warn, true)
  assert.equal(row('re-touched: 4 / 1').warn, true)
  assert.equal(row('re-touched: 4 / 0').warn, false)
})

t('#224: only an explicit #A → #B → this chain counts', () => {
  const chain = (rc: string) => parseStewardVerdict(`VERDICT: CLEAN — ok\nROOT CAUSE: ${rc}`, 'x')!.chain
  assert.deepEqual(chain('colour #123456 broke, see #7'), [])
  assert.deepEqual(chain('see #7 (#5 → #7 → this)'), [5, 7])
  assert.deepEqual(chain('#5 → this'), [5])
  assert.deepEqual(chain('a#5 → this'), [])
})

t('#224: the issue base is anchored to the github.com host', () => {
  assert.equal(issueBaseFromRemote('git@github.com:o/r.git'), 'https://github.com/o/r/issues/')
  assert.equal(issueBaseFromRemote('https://github.com/o/r'), 'https://github.com/o/r/issues/')
  assert.equal(issueBaseFromRemote('https://notgithub.com/o/r.git'), undefined)
})

console.log(`\n${pass} passed`)
