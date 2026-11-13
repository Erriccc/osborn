// Steward sign-off gate (#218): run with `npx tsx agent/tests/steward-gate.test.ts`.
import assert from 'node:assert'
import { execFileSync, execSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stewardGate, gitAction, gitActions, stewardMode, SIGNOFF_COMMAND } from '../src/steward-gate.js'

async function main() {
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
  assert.equal(gitAction('git -c core.x=y commit -m x', repo)?.action, 'commit')
  // Text that merely mentions a command is not the command
  assert.equal(gitAction('grep -rn "git push" .', repo), null)
  assert.equal(gitAction('echo "remember to git commit"', repo), null)
  assert.equal(gitAction('git log | grep "gh pr create"', repo), null)

  // Unsigned change: advise warns, block refuses, off allows, other commands untouched
  writeFileSync(join(repo, 'b.ts'), 'export const b = 2\n')
  assert.equal((await stewardGate('git add -A && git commit -m b', repo, 'advise')).decision, 'advise')
  assert.equal((await stewardGate('git add -A && git commit -m b', repo, 'block')).decision, 'deny')
  assert.equal((await stewardGate('git add -A && git commit -m b', repo, 'off')).decision, 'allow')
  assert.equal((await stewardGate('npm test', repo, 'block')).decision, 'allow')

  // Sign-off covers exactly this content, untracked files included, and leaves the index alone
  signOff()
  assert.equal(sh('git status --porcelain').trim(), '?? b.ts', 'sign-off must not stage anything')
  assert.equal((await stewardGate('git add -A && git commit -m b', repo, 'block')).decision, 'allow')
  writeFileSync(join(repo, 'b.ts'), 'export const b = 3\n')
  assert.equal((await stewardGate('git add -A && git commit -m b', repo, 'block')).decision, 'deny', 'an edit after sign-off needs a new one')
  signOff()
  sh('git add -A && git commit -qm b')

  // Push / PR check the committed tree
  assert.equal((await stewardGate('git push origin HEAD', repo, 'block')).decision, 'allow')
  assert.equal((await stewardGate('gh pr create --fill', repo, 'block')).decision, 'allow')
  writeFileSync(join(repo, 'c.ts'), 'export const c = 4\n'); sh('git add -A && git commit -qm c')
  assert.equal((await stewardGate('git push origin HEAD', repo, 'block')).decision, 'deny', 'a commit the steward never saw')

  // Signed with an untracked leftover, committed only part: push still counts as signed
  writeFileSync(join(repo, 'd.ts'), 'export const d = 5\n'); writeFileSync(join(repo, 'notes.txt'), 'scratch\n')
  signOff()
  sh('git add d.ts && git commit -qm d')
  assert.equal((await stewardGate('git push origin HEAD', repo, 'block')).decision, 'allow', 'untracked leftovers do not void the sign-off')
  writeFileSync(join(repo, 'd.ts'), 'export const d = 6\n')
  assert.equal((await stewardGate('git push origin HEAD', repo, 'block')).decision, 'deny', 'uncommitted tracked edits do')

  // A repo with no commits can be signed off
  const fresh = mkdtempSync(join(tmpdir(), 'steward-empty-'))
  execSync('git init -q', { cwd: fresh }); writeFileSync(join(fresh, 'x.ts'), 'x\n')
  assert.equal((await stewardGate('git add -A && git commit -m x', fresh, 'block')).decision, 'deny')
  execFileSync('sh', ['-c', SIGNOFF_COMMAND], { cwd: fresh })
  assert.equal((await stewardGate('git add -A && git commit -m x', fresh, 'block')).decision, 'allow')
  rmSync(fresh, { recursive: true, force: true })

  // #220: every git action in a command is checked, wherever it sits
  assert.deepEqual(gitActions('git commit -am x && git push origin main', repo).map((h) => h.action), ['commit', 'push'])
  for (const c of [' git push', 'FOO=1 git push', 'sudo -E git push', 'command git push', 'git --no-pager -c a=b push', 'git -C . push'])
    assert.equal(gitAction(c, repo)?.action, 'push', c)
  assert.equal(gitAction('cd sub; git push', repo)?.dir, join(repo, 'sub'))
  assert.equal(gitAction('(cd sub && git push)', repo)?.dir, join(repo, 'sub'))
  assert.equal(gitActions('(cd sub && true); git push', repo)[0]?.dir, repo, 'a subshell cd does not leak')
  assert.equal(gitAction("echo 'git push; git commit'", repo), null)
  writeFileSync(join(repo, 'd.ts'), 'export const d = 7\n')
  assert.equal((await stewardGate('git commit -am x && git push origin HEAD', repo, 'block')).decision, 'deny', 'combined commit+push checks the commit')

  // Not a repo: never blocks
  assert.equal((await stewardGate('git push', tmpdir(), 'block')).decision, 'allow')
  console.log('steward-gate: all assertions passed')
} finally { rmSync(repo, { recursive: true, force: true }) }
}
main().catch((e) => { console.error(e); process.exit(1) })
