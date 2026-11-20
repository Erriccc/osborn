// The PR-template check in .claude/hooks/pre-pr-gate.py (#233, #253), driven through the real hook.
// Run: npx tsx agent/tests/pre-pr-gate.test.ts
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const HOOK = join(ROOT, '.claude', 'hooks', 'pre-pr-gate.py')

// A throwaway repo with the real template and one commit, so the hook reaches its template check.
const repo = mkdtempSync(join(tmpdir(), 'pre-pr-gate-test-'))
mkdirSync(join(repo, '.github'))
copyFileSync(join(ROOT, '.github', 'pull_request_template.md'), join(repo, '.github', 'pull_request_template.md'))
const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: repo })
git('init', '-q')
git('add', '-A')
git('commit', '-qm', 'init')

/** 'template' when the template check denies, 'pass' when it passes (the run then stops at the steward sign-off). */
function check(body: string): 'template' | 'pass' {
  const r = spawnSync('python3', [HOOK], {
    cwd: repo, env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
    input: JSON.stringify({ tool_name: 'mcp__github__create_pull_request', tool_input: { head: 'HEAD', body } }),
  })
  const reason = String(JSON.parse(String(r.stdout)).hookSpecificOutput.permissionDecisionReason)
  if (reason.startsWith('Fill every PR template section')) return 'template'
  assert.match(reason, /Steward sign-off required/)
  return 'pass'
}
const SECTIONS = ['What changed', 'Why', 'Net-new', 'Removed', 'User time', 'Tested', 'Steward']
const body = (over: Record<string, string> = {}, extra = '') =>
  SECTIONS.map((h) => `## ${h}\n${over[h] ?? 'filled'}\n`).join('\n') + extra

let pass = 0
const t = (name: string, fn: () => unknown) => {
  try { fn(); pass++; console.log('ok   ', name) }
  catch (e: any) { console.log('FAIL ', name, '\n     ', String(e?.message ?? e).split('\n')[0]); process.exitCode = 1 }
}

try {
  t('controls: filled passes; empty, comment-only, missing are denied; (manual) and case still count', () => {
    assert.equal(check(body()), 'pass')
    assert.equal(check(body({ Tested: '' })), 'template')
    assert.equal(check(body({ Tested: '<!-- only a comment -->' })), 'template')
    assert.equal(check(body().replace('## Steward\nfilled\n', '')), 'template')
    assert.equal(check(body().replace('## Tested', '## Tested (manual)')), 'pass')
    assert.equal(check(body().replace('## Tested', '## TESTED')), 'pass')
  })
  t('#253 B1: an unterminated comment or &nbsp; is not content', () => {
    assert.equal(check(body({ Tested: '<!-- unterminated comment' })), 'template')
    assert.equal(check(body({ Tested: 'ran it <!-- note' })), 'pass')
    for (const blank of ['&nbsp;', '&#160;', '&#xA0;', '&#xa0;', '<br>', '<br/>', '<BR />', '&nbsp;<br>\n&#160;']) {
      assert.equal(check(body({ Tested: blank })), 'template', blank)
    }
  })
  t('#253 B2: a heading that only starts with the template word is not the section', () => {
    assert.equal(check(body().replace('## Tested', '## Testedfoo')), 'template')
    assert.equal(check(body().replace('## Net-new', '## Net-newery')), 'template')
    assert.equal(check(body().replace('## Tested', '## Tested_x')), 'template')
  })
  t('#253: punctuation after the heading word still counts as the section', () => {
    for (const h of ['## Why?', '## Why:']) assert.equal(check(body().replace('## Why', h)), 'pass', h)
    for (const h of ['## Tested.', '## Tested—manual', '## Tested (manual)', '## Tested: by hand']) assert.equal(check(body().replace('## Tested', h)), 'pass', h)
  })
  t('#253 B3: duplicate headings pass when any occurrence is filled', () => {
    assert.equal(check(body({}, '\n## Tested\n\n')), 'pass')
    assert.equal(check(body({ Tested: '' }, '\n## Tested\nfilled later\n')), 'pass')
  })
} finally { rmSync(repo, { recursive: true, force: true }) }

console.log(`\n${pass} passed`)
