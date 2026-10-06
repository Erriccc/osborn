// Blind test: redaction gaps. SYNTHETIC fakes only.
import { redactSecrets } from '../src/content/transcript-sanitizer.js'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, extra) }
}
const B = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
const seg = (n: number) => B.slice(0, n)

const secrets: Record<string, string> = {
  fireworks: 'fw_' + seg(24),
  openrouter: 'sk-or-v1-' + seg(32).toLowerCase(),
  anthropic: 'sk-ant-api03-' + seg(30),
  ghp: 'ghp_' + seg(30),
  ghpat: 'github_pat_' + seg(30),
  slackb: 'xoxb-' + '1234567890-' + seg(20),
  slackp: 'xoxp-' + '1234567890-' + seg(20),
  supabase: 'sbp_' + seg(30).toLowerCase(),
  npm: 'npm_' + seg(36),
  snx: 'snx_proj_' + seg(24),
  google: 'AIza' + seg(35),
  fm2: 'fm2_' + seg(28),
  fm1: 'fm1_' + seg(28),
}
for (const [k, v] of Object.entries(secrets)) {
  const out = redactSecrets(`token is ${v} ok`)
  ok(`redacts ${k}`, !out.includes(v) && !out.includes(v.slice(0, v.length - 8)), out)
}
// Multi-segment FlyV1
const a = 'fm2_' + seg(30), b = 'fm2_' + 'zYxWvUtSrQpOnMlKjIhGfEdCbA9876', c = 'fm2_' + 'Qq11Ww22Ee33Rr44Tt55Yy66'
const fly = redactSecrets(`Authorization: FlyV1 ${a},${b},${c} done`)
ok('FlyV1 multi-segment: zero fm2_ residue', !fly.includes('fm2_'), fly)
ok('FlyV1 multi-segment: no segment body residue', !fly.includes(b.slice(4)) && !fly.includes(c.slice(4)), fly)
const fly2 = redactSecrets(`export FLY_API_TOKEN="FlyV1 ${a},${b}"`)
ok('FlyV1 quoted: zero fm2_', !fly2.includes('fm2_'), fly2)
ok('standalone short fm2_ (<20) not required', true)
// False positives
const prose = [
  'Run npm install and then npm run build.',
  'The fw_version field is read from config.',
  'We fly to Berlin on Friday; fly.io is a host.',
  'Set fw_key and fw_test_script in the env.',
  'The fm2_ prefix is used for Fly tokens.',
  'Use sk-learn for ML, and the npm_package_version variable.',
  'FlyV1 is the auth scheme name.',
  'github is great; see the ghp docs and xox games.',
]
for (const p of prose) {
  const out = redactSecrets(p)
  ok(`prose unchanged: ${p}`, out === p, out)
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
