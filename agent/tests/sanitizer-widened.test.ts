import { sessionJsonlAdapter, sanitizeTranscript, detectSecrets, redactSecrets } from '../src/content/transcript-sanitizer.js'
const f = '/workspace/.claude/projects/-workspace/c97588f4-5760-4b5b-b789-ab5f65aaed29.jsonl'
const u = sanitizeTranscript(sessionJsonlAdapter(f, { includeAssistant: false }))
const w = sanitizeTranscript(sessionJsonlAdapter(f))
const a = w.filter(r => r.speaker === 'assistant')
let live = 0
for (const r of w) { const d = detectSecrets(r.text); if (d.length) { live += d.length; console.log('LEAK', r.speaker, d.map(x=>x.kind)) } }
console.log({ userOnly: u.length, widened: w.length, assistant: a.length, userSpeakers: [...new Set(u.map(r=>r.speaker))], liveSecretsWidened: live })
const syn = redactSecrets('run npm config set //registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123456789 and FlyV1 fm2_abcdefghijklmnop sk-ant-api03-abcdefghijklmnopqrstuvwxyz')
console.log('synthetic:', syn, detectSecrets(syn).length)
// Regression (backfill run): multi-segment Fly token must leave ZERO fm2_ residue,
// and Fireworks fw_ keys must be redacted. Synthetic FAKE values only.
const FK = (n: number) => 'FAKE0123'.repeat(Math.ceil(n / 8)).slice(0, n)
const fly = redactSecrets(`token: FlyV1 fm2_${FK(60)},fm2_${FK(80)},fm2_${FK(40)} done`)
const flyBare = redactSecrets(`seg fm2_${FK(48)} and fm1_${FK(30)} done`)
const fw = redactSecrets(`ANTHROPIC_AUTH_TOKEN fw_${FK(24)} set`)
const snx = redactSecrets(`soniox snx_proj_${FK(32)} set`)
const regress = {
  flyFm2Residue: (fly.match(/fm2_/g) || []).length,
  flyRedacted: fly === 'token: [REDACTED-FLY-TOKEN] done',
  flyBareResidue: (flyBare.match(/fm[12]_/g) || []).length,
  fwRedacted: fw.includes('[REDACTED-FIREWORKS-KEY]') && !fw.includes('fw_'),
  snxRedacted: snx.includes('[REDACTED-SONIOX-KEY]') && !snx.includes('snx_proj_'),
  benignUnchanged: redactSecrets('fw_key, fm2_ segments, snx_proj_ prefix') === 'fw_key, fm2_ segments, snx_proj_ prefix',
}
console.log('regression:', regress)
const regressFail =
  regress.flyFm2Residue !== 0 || !regress.flyRedacted || regress.flyBareResidue !== 0 ||
  !regress.fwRedacted || !regress.snxRedacted || !regress.benignUnchanged ||
  detectSecrets(fly).length + detectSecrets(flyBare).length + detectSecrets(fw).length + detectSecrets(snx).length > 0
if (live || u.some(r=>r.speaker!=='user') || a.length===0 || detectSecrets(syn).length || regressFail) process.exit(1)
