// Run: cd frontend && npx --yes tsx tests/activity-redaction.test.ts
// Guards the Activity log's secret-masking invariant (LogsDrawer / redactSecrets):
// a tool command, an ingest script or a SUB-AGENT RESULT can embed a token, and no
// surface in the drawer may print it. The sub-agent-result path (Running tab, "done"
// rows) shipped unredacted in #125 while every other body was masked; these checks
// pin the shared helper AND assert that the render path calls it.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { redactSecrets } from '../src/lib/redactSecrets'

const results: [string, boolean, string?][] = []
function t(name: string, fn: () => void) {
  try { fn(); results.push([name, true]) } catch (e: any) { results.push([name, false, String(e.message).slice(0, 400)]) }
}
const ok = (c: any, m: string) => { if (!c) throw new Error(m) }

// A placeholder-shaped stand-in per pattern — never a usable credential.
// Bodies are deliberately SHORT wherever a real credential can be short (LiveKit
// keys are "API" + ~12 chars, a quoted token is often truncated): a floor tuned
// to long values prints the short ones in full, which is how this helper
// regressed once already. Never raise a floor to make prose read better.
const SAMPLES = [
  'sk-ant-' + 'A'.repeat(8),
  'sk-or-' + 'B'.repeat(8),
  'sk-' + 'C'.repeat(24),
  'sbp_' + 'D'.repeat(12),
  'ghp_' + 'E'.repeat(12),
  'github_pat_' + 'F'.repeat(22),
  'FlyV1 fm2_' + 'G'.repeat(22) + ',fm2_' + 'H'.repeat(22),
  'fm2_' + 'I'.repeat(22),
  'eyJ' + 'J'.repeat(14) + '.' + 'K'.repeat(14),
  'Bearer ' + 'L'.repeat(24),
  'x-api-key: ' + 'M'.repeat(12),
  'Authorization: Token ' + 'N'.repeat(12),
  'OPENAI_API_KEY=' + 'O'.repeat(24),
  'LIVEKIT_API_KEY=API' + 'p'.repeat(11),
  'DB_PASSWORD=hunter2x',
]

t('every credential shape is masked in bare text', () => {
  for (const s of SAMPLES) {
    const out = redactSecrets(s)
    ok(out.includes('••••'), `not masked: ${s.slice(0, 16)}…`)
    for (const ch of 'ABDEFGHIJKLMNOp') ok(!out.includes(ch.repeat(8)), `raw body survived in ${out.slice(0, 24)}`)
  }
})

t('masking survives markdown wrappers a sub-agent result uses', () => {
  for (const s of SAMPLES) {
    for (const wrap of [`**${s}**`, '`' + s + '`', '```sh\n' + s + '\n```', `- found ${s} in .env`, `> ${s}`]) {
      ok(redactSecrets(wrap).includes('••••'), `not masked inside wrapper: ${wrap.slice(0, 20)}…`)
    }
  }
})

t('legitimate result text is left intact', () => {
  // Prose only started mattering once the helper was pointed at sub-agent results
  // rather than commands and filenames. The cure is the shape of the rule (the
  // generic assignment needs "="; Bearer needs a 20-char value), never a blanket
  // floor — a floor high enough to spare prose also spares short credentials.
  for (const s of [
    'GATE: PASS on fix/activity-log-redaction', '**VERDICT: REJECT**', 'ran `npm test` — 12 passed', '2 * 3 = 6',
    'Auth header uses Bearer formatting now', 'TOKEN: expired, re-run the login flow',
    'x-api-key: header', 'the sk-ant- prefix identifies Anthropic keys',
  ]) {
    assert.equal(redactSecrets(s), s)
  }
})

t('a quoted patch is preserved verbatim (no bullet/fence mangling)', () => {
  // The deleted stripResultMarkdown ate the leading "-" of removal lines, turning a
  // quoted diff into a misleading one, and ate one backtick of each fence.
  const patch = 'Diff:\n```diff\n- const a = 1\n+ const a = 2\n```'
  assert.equal(redactSecrets(patch), patch)
})

t('nullish / empty input is safe', () => {
  assert.equal(redactSecrets(''), '')
  assert.equal(redactSecrets(undefined), '')
  assert.equal(redactSecrets(null), '')
})

t('both sub-agent-authored bodies in the drawer pass through the gate', () => {
  // The one structural pin worth keeping: this is the invariant that broke in
  // #125, and a type checker cannot express "this text was redacted first".
  // Only the redaction calls are pinned, not the markup around them.
  const src = fs.readFileSync(path.resolve(__dirname, '../src/components/LogsDrawer.tsx'), 'utf8')
  const body = src.slice(src.indexOf('function FlowResultText')).split('\n}\n')[0]
  ok(/redactSecrets\(text\)/.test(body), 'the finished result must be redacted at render')
  ok(/redactSecrets\(flow\.lastMessage \|\| flow\.task\)/.test(src), 'the live row must redact its text')
})

const failed = results.filter((r) => !r[1])
for (const [name, pass, err] of results) console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${err ? ` — ${err}` : ''}`)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
