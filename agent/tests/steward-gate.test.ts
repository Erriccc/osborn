// Steward sign-off gate (#218): run with `npx tsx agent/tests/steward-gate.test.ts`.
import assert from 'node:assert'
import { execFileSync, execSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stewardGate, gitAction, stewardMode, SIGNOFF_COMMAND } from '../src/steward-gate.js'

const repo = mkdtempSync(join(tmpdir(), 'steward-'))
const sh = (cmd: string) => execSync(cmd, { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' })
const signOff = () => execFileSync('sh', ['-c', SIGNOFF_COMMAND], { cwd: repo })
try {
  sh('git init -q && git config user.email t@t && git config user.name t && git config commit.gpgsign false')
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1\n'); sh('git add -A && git commit -qm init')

  // Mode and command parsing
  assert.equal(stewardMode({}), 'advise')
  assert.equal(stewardMode({ OSBORN_STEWARD_MODE: 'BLOCK' }), 'block')
  assert.equal(stewardMode({ OSBORN_STEWARD_MODE: 'nonsense' }), 'advise')
  assert.equal(gitAction('ls -la', repo), null)
  assert.equal(gitAction('git commit -m x', repo)?.action, 'commit')
  assert.equal(gitAction('git add -A && git commit -m x', repo)?.action, 'commit')
  assert.equal(gitAction('git push -u origin b', repo)?.action, 'push')
  assert.equal(gitAction('gh pr create --fill', repo)?.action, 'pr')
  assert.equal(gitAction('cd /tmp/x && git push', repo)?.dir, '/tmp/x')
  assert.equal(gitAction('git -C sub commit -m x', repo)?.dir, join(repo, 'sub'))

  // Unsigned change: advise warns, block refuses, off allows, other commands untouched
  writeFileSync(join(repo, 'b.ts'), 'export const b = 2\n')
  assert.equal(stewardGate('git add -A && git commit -m b', repo, 'advise').decision, 'advise')
  assert.equal(stewardGate('git add -A && git commit -m b', repo, 'block').decision, 'deny')
  assert.equal(stewardGate('git add -A && git commit -m b', repo, 'off').decision, 'allow')
  assert.equal(stewardGate('npm test', repo, 'block').decision, 'allow')

  // Sign-off covers exactly this content, untracked files included, and leaves the index alone
  signOff()
  assert.equal(sh('git status --porcelain').trim(), '?? b.ts', 'sign-off must not stage anything')
  assert.equal(stewardGate('git add -A && git commit -m b', repo, 'block').decision, 'allow')
  writeFileSync(join(repo, 'b.ts'), 'export const b = 3\n')
  assert.equal(stewardGate('git add -A && git commit -m b', repo, 'block').decision, 'deny', 'an edit after sign-off needs a new one')
  signOff()
  sh('git add -A && git commit -qm b')

  // Push / PR check the committed tree
  assert.equal(stewardGate('git push origin HEAD', repo, 'block').decision, 'allow')
  assert.equal(stewardGate('gh pr create --fill', repo, 'block').decision, 'allow')
  writeFileSync(join(repo, 'c.ts'), 'export const c = 4\n'); sh('git add -A && git commit -qm c')
  assert.equal(stewardGate('git push origin HEAD', repo, 'block').decision, 'deny', 'a commit the steward never saw')

  // Not a repo: never blocks
  assert.equal(stewardGate('git push', tmpdir(), 'block').decision, 'allow')
  console.log('steward-gate: all assertions passed')
} finally { rmSync(repo, { recursive: true, force: true }) }
