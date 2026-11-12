// Run: cd frontend && npx --yes tsx tests/activity-redaction.test.ts
// Guards the Activity log's secret-masking invariant (LogsDrawer / redactSecrets):
// a tool command, an ingest script or a SUB-AGENT RESULT can embed a token, and no
// surface in the drawer may print it. The sub-agent-result path (Running tab, "done"
// rows) shipped unredacted in #125 while every other body was masked.
//
// Both halves matter and have each regressed once: masking too little printed a
// short real credential, and masking too much rewrote a diff the user was reading.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { redactSecrets } from '../src/lib/redactSecrets'

const results: [string, boolean, string?][] = []
function t(name: string, fn: () => void) {
  try { fn(); results.push([name, true]) } catch (e: any) { results.push([name, false, String(e.message).slice(0, 400)]) }
}
const ok = (c: any, m: string) => { if (!c) throw new Error(m) }

// Placeholder-shaped stand-ins — never a usable credential. Bodies are
// deliberately SHORT wherever a real credential can be short (a LiveKit key is
// "API" + ~12 chars, a quoted token is often truncated): a floor tuned to long
// values prints the short ones in full, which is how this helper regressed once.
const SAMPLES = [
  'sk-ant-' + 'A'.repeat(8), 'sk-or-' + 'B'.repeat(8), 'sk-' + 'C'.repeat(24),
  // Prefixed keys, bare and inside an assignment — the product's own key shape.
  // A value guard ending in a plain `\b` silently skipped every one of these,
  // because `\b` fires before the hyphen.
  'sk-proj-aAbB1122ccDD3344eeFFgg', 'OPENAI_API_KEY=sk-proj-aAbB1122ccDD3344eeFF',
  'OPENAI_API_KEY=sk-svcacct-aAbB1122ccDD3344', 'SLACK_TOKEN=xoxb-1234567890-abcdefghij',
  'GITLAB_TOKEN=glpat-aAbB1122ccDD3344', 'TOKEN=key-1234567890123456',
  'MY_SECRET=abcd+1234567890123456', 'MY_SECRET=abcd/1234567890123456',
  'x-api-key: abc-1234567890123456', 'DB_PASSWORD=correcthorsebatterystaple',
  'sbp_' + 'D'.repeat(12), 'gho_16C7e42F292c6912E7710c838347Ae178B4a',
  'FlyV1 fm2_' + 'G'.repeat(22) + ',fm2_' + 'H'.repeat(22), 'fm2_' + 'I'.repeat(22), 'fo1_' + 'I'.repeat(22),
  'eyJ' + 'J'.repeat(14) + '.' + 'K'.repeat(14), 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0',
  'Bearer ' + 'L'.repeat(24), 'x-api-key: ' + 'M'.repeat(12),
  'Authorization: Token ' + 'N'.repeat(12), 'Authorization: ' + 'N'.repeat(14),
  'OPENAI_API_KEY=' + 'O'.repeat(24), 'LIVEKIT_API_KEY=APIu8vQj3xyzAb',
  'DB_PASSWORD=hunter2x', 'API_KEY=abc1234x',
  'ghp_16C7e42F292c6912E7710c838347Ae178B4a', 'github_pat_11ABCDE_' + 'F'.repeat(40),
  // Colon form — a YAML/JSON block, not a .env line. Narrowing the assignment
  // rule to "=" alone once un-masked every one of these.
  'SUPABASE_SERVICE_ROLE_SECRET: "' + 'Q'.repeat(24) + '"', 'MY_TOKEN: ' + 'R'.repeat(24), 'password: hunter2x',
  // Quoted NAME — JSON and `fly secrets` output. A separator that cannot cross
  // the name's closing quote leaked every one of these.
  '{"MY_TOKEN": "abcdef1234567890xyz9"}', '{"OPENAI_API_KEY": "' + 'S'.repeat(24) + '"}', '{"DB_PASSWORD": "hunter2xyz9"}',
  // Truncated mid-string, as a drawer body routinely is: requiring a CLOSING
  // quote to match the opening one leaked both of these.
  'MY_TOKEN: "abcdef1234567890xyz9', 'MY_TOKEN="abcdef1234567890xyz9',
]

