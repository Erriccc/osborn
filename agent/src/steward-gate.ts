// Steward sign-off gate (#218). The steward agent records the tree it approved;
// a commit, push or PR whose tree differs is reported (advise) or refused (block).
// The marker is a git TREE id, so it covers the content, not a commit sha that
// does not exist yet when the steward runs (it runs before the commit).
// Scope: the Osborn agent's own sessions. This repo's dev tooling has its own
// pre-PR gate (.claude/hooks/pre-pr-gate.py); the two do not share a marker.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export type StewardMode = 'advise' | 'block' | 'off'
export type GitAction = 'commit' | 'push' | 'pr'

export const MARKER_FILE = 'osborn-steward'

// Tree of the working tree (tracked + untracked, .gitignore respected), built in a
// throwaway index so the real index is left alone. Works in a repo with no commits.
export const TREE_COMMAND =
  `I=$(mktemp -u) && { GIT_INDEX_FILE=$I git read-tree HEAD 2>/dev/null || GIT_INDEX_FILE=$I git read-tree --empty; } && ` +
  `GIT_INDEX_FILE=$I git add -A && GIT_INDEX_FILE=$I git write-tree; S=$?; rm -f "$I"; exit $S`

// Run in the repo root after a CLEAN or REFACTORED verdict.
export const SIGNOFF_COMMAND = `T=$(sh -c '${TREE_COMMAND}') && echo "$T" > "$(git rev-parse --git-dir)/${MARKER_FILE}"`

export function stewardMode(env: Record<string, string | undefined> = process.env): StewardMode {
  const m = (env.OSBORN_STEWARD_MODE || 'advise').toLowerCase()
  return m === 'block' || m === 'off' ? m : 'advise'
}

// Only a command in command position counts: not `grep "git push"` or `echo "... git commit"`.
const AT = String.raw`(?:^|[;&|(\n]\s*)`
const GIT_OPTS = String.raw`(?:\s+-[Cc]\s+\S+)*`

/** The git action a shell command performs, and the directory it runs in (a leading `cd X &&` or `git -C X`). */
export function gitAction(cmd: string, cwd: string): { action: GitAction; dir: string } | null {
  const action: GitAction | null = new RegExp(`${AT}gh\\s+pr\\s+create\\b`).test(cmd) ? 'pr'
    : new RegExp(`${AT}git${GIT_OPTS}\\s+push\\b`).test(cmd) ? 'push'
    : new RegExp(`${AT}git${GIT_OPTS}\\s+commit\\b`).test(cmd) ? 'commit'
    : null
  if (!action) return null
  const cd = cmd.match(/^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*&&/)
  const gitC = cmd.match(/\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)/)
  const raw = (gitC?.[1] ?? cd?.[1])?.replace(/^["']|["']$/g, '')
  const dir = raw ? (isAbsolute(raw) ? raw : resolve(cwd, raw.replace(/^~(?=\/|$)/, process.env.HOME || '~'))) : cwd
  return { action, dir }
}

const git = async (dir: string, args: string[]) => (await run('git', args, { cwd: dir })).stdout.trim()
const workingTree = async (dir: string) => (await run('sh', ['-c', TREE_COMMAND], { cwd: dir })).stdout.trim()

/** Is the content this action ships the content the steward signed off? */
async function signedFor(dir: string, action: GitAction, marker: string): Promise<boolean> {
  // A commit ships the working tree (`git add -A && git commit` is checked before the add runs).
  if (action === 'commit') return (await workingTree(dir)) === marker
  // Push / PR ship HEAD: signed if HEAD is exactly the signed tree, or nothing tracked
  // changed since and the working tree still matches (untracked leftovers allowed).
  if ((await git(dir, ['rev-parse', 'HEAD^{tree}'])) === marker) return true
  const trackedClean = await run('git', ['diff', '--quiet', 'HEAD'], { cwd: dir }).then(() => true, () => false)
  return trackedClean && (await workingTree(dir)) === marker
}

export type GateResult = { decision: 'allow' | 'advise' | 'deny'; message?: string }

/** Check a Bash command against the steward sign-off. Never throws: an unreadable repo is allowed. */
export async function stewardGate(cmd: string, cwd: string, mode: StewardMode = stewardMode()): Promise<GateResult> {
  if (mode === 'off') return { decision: 'allow' }
  const hit = gitAction(cmd, cwd)
  if (!hit || !existsSync(hit.dir)) return { decision: 'allow' }
  try {
    const markerPath = join(await git(hit.dir, ['rev-parse', '--absolute-git-dir']), MARKER_FILE)
    const marker = existsSync(markerPath) ? (await readFile(markerPath, 'utf8')).trim() : ''
    if (marker && await signedFor(hit.dir, hit.action, marker)) return { decision: 'allow' }
  } catch { return { decision: 'allow' } }
  const what = hit.action === 'pr' ? 'opening this PR' : `this ${hit.action}`
  const message = `The steward has not signed off on the code in ${what}: run the \`steward\` agent on the change first ` +
    `(it records its sign-off for this exact content; any later edit needs a new sign-off).`
  return mode === 'block' ? { decision: 'deny', message } : { decision: 'advise', message }
}
