// Steward sign-off gate (#218): run with `npx tsx agent/tests/steward-gate.test.ts`.
import assert from 'node:assert'
import { execFileSync, execSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stewardGate, gitActions, stewardMode, SIGNOFF_COMMAND } from '../src/steward-gate.js'

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
  assert.equal(gitActions('ls -la', repo)[0], null)
  assert.equal(gitActions('git commit -m x', repo)[0]?.action, 'commit')
  assert.equal(gitActions('git add -A && git commit -m x', repo)[0]?.action, 'commit')
  assert.equal(gitActions('git push -u origin b', repo)[0]?.action, 'push')
  assert.equal(gitActions('gh pr create --fill', repo)[0]?.action, 'pr')
  assert.equal(gitActions('cd /tmp/x && git push', repo)[0]?.dir, '/tmp/x')
  assert.equal(gitActions('git -C sub commit -m x', repo)[0]?.dir, join(repo, 'sub'))
  assert.equal(gitActions('git -c core.x=y commit -m x', repo)[0]?.action, 'commit')
  // Text that merely mentions a command is not the command
  assert.equal(gitActions('grep -rn "git push" .', repo)[0], null)
  assert.equal(gitActions('echo "remember to git commit"', repo)[0], null)
  assert.equal(gitActions('git log | grep "gh pr create"', repo)[0], null)

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
    assert.equal(gitActions(c, repo)[0]?.action, 'push', c)
  assert.equal(gitActions('cd sub; git push', repo)[0]?.dir, join(repo, 'sub'))
  assert.equal(gitActions('(cd sub && git push)', repo)[0]?.dir, join(repo, 'sub'))
  assert.equal(gitActions('(cd sub && true); git push', repo)[0]?.dir, repo, 'a subshell cd does not leak')
  assert.equal(gitActions("echo 'git push; git commit'", repo)[0], null)
  for (const c of ['sudo -u bob git push', 'timeout 30 git push', 'nice git push', 'xargs git push', '/usr/bin/git push',
    'if true; then git push; fi', '{ git push; }', '! git push', 'echo `git push`', "bash -c 'git push'", 'echo $(git push)'])
    assert.equal(gitActions(c, repo)[0]?.action, 'push', c)
  assert.equal(gitActions('gh --repo o/r pr create --fill', repo)[0]?.action, 'pr')
  // #234: eval, per-wrapper options
  for (const c of ['eval git push', 'eval "git push"', 'time -p git push', 'command -p git push', 'xargs -a list git push', 'xargs -L 1 git push', 'nice -n 5 git push', 'timeout -s KILL 30 git push', 'sudo -u bob -g staff git push'])
    assert.equal(gitActions(c, repo)[0]?.action, 'push', c)
  assert.equal(gitActions("eval 'git commit -m x'", repo)[0]?.action, 'commit')
  assert.equal(gitActions('env -S "git push"', repo)[0]?.action, 'push')
  for (const c of ['setsid git push', 'setsid -f git push', 'stdbuf -oL git push', 'stdbuf -o L git push', 'doas git push', 'doas -u bob git push', 'ionice -c 3 git push'])
    assert.equal(gitActions(c, repo)[0]?.action, 'push', c)
  assert.equal(gitActions('eval cd sub; git push', repo)[0]?.dir, join(repo, 'sub'))
  // Heredoc bodies are data: a quote inside one cannot hide what follows, and a script being written is not run
  assert.deepEqual(gitActions("cat > n.md <<'EOF'\nDon't forget\nEOF\ngit commit -am x && git push", repo).map((h) => h.action), ['commit', 'push'])
  assert.deepEqual(gitActions("cat > deploy.sh <<'EOF'\ncd app && git push origin main\nEOF", repo), [])
  writeFileSync(join(repo, 'd.ts'), 'export const d = 7\n')
  assert.equal((await stewardGate('git commit -am x && git push origin HEAD', repo, 'block')).decision, 'deny', 'combined commit+push checks the commit')

  // #245.1: cd's options are not the directory operand
  for (const c of ['cd -L sub; git push', 'cd -P sub; git push', 'cd -- sub; git push', 'cd -LP -- sub; git push', 'cd -q sub; git push', 'eval cd -L sub; git push'])
    assert.equal(gitActions(c, repo)[0]?.dir, join(repo, 'sub'), c)
  // Unknowable directories are recorded as unknown, never guessed at: `cd -` is
  // $OLDPWD, and a variable or command substitution is expanded by the shell.
  for (const c of ['cd -; git push', 'cd $REPO; git push', 'cd "$HOME/x"; git push', 'cd "$(git rev-parse --show-toplevel)"; git push'])
    assert.equal(gitActions(c, repo)[0]?.dir, null, c)

  // #245.2: a cd inside eval's argument persists, however it is quoted
  for (const c of ["eval 'cd sub'; git push", "eval 'cd sub; git push'"])
    assert.equal(gitActions(c, repo)[0]?.dir, join(repo, 'sub'), c)
  // ...but a subshell's cd still does not escape it
  assert.equal(gitActions("sh -c 'cd sub'; git push", repo)[0]?.dir, repo)

  // #245.3: a cd in a pipeline element or background job runs in a subshell
  for (const c of ['cd sub | cat; git push', 'cd sub & git push'])
    assert.equal(gitActions(c, repo)[0]?.dir, repo, c)
  // ...while &&, || and a redirection's & stay in this shell
  for (const c of ['cd sub && git push', 'cd sub || git push', 'cd sub >&2; git push', 'cd sub 2>&1; git push', 'cd sub &>/dev/null; git push'])
    assert.equal(gitActions(c, repo)[0]?.dir, join(repo, 'sub'), c)

  // A directory that is unknown, or that the command has not created yet, is
  // skipped rather than refused: there is no repo to read and no sign-off could
  // ever clear it. `git worktree add w && cd w && git commit` is the ordinary
  // case this protects, not an evasion.
  for (const c of ['cd /tmp/definitely-not-here && git push', 'mkdir fresh && cd fresh && git init && git commit -m x'])
    assert.equal((await stewardGate(c, repo, 'block')).decision, 'allow', c)
  // A substitution in the operand is unresolvable whichever way it is spelled,
  // so the action is skipped rather than checked against a guessed directory —
  // guessing read the PARENT repo's marker for a commit in a child.
  for (const c of ['cd `pwd` && git push', 'cd "$PWD" && git push', 'cd `echo sub` && git commit -am x'])
    assert.equal(gitActions(c, repo)[0]?.dir, null, c)
  // An unknowable cd inside eval must not blank the actions after it.
  assert.equal(gitActions("eval 'cd $NOPE'; git push", repo)[0]?.dir, repo)
  // A shell's -c carries its command however the flags are spelled.
  for (const c of ["sh -ec 'git push'", "bash -lc 'git push'", "bash -o pipefail -c 'git push'", "zsh -fc 'git push'", "sh -c -- 'git push'"])
    assert.equal(gitActions(c, repo)[0]?.action, 'push', c)

  // Not a repo: never blocks
  assert.equal((await stewardGate('git push', tmpdir(), 'block')).decision, 'allow')
  console.log('steward-gate: all assertions passed')
} finally { rmSync(repo, { recursive: true, force: true }) }
}
main().catch((e) => { console.error(e); process.exit(1) })