t('every credential shape is masked in bare text', () => {
  for (const s of SAMPLES) {
    const out = redactSecrets(s)
    ok(out.includes('••••'), `not masked: ${s.slice(0, 16)}…`)
    // Checks the OUTPUT for a surviving placeholder run rather than keeping a
    // hand-maintained letter list in sync with SAMPLES.
    ok(!/([A-Za-z0-9])\1{5,}/.test(out), `raw body survived: ${out.slice(0, 28)}`)
  }
})

t('masking survives the markdown a sub-agent result is written in', () => {
  for (const s of SAMPLES) {
    for (const wrap of [`**${s}**`, '`' + s + '`', '```sh\n' + s + '\n```', `- found ${s} in .env`, `> ${s}`]) {
      ok(redactSecrets(wrap).includes('••••'), `not masked inside wrapper: ${wrap.slice(0, 20)}…`)
    }
  }
})

t('code, diffs and prose are left byte-identical', () => {
  // A key-ish NAME followed by a short word is a type annotation, a diff line or
  // a sentence — never a credential. Masking these rewrote the diff the user was
  // reading and the note sent back to the agent, the same class of harm as the
  // markdown-stripping bug this helper replaced.
  for (const s of [
    'interface Cfg { apiKey: string; token: string }', '-  password: string', 'let token: number = 0',
    'TOKEN: string | null', 'api_key: Optional[str] = None', 'secret: boolean',
    '{ "apiKey": "string" }', '{"token": "string"}', '{"password": "required"}',
    'const token: AccessTokenPayload = decode(raw)', 'const secret: EncryptedCredentialBundle = load()',
    'let password: ReadonlyArray<string> = []', 'see docs/api-key: rotation.md',
    'const apiKey = process.env.OPENAI_API_KEY',
    'TOKEN: expired, re-run the login flow', 'Authorization: required for this endpoint', 'x-api-key: header',
    'password: $DB_PASSWORD', 'Set TOKEN=$MY_VAR before running',
    'const ghp_token_name = 1', 'let ghs_installation_cache = {}', 'the risk-ant-icipation of failure',
    'Auth header uses Bearer formatting now', 'the sk-ant- prefix identifies Anthropic keys',
    'GATE: PASS on fix/activity-log-redaction', '**VERDICT: REJECT**', 'ran `npm test` — 12 passed', '2 * 3 = 6',
    'Diff:\n```diff\n- const a = 1\n+ const a = 2\n```',
  ]) {
    assert.equal(redactSecrets(s), s)
  }
})

t('nullish / empty input is safe, and masking is idempotent', () => {
  assert.equal(redactSecrets(''), '')
  assert.equal(redactSecrets(undefined), '')
  assert.equal(redactSecrets(null), '')
  for (const s of SAMPLES) assert.equal(redactSecrets(redactSecrets(s)), redactSecrets(s))
})

t('both sub-agent-authored bodies in the drawer pass through the gate', () => {
  // The one structural pin worth keeping: this is the invariant that broke in
  // #125, and no type checker can express "this text was redacted first".
  const src = fs.readFileSync(path.resolve(__dirname, '../src/components/LogsDrawer.tsx'), 'utf8')
  const body = src.slice(src.indexOf('function FlowResultText')).split('\n}\n')[0]
  ok(/redactSecrets\(text\)/.test(body), 'the finished result must be redacted at render')
  ok(/redactSecrets\(flow\.lastMessage \|\| flow\.task\)/.test(src), 'the live row must redact its text')
  // The over-masking sibling of the same bug: stripping or slicing markdown
  // rewrote a quoted patch. The result collapses by height, so it never slices.
  ok(!/stripResultMarkdown/.test(src), 'stripResultMarkdown must stay deleted')
  ok(!/BODY_PREVIEW_CHARS\)/.test(body), 'the result must collapse by height, never slice markdown')
})

const failed = results.filter((r) => !r[1])
for (const [name, pass, err] of results) console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${err ? ` — ${err}` : ''}`)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
