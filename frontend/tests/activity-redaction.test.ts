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
const SAMPLES = [
  'sk-ant-' + 'A'.repeat(24),
  'sk-or-' + 'B'.repeat(24),
  'sk-' + 'C'.repeat(24),
  'sbp_' + 'D'.repeat(24),
  'ghp_' + 'E'.repeat(24),
  'eyJ' + 'F'.repeat(24) + '.' + 'G'.repeat(16),
  'Bearer ' + 'H'.repeat(24),
  'OPENAI_API_KEY=' + 'I'.repeat(24),
  'SUPABASE_SERVICE_ROLE_SECRET: "' + 'J'.repeat(24) + '"',
]

t('every credential shape is masked in bare text', () => {
  for (const s of SAMPLES) {
    const out = redactSecrets(s)
    ok(out.includes('••••'), `not masked: ${s.slice(0, 12)}…`)
    ok(!out.includes('A'.repeat(24)) || !s.startsWith('sk-ant-'), 'raw body survived')
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
  for (const s of ['GATE: PASS on fix/activity-log-redaction', '**VERDICT: REJECT**', 'ran `npm test` — 12 passed', '2 * 3 = 6']) {
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

t('the sub-agent result render path redacts and does not strip markdown', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/components/LogsDrawer.tsx'), 'utf8')
  const fn = src.slice(src.indexOf('function FlowResultText'))
  const body = fn.slice(0, fn.indexOf('\n}\n'))
  ok(body.includes('redactSecrets(text)'), 'FlowResultText must redact its input')
  ok(body.includes('<MarkdownMessage'), 'FlowResultText must render markdown, not strip it')
  ok(body.includes('title={safe}'), 'the hover tooltip must show the redacted text')
  ok(!/stripResultMarkdown/.test(src), 'stripResultMarkdown must stay deleted')
})

t('the live (running) flow row redacts too', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/components/LogsDrawer.tsx'), 'utf8')
  ok(src.includes('redactSecrets(flow.lastMessage || flow.task)'), 'running row must redact its live text')
})

t('the stored flow artifact is redacted before it enters client state', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/components/VoiceRoom.tsx'), 'utf8')
  ok(/artifact: data\.last_assistant_message != null \? redactSecrets\(/.test(src), 'VoiceRoom must redact the stored artifact')
})

const failed = results.filter((r) => !r[1])
for (const [name, pass, err] of results) console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${err ? ` — ${err}` : ''}`)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
