// Steward sign-off gate (#218). The steward agent records the tree it approved;
// a commit, push or PR whose tree differs is reported (advise) or refused (block).
// The marker is a git TREE id, so it covers the content, not a commit sha that
// does not exist yet when the steward runs (it runs before the commit).
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

export type StewardMode = 'advise' | 'block' | 'off'
export type GitAction = 'commit' | 'push' | 'pr'

export const MARKER_FILE = 'osborn-steward'

// Run in the repo root after a CLEAN or REFACTORED verdict. Builds the tree of
// the working tree in a throwaway index, so the real index is left alone.
export const SIGNOFF_COMMAND =
  `I=$(mktemp -u) && GIT_INDEX_FILE=$I git read-tree HEAD && GIT_INDEX_FILE=$I git add -A && ` +
  `GIT_INDEX_FILE=$I git write-tree > "$(git rev-parse --git-dir)/${MARKER_FILE}"; rm -f "$I"`

export function stewardMode(env: Record<string, string | undefined> = process.env): StewardMode {
  const m = (env.OSBORN_STEWARD_MODE || 'advise').toLowerCase()
  return m === 'block' || m === 'off' ? m : 'advise'
}

/** The git action a shell command performs, and the directory it runs in (a leading `cd X &&`). */
export function gitAction(cmd: string, cwd: string): { action: GitAction; dir: string } | null {
  const action: GitAction | null = /\bgh\s+pr\s+create\b/.test(cmd) ? 'pr'
    : /\bgit\s+(?:-C\s+\S+\s+)?push\b/.test(cmd) ? 'push'
    : /\bgit\s+(?:-C\s+\S+\s+)?commit\b/.test(cmd) ? 'commit'
    : null
  if (!action) return null
  const cd = cmd.match(/^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*&&/)
  const gitC = cmd.match(/\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)/)
  const raw = (gitC?.[1] ?? cd?.[1])?.replace(/^["']|["']$/g, '')
  const dir = raw ? (isAbsolute(raw) ? raw : resolve(cwd, raw.replace(/^~(?=\/|$)/, process.env.HOME || '~'))) : cwd
  return { action, dir }
}

const git = (dir: string, args: string[], env?: NodeJS.ProcessEnv) =>
  execFileSync('git', args, { cwd: dir, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

/** Tree a commit made now would contain (working tree), or that HEAD holds (push / PR). */
export function treeFor(dir: string, action: GitAction): string {
  if (action !== 'commit') return git(dir, ['rev-parse', 'HEAD^{tree}'])
  const sh = SIGNOFF_COMMAND.replace(/ > "\$\(git rev-parse --git-dir\)\/[^"]+"/, '')
  return execFileSync('sh', ['-c', sh], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

export type GateResult = { decision: 'allow' | 'advise' | 'deny'; message?: string }

/** Check a Bash command against the steward sign-off. Never throws: an unreadable repo is allowed. */
export function stewardGate(cmd: string, cwd: string, mode: StewardMode = stewardMode()): GateResult {
  if (mode === 'off') return { decision: 'allow' }
  const hit = gitAction(cmd, cwd)
  if (!hit || !existsSync(hit.dir)) return { decision: 'allow' }
  let signed = false, tree = ''
  try {
    const marker = join(git(hit.dir, ['rev-parse', '--absolute-git-dir']), MARKER_FILE)
    tree = treeFor(hit.dir, hit.action)
    signed = existsSync(marker) && readFileSync(marker, 'utf8').trim() === tree
  } catch { return { decision: 'allow' } }
  if (signed) return { decision: 'allow' }
  const what = hit.action === 'pr' ? 'opening this PR' : `this ${hit.action}`
  const message = `The steward has not signed off on the code in ${what}: run the \`steward\` agent on the change first ` +
    `(it records its sign-off for this exact tree; any later edit needs a new sign-off).`
  return mode === 'block' ? { decision: 'deny', message } : { decision: 'advise', message }
}
