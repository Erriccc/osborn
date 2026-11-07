// Skill secret scanner. Fails if any shipped skill markdown carries a literal password or a
// candidate email literal, and checks the browser-apply helper refuses a loosely-permissioned
// secret file. On failure it prints only file:line and a masked reason, never the matching text.
// Run from repo root: npx tsx agent/tests/skill-secrets.test.ts
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const HELPER = join(ROOT, 'agent/.claude/skills/browser-apply/fill.mjs')

// ---- scanner -------------------------------------------------------------------------------
const PASSWORD_RE = /(password|passwd|pwd)\s*[:=]\s*(\S{6,})/i
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/
const PLACEHOLDER_RE = /^[`'"]*(<[^>]*>|\$\{?[A-Za-z_]\w*\}?)|process\.env\.|YOUR_|example/i

export const lineHash = (line: string): string => createHash('sha256').update(line.trim()).digest('hex').slice(0, 16)

// Known false positives, keyed by file + hash of the trimmed line (never by value).
// agent/.claude/skills/shadcn/SKILL.md: zod schema `password: z.string().min(8, ...)` and the
// form `defaultValues: { email: "", password: "" }` example. Only the zod line currently trips the
// pattern (the empty-string default is too short to match); it is listed by hash.
const ALLOWLIST: Record<string, Set<string>> = {
  'agent/.claude/skills/shadcn/SKILL.md': new Set<string>([
    '4912c70f1070647d', // password: z.string().min(8, "Password must be at least 8 characters"),
  ]),
}

export interface Finding { file: string; line: number; reason: string; hash: string }

export function scanText(file: string, text: string, allow: Record<string, Set<string>> = ALLOWLIST): Finding[] {
  const out: Finding[] = []
  let inCandidate = false
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^#{1,6}\s/.test(line)) inCandidate = /candidate data/i.test(line)
    const hash = lineHash(line)
    if (allow[file]?.has(hash)) continue
    const pm = PASSWORD_RE.exec(line)
    if (pm && !PLACEHOLDER_RE.test(pm[2])) out.push({ file, line: i + 1, reason: 'password-like literal (value masked)', hash })
    if (inCandidate) {
      const em = EMAIL_RE.exec(line)
      if (em && !/example\.(com|org|net)$/i.test(em[0])) out.push({ file, line: i + 1, reason: 'email literal in Candidate Data block (value masked)', hash })
    }
  }
  return out
}

function walkMd(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walkMd(p, acc)
    else if (name.endsWith('.md')) acc.push(p)
  }
  return acc
}

export function skillFiles(): string[] {
  const files = [...walkMd(join(ROOT, 'agent/.claude/skills')), ...walkMd(join(ROOT, '.claude/skills'))]
  const pub = join(ROOT, 'frontend/public')
  if (existsSync(pub)) for (const n of readdirSync(pub)) if (/skill.*\.md$/i.test(n)) files.push(join(pub, n))
  return files
}

// ---- tiny runner ---------------------------------------------------------------------------
let passed = 0, failed = 0
async function t(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ok   ${name}`) }
  catch (e: any) { failed++; console.log(`  FAIL ${name}\n       ${String(e?.message ?? e).split('\n').join('\n       ')}`) }
}

// Synthetic values only.
const SYN = {
  email: 'synthetic.candidate@test-fixture.invalid',
  password: 'Synth3tic-Fixture-Pw!',
  phone: '555-0100-SYNTH',
}

console.log('skill-secrets')

await t('scanner flags a synthetic password literal and a candidate email literal', () => {
  const doc = `# x\n## Candidate Data\n- Email: ${SYN.email}\n- Password: ${SYN.password}\n## Other\ncontact ${SYN.email}\n`
  const f = scanText('synthetic.md', doc, {})
  assert.deepEqual(f.map(x => [x.line, x.reason.split(' ')[0]]), [[3, 'email'], [4, 'password-like']])
  for (const x of f) assert.ok(!x.reason.includes(SYN.password) && !x.reason.includes(SYN.email))
})

