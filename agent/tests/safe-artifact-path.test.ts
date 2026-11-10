// Adversarial tests for the artifact path-traversal fix.
// Run: cd agent && npx tsx tests/safe-artifact-path.test.ts
//
// Verifies the resolve+canonicalize+root-prefix gate that replaced the old
// substring checks: legit paths under each allowed root PASS; `..` traversal,
// absolute escapes, symlink escapes, null bytes and substring-but-outside
// paths all FAIL.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, rmSync } from 'node:fs'
import { join, sep } from 'node:path'
import { tmpdir } from 'node:os'

// ── Hermetic roots: point the helper's env-driven roots at a temp tree ───────
const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'safe-artifact-')))
const claudeDir = join(tmpRoot, '.claude')
const osbornHome = join(tmpRoot, '.osborn')
process.env.CLAUDE_CONFIG_DIR = claudeDir
process.env.OSBORN_HOME = osbornHome
delete process.env.HOME // ensure nothing falls back to a real home dir

const { isSafeArtifactPath, WORKSPACE_ROOTS } = await import('../src/lib/safe-artifact-path.js')

// ── Build a realistic on-disk layout ─────────────────────────────────────────
const SLUG = '-workspace-kachi'
const SESSION = 'sess-abc-123'
const wsDir = join(claudeDir, 'projects', SLUG, 'osb', SESSION)
mkdirSync(wsDir, { recursive: true })
const wsFile = join(wsDir, 'report.md')
writeFileSync(wsFile, '# ok', 'utf-8')

// Session-sharing index layout: ~/.claude/projects/osb/<slug>/
const idxDir = join(claudeDir, 'projects', 'osb', SLUG)
mkdirSync(idxDir, { recursive: true })
const idxFile = join(idxDir, 'index.db')
writeFileSync(idxFile, 'x', 'utf-8')

const sessDir = join(osbornHome, 'sessions', 'sess1')
mkdirSync(sessDir, { recursive: true })
const sessFile = join(sessDir, 'foo.md')
writeFileSync(sessFile, 'x', 'utf-8')

const resDir = join(osbornHome, 'research', 'r1')
mkdirSync(resDir, { recursive: true })
const resFile = join(resDir, 'bar.md')
writeFileSync(resFile, 'x', 'utf-8')

const plansDir = join(claudeDir, 'plans')
mkdirSync(plansDir, { recursive: true })
const planFile = join(plansDir, 'plan1.md')
writeFileSync(planFile, 'x', 'utf-8')

// Outside file + symlink escapes inside the workspace
const secret = join(tmpRoot, 'secret.txt')
writeFileSync(secret, 'TOP SECRET', 'utf-8')
const evilLink = join(wsDir, 'evil') // symlink to the outside secret file
symlinkSync(secret, evilLink)
const outsideDir = join(tmpRoot, 'outside_dir')
mkdirSync(outsideDir, { recursive: true })
const linkDir = join(wsDir, 'linkdir') // symlinked PARENT dir → outside
symlinkSync(outsideDir, linkDir)

let pass = 0, fail = 0
const t = (name: string, fn: () => unknown) => {
  try { fn(); pass++; console.log('ok   ', name) } catch (e: any) { fail++; console.log('FAIL ', name, '\n     ', String(e.message).split('\n')[0]) }
}
const PASS = (p: string, roots?: any) => assert.equal(isSafeArtifactPath(p, roots), true, `expected PASS: ${p}`)
const DENY = (p: string, roots?: any) => assert.equal(isSafeArtifactPath(p, roots), false, `expected DENY: ${p}`)

// ── Legit paths under each root PASS (default WORKSPACE_ROOTS) ────────────────
t('osb workspace file passes', () => PASS(wsFile))
t('osb workspace dir (exact) passes', () => PASS(wsDir))
t('osb workspace dir trailing slash passes', () => PASS(wsDir + sep))
t('osb-first session-sharing index layout passes', () => PASS(idxFile))
t('osborn sessions file passes', () => PASS(sessFile))
t('osborn research file passes', () => PASS(resFile))
t('osborn sessions root (exact) passes', () => PASS(join(osbornHome, 'sessions')))
t('not-yet-existing file under workspace passes (write case)', () => PASS(join(wsDir, 'new-not-created-yet.md')))
t('plans file passes when plans root allowed', () => PASS(planFile, ['plans']))

// ── Traversal / escape / substring attacks FAIL ──────────────────────────────
t('…/osb/../../../etc/passwd FAILS', () => DENY(join(wsDir, '..', '..', '..', '..', '..', '..', '..', 'etc', 'passwd')))
t('/etc/passwd FAILS', () => DENY('/etc/passwd'))
t('literal /osb/ substring but resolves outside FAILS', () => DENY('/tmp/osb/../../etc/passwd'))
t('null byte FAILS', () => DENY(join(wsDir, 'report\u0000.md')))
t('relative osb/../.. traversal FAILS', () => DENY('osb/../../etc/passwd'))
t('substring-not-component (osbornish) FAILS', () => DENY(join(claudeDir, 'projects', SLUG, 'osbornish', 'x')))
t('outside file FAILS', () => DENY(secret))
t('symlinked leaf → outside FAILS (read symlink escape)', () => DENY(evilLink))
t('symlinked parent dir → outside FAILS (write symlink escape)', () => DENY(join(linkDir, 'newfile.txt')))
t('sibling dir sharing name prefix FAILS (prefix boundary)', () => DENY(join(osbornHome, 'sessions-evil', 'x')))
t('empty string FAILS', () => DENY(''))
t('non-string FAILS', () => DENY(undefined as any))
t('bare projects root (no osb component) FAILS', () => DENY(join(claudeDir, 'projects')))

// ── Root scoping: plans is opt-in, not in the default set ─────────────────────
t('plans file DENIED under default workspace roots', () => DENY(planFile))
t('workspace file DENIED when only plans root allowed', () => DENY(wsFile, ['plans']))
t('plans traversal out FAILS even with plans root', () => DENY(join(plansDir, '..', '..', 'etc', 'passwd'), ['plans']))
t('plans → projects crossover FAILS with plans root only', () => DENY(join(plansDir, '..', 'projects', SLUG, 'osb', SESSION, 'report.md'), ['plans']))

// WORKSPACE_ROOTS sanity
t('WORKSPACE_ROOTS excludes plans', () => assert.equal(WORKSPACE_ROOTS.includes('plans' as any), false))

rmSync(tmpRoot, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
