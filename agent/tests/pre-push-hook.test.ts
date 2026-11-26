// Run: npx tsx agent/tests/pre-push-hook.test.ts
// The git-level push gate (.githooks/pre-push) refuses a branch push without the steward marker
// for the pushed commit, and an auto/* push without the pre-PR review marker too (#629).
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, copyFileSync, chmodSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const hook = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.githooks', 'pre-push')
const root = mkdtempSync(join(tmpdir(), 'pre-push-'))
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()
const remote = join(root, 'remote.git'), work = join(root, 'work')
git(root, 'init', '-q', '--bare', remote)
mkdirSync(work); git(work, 'init', '-q', '-b', 'main')
git(work, 'config', 'user.email', 't@example.com'); git(work, 'config', 'user.name', 't'); git(work, 'config', 'commit.gpgsign', 'false')
git(work, 'remote', 'add', 'origin', remote)
mkdirSync(join(work, '.githooks')); copyFileSync(hook, join(work, '.githooks', 'pre-push')); chmodSync(join(work, '.githooks', 'pre-push'), 0o755)
git(work, 'config', 'core.hooksPath', '.githooks')
writeFileSync(join(work, 'a'), '1'); git(work, 'add', '-A'); git(work, 'commit', '-qm', 'one')
const gd = git(work, 'rev-parse', '--absolute-git-dir')
const push = (branch: string) => spawnSync('git', ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], { cwd: work, encoding: 'utf8' })
const head = () => git(work, 'rev-parse', 'HEAD')

let r = push('feature/x')
assert.notEqual(r.status, 0, 'no steward marker: refused'); assert.match(r.stderr, /no steward sign-off/)
writeFileSync(join(gd, 'steward-reviewed'), 'deadbeef\n')
assert.notEqual(push('feature/x').status, 0, 'stale steward marker: refused')
writeFileSync(join(gd, 'steward-reviewed'), head() + '\n')
assert.equal(push('feature/x').status, 0, 'matching steward marker: allowed on a non-auto branch')
r = push('auto/1-x')
assert.notEqual(r.status, 0, 'auto/* needs the pre-PR marker too'); assert.match(r.stderr, /no pre-PR review/)
writeFileSync(join(gd, 'pre-pr-reviewed'), head() + '\n')
assert.equal(push('auto/1-x').status, 0, 'both markers: allowed')
writeFileSync(join(work, 'a'), '2'); git(work, 'commit', '-qam', 'two')
assert.notEqual(push('auto/1-x').status, 0, 'new commit invalidates both markers')
assert.equal(spawnSync('git', ['push', '-q', 'origin', ':refs/heads/auto/1-x'], { cwd: work }).status, 0, 'deleting a branch is not gated')
console.log('pre-push-hook ok')
