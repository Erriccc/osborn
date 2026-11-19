// Run: cd frontend && npx --yes tsx tests/redaction-parity.test.ts
// One rule set: the Activity log's gate (src/lib/redactSecrets.ts) mirrors the
// agent's sanitizer (agent/src/content/secret-rules.ts SECRET_RULES). The
// gate is a copy, not an import, so this test is what keeps them together: the
// agent's own detector runs over the gate's output, and nothing it recognises may
// survive. A new agent rule fails here until it has a sample below and a mirror in
// the gate (#189: npm, AWS, PEM and others drifted out of the frontend copy).
import assert from 'node:assert/strict'
import { redactSecrets } from '../src/lib/redactSecrets'
import { SECRET_RULES, detectSecrets, redactSecrets as agentRedact } from '../../agent/src/content/secret-rules'

// Synthetic, placeholder-shaped values: one or more per agent rule kind.
const B = 'aB3dE5gH7j'
const CORPUS = [
  `//registry.npmjs.org/:_authToken=npm_${B.repeat(3)}kL3mN5`,
  `npm_${B.repeat(3)}kL3mN5`,
  `FlyV1 fm2_${B.repeat(3)},fm2_${B.repeat(3)}`, `fm2_${B.repeat(3)}`, `fo1_${B.repeat(3)}`,
  `sbp_${B.repeat(3)}`,
  `-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7bq9\n-----END RSA PRIVATE KEY-----`,
  `-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0B`,
  // A truncated legacy encrypted key (`openssl … -traditional`), raw and as an
  // escaped JSONL string: its Proc-Type / DEK-Info lines once stopped the mask.
  `-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-256-CBC,0A1B2C3D4E5F60718293A4B5C6D7E8F9\n\n${B.repeat(6)}\n${B.repeat(6)}`,
  `-----BEGIN RSA PRIVATE KEY-----\\nProc-Type: 4,ENCRYPTED\\nDEK-Info: AES-256-CBC,0A1B2C3D4E5F60718293A4B5C6D7E8F9\\n\\n${B.repeat(6)}\\n${B.repeat(6)}`,
  `sk-ant-api03-${B.repeat(4)}`, `sk-or-v1-${B.repeat(4)}`, `sk-proj-${B.repeat(3)}`, `sk-${B.repeat(3)}`,
  `ghp_${B.repeat(4)}`, `github_pat_11ABCDE_${B.repeat(4)}`,
  `AIzaSy${B.repeat(3)}kL3mN`,
  `fw_${B.repeat(3)}`, `snx_proj_${B.repeat(3)}`, `snx_${B.repeat(2)}`,
  `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${B.repeat(2)}`,
  // Glued to a word character (URL-encoded, or an escaped `\n` in a JSON string).
  `Authorization%3A%20Bearer%20eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${B.repeat(2)}`,
  `"line\\neyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${B.repeat(2)}"`,
  `x-api-key: ${B.repeat(2)}`, `x-goog-api-key: ${B.repeat(2)}`,
  `Authorization: Basic ${B.repeat(2)}`, `Authorization: Bearer ${B.repeat(3)}`,
  `xoxb-1234567890-${B}`, 'AKIAIOSFODNN7EXAMPLE',
  `curl -H "Bearer ${B.repeat(3)}"`,
  `OPENAI_API_KEY=${B.repeat(2)}`, `DB_PASSWORD="${B}"`, `AWS_SECRET_ACCESS_KEY='${B.repeat(4)}'`, `GH_TOKEN=\`${B.repeat(2)}\``,
]

// Text both sanitizers must leave alone (the gate also spares code the agent
// masks; that list is in activity-redaction.test.ts).
const BENIGN = [
  'color=red', 'mode=dark', 'token count = 5', 'max_tokens=4096', 'the task-budgets doc',
  'fo1_/sbp_/xox/Bearer patterns', 'run `npm test` first',
  'Bearer token expired', 'const token = getToken()',
]

const survivors = (text: string) => detectSecrets(text).filter((h) => !h.match.includes('••••'))

// Every agent rule kind has a sample here, or this list is out of date.
const kinds = new Set(SECRET_RULES.map((r) => r.kind))
const sampled = new Set(CORPUS.flatMap((s) => detectSecrets(s).map((h) => h.kind)))
for (const kind of Array.from(kinds)) assert.ok(sampled.has(kind), `no parity sample for the agent's ${kind} rule`)

const contexts = (s: string) => [s, `**${s}**`, '`' + s + '`', '```sh\n' + s + '\n```', `- found ${s} in .env`, `{"out": "${s}"}`]
for (const s of CORPUS) {
  assert.notEqual(agentRedact(s), s, `the agent no longer masks: ${s.slice(0, 24)}`)
  assert.ok(!agentRedact(s).includes(B), `the agent printed a secret body: ${agentRedact(s).slice(0, 60)}`)
  for (const text of contexts(s)) {
    const out = redactSecrets(text)
    assert.deepEqual(survivors(out), [], `the gate prints what the agent masks: ${out.slice(0, 60)}`)
    assert.ok(!out.includes(B), `the gate printed a secret body: ${out.slice(0, 60)}`)
  }
}
for (const s of BENIGN) assert.equal(redactSecrets(s), s, `the gate rewrote: ${s}`)
for (const s of BENIGN) assert.equal(agentRedact(s), s, `the agent rewrote: ${s}`)
// No rule may rescan the text from every position: 20k BEGIN lines with no END
// once took over 600ms, and 200KB of `eyJeyJ…` about 40s.
for (const text of ['-----BEGIN PRIVATE KEY-----\n'.repeat(20000), 'eyJ'.repeat(70000)]) {
  for (const [name, redact] of [['gate', redactSecrets], ['agent', agentRedact]] as const) {
    const start = Date.now()
    redact(text)
    assert.ok(Date.now() - start < 200, `the ${name} rescans ${text.slice(0, 12)}…: ${Date.now() - start}ms`)
  }
}
console.log(`redaction-parity: ${kinds.size} agent rule kinds, ${CORPUS.length} samples, ${BENIGN.length} benign lines`)