await t('scanner accepts placeholders and env references', () => {
  const doc = [
    '## Candidate Data',
    '- Email: `$CANDIDATE_EMAIL`',
    '- Password: ${CANDIDATE_PASSWORD}',
    '- password: <your password>',
    'password = process.env.CANDIDATE_PASSWORD',
    'PASSWORD=YOUR_PASSWORD_HERE',
    'pwd: example-password',
    '- Email: someone@example.com',
  ].join('\n')
  assert.deepEqual(scanText('synthetic.md', doc, {}), [])
})

await t('allowlist suppresses by file + line hash only', () => {
  const line = `password: ${SYN.password}`
  assert.equal(scanText('a.md', line, {}).length, 1)
  assert.equal(scanText('a.md', line, { 'a.md': new Set([lineHash(line)]) }).length, 0)
  assert.equal(scanText('b.md', line, { 'a.md': new Set([lineHash(line)]) }).length, 1)
})

await t('no shipped skill markdown contains a password literal or candidate email literal', () => {
  const files = skillFiles()
  assert.ok(files.some(f => f.endsWith('browser-apply/SKILL.md')), 'browser-apply skill not found in scan set')
  const findings = files.flatMap(f => scanText(relative(ROOT, f), readFileSync(f, 'utf8')))
  assert.equal(findings.length, 0, findings.map(x => `${x.file}:${x.line} ${x.reason} [hash ${x.hash}]`).join('\n'))
})

await t('every allowlist entry still matches a real line (no stale entries)', () => {
  for (const [file, hashes] of Object.entries(ALLOWLIST)) {
    const p = join(ROOT, file)
    assert.ok(existsSync(p), `${file} missing`)
    const have = new Set(readFileSync(p, 'utf8').split('\n').map(lineHash))
    for (const h of hashes) assert.ok(have.has(h), `${file}: allowlist hash ${h} matches no line`)
  }
})

// ---- helper: mode-600 enforcement and no value echo ----------------------------------------
await t('browser-apply helper exists', () => {
  assert.ok(existsSync(HELPER), 'agent/.claude/skills/browser-apply/fill.mjs missing')
})

if (existsSync(HELPER)) {
  const helper: any = await import(HELPER)
  const dir = mkdtempSync(join(tmpdir(), 'skill-secrets-'))
  const envFile = join(dir, 'candidate.env')
  writeFileSync(envFile, `# synthetic\nCANDIDATE_EMAIL=${SYN.email}\nCANDIDATE_PASSWORD="${SYN.password}"\nCANDIDATE_PHONE=${SYN.phone}\n`)
  try {
    await t('helper refuses a secret file readable by group/other (0644)', () => {
      chmodSync(envFile, 0o644)
      assert.throws(() => helper.loadCandidateEnv(envFile), /600/)
    })
    await t('helper loads a 0600 secret file', () => {
      chmodSync(envFile, 0o600)
      const env = helper.loadCandidateEnv(envFile)
      assert.equal(env.CANDIDATE_EMAIL, SYN.email)
      assert.equal(env.CANDIDATE_PASSWORD, SYN.password)
      assert.equal(env.CANDIDATE_PHONE, SYN.phone)
    })
    await t('helper `check` prints variable names only, never values (0600)', () => {
      chmodSync(envFile, 0o600)
      const r = spawnSync(process.execPath, [HELPER, 'check'], { env: { ...process.env, CANDIDATE_ENV_FILE: envFile }, encoding: 'utf8' })
      assert.equal(r.status, 0, 'check exited non-zero')
      const out = r.stdout + r.stderr
      assert.ok(out.includes('CANDIDATE_PASSWORD'), 'expected variable name in output')
      for (const v of Object.values(SYN)) assert.ok(!out.includes(v), 'helper output leaked a value')
    })
    await t('helper `check` exits non-zero on a 0644 file without printing values', () => {
      chmodSync(envFile, 0o644)
      const r = spawnSync(process.execPath, [HELPER, 'check'], { env: { ...process.env, CANDIDATE_ENV_FILE: envFile }, encoding: 'utf8' })
      assert.notEqual(r.status, 0)
      const out = r.stdout + r.stderr
      for (const v of Object.values(SYN)) assert.ok(!out.includes(v), 'helper output leaked a value')
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
