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
  'ghp_' + 'E'.repeat(34),
  'eyJ' + 'F'.repeat(16) + '.' + 'G'.repeat(16) + '.' + 'H'.repeat(16),
  'Bearer ' + 'I'.repeat(24),
  'OPENAI_API_KEY=' + 'J'.repeat(24),
  'SUPABASE_SERVICE_ROLE_SECRET: "' + 'K'.repeat(24) + '"',
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
  // The last four are prose the old 6-10 char floors mangled, which only showed up
  // once the helper was pointed at free prose rather than commands and filenames.
  for (const s of [
    'GATE: PASS on fix/activity-log-redaction', '**VERDICT: REJECT**', 'ran `npm test` — 12 passed', '2 * 3 = 6',
    'Auth header uses Bearer formatting now', 'TOKEN: expired, re-run the login flow',
    'see docs/api-key: rotation.md', 'the sk-ant- prefix identifies Anthropic keys',
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

t('the sub-agent result render path redacts and does not strip markdown', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/components/LogsDrawer.tsx'), 'utf8')
  const fn = src.slice(src.indexOf('function FlowResultText'))
  const body = fn.slice(0, fn.indexOf('\n}\n'))
  ok(body.includes('redactSecrets(text)'), 'FlowResultText must redact its input')
  ok(body.includes('<MarkdownMessage content={safe} />'), 'must render the whole redacted text as markdown')
  ok(body.includes('title={collapsed ? safe : undefined}'), 'the collapsed row keeps a tooltip of the redacted text')
  ok(!/\.slice\(0, BODY_PREVIEW_CHARS\)/.test(body), 'must not slice markdown — collapse by height')
  ok(!/stripResultMarkdown/.test(src), 'stripResultMarkdown must stay deleted')
})

t('the live (running) flow row redacts too', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/components/LogsDrawer.tsx'), 'utf8')
  ok(src.includes('redactSecrets(flow.lastMessage || flow.task)'), 'running row must redact its live text')
})

const failed = results.filter((r) => !r[1])
for (const [name, pass, err] of results) console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${err ? ` — ${err}` : ''}`)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
