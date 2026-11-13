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
  const m = (env.OSBORN_STEWARD_MODE || 'block').toLowerCase()
  return m === 'advise' || m === 'off' ? m : 'block'
}

// Split a shell command into simple commands (outside quotes) and read each one's
// words, tracking `cd` (subshells restore it). Only a word in command position
// counts: not `grep "git push"` or `echo "... git commit"`.
// `dir: null` = the shell's directory there could not be worked out, so the
// action is skipped rather than checked against a guess.
type Hit = { action: GitAction; dir: string | null }
// Words that can precede a command: keywords, wrappers, and wrappers' options.
const PREFIX = new Set(['sudo', 'command', 'exec', 'env', 'nohup', 'time', 'builtin', 'nice', 'xargs', 'timeout', 'setsid', 'stdbuf', 'doas', 'ionice',
  'then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', '{', '}'])
// Options that take a value, per wrapper.
const TAKES_ARG: Record<string, Set<string>> = {
  sudo: new Set(['-u', '-g', '-h', '-p', '-U', '-C', '-D', '-r', '-t', '-T']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  nice: new Set(['-n', '--adjustment']),
  xargs: new Set(['-a', '-d', '-E', '-I', '-L', '-n', '-P', '-s', '--arg-file', '--delimiter', '--eof', '--max-lines', '--max-procs', '--max-args', '--max-chars']),
  time: new Set(['-f', '-o', '--format', '--output']),
  env: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']),
  exec: new Set(['-a']),
  stdbuf: new Set(['-i', '-o', '-e']),
  doas: new Set(['-u', '-C']),
  ionice: new Set(['-c', '-n', '-p', '-P', '-u', '--class', '--classdata']),
}
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash'])

export function gitActions(cmd: string, cwd: string): Hit[] {
  return scan(cmd, cwd).hits
}

/** gitActions' worker: also returns the directory the shell is left in, so a
 *  `cd` inside `eval`'s argument carries over to the commands after it. */
function scan(cmd: string, cwd: string | null): { hits: Hit[]; dir: string | null } {
  const hits: Hit[] = []
  const home = process.env.HOME || '~'
  const resolveDir = (base: string | null, raw?: string) => {
    if (raw === undefined) return home  // bare `cd`
    if (raw === '') return base          // `cd ""` leaves the shell where it is
    // `-` is $OLDPWD, and a variable or command substitution is expanded by the
    // shell, not here — resolving one literally would invent `<cwd>/$HOME/x`.
    if (raw === '-' || /[$`]/.test(raw)) return null
    const p = raw.replace(/^~(?=\/|$)/, home)
    if (isAbsolute(p)) return p
    return base === null ? null : resolve(base, p)
  }
  let dir = cwd
  let segDir = cwd  // dir at the start of the current simple command, for subshell revert
  const stack: (string | null)[] = []
  let words: string[] = [], word = '', inWord = false, quote: string | null = null, inBacktick = false
  const endWord = () => { if (inWord) words.push(word); word = ''; inWord = false }
  const endCommand = () => {
    endWord()
    let w = words; words = []
    let wrapper = ''
    while (w.length) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w = w.slice(1)
      else if (PREFIX.has(w[0])) { wrapper = w[0]; w = w.slice(1) }
      else if (wrapper === 'env' && /^(-S|--split-string)/.test(w[0])) {  // env -S runs its string as a command
        const rest = w[0].includes('=') ? [w[0].split('=').slice(1).join('='), ...w.slice(1)] : w[0].length > 2 && w[0].startsWith('-S') ? [w[0].slice(2), ...w.slice(1)] : w.slice(1)
        hits.push(...scan(rest.join(' '), dir).hits)  // env execs: a cd inside cannot outlive it
        return
      }
      else if (wrapper && w[0].startsWith('-')) w = w.slice(!w[0].includes('=') && TAKES_ARG[wrapper]?.has(w[0]) ? 2 : 1)
      else if (wrapper === 'timeout' && /^\d+(\.\d+)?[smhd]?$/.test(w[0])) w = w.slice(1)  // timeout's duration
      else break
    }
    if (!w.length) return
    // eval runs its arguments as a command in THIS shell, so a `cd` among them
    // persists — whether it arrived bare (`eval cd sub`) or quoted (`eval 'cd sub'`).
    if (w[0] === 'eval') {
      const sub = scan(w.slice(1).join(' '), dir)
      hits.push(...sub.hits)
      dir = sub.dir ?? dir  // an unknowable cd inside eval must not blank what follows
      return
    }
    const name = w[0].split('/').pop()
    // `cd` takes options before the operand, so the operand is not always w[1]:
    // `cd -- sub` used to be read as a directory literally named "--".
    // (`pushd` is deliberately NOT tracked: without modelling `popd` too, a
    // `pushd sub; popd` pair would leave the tracked dir in sub, which is more
    // wrong than not following it at all.)
    if (name === 'cd') {
      // Skip options (-L -P -e -@, zsh's -q -s, ...) to reach the operand; `--`
      // ends them. `-` alone is not an option, it is $OLDPWD.
      let j = 1
      while (j < w.length && w[j].startsWith('-') && w[j] !== '-') if (w[j++] === '--') break
      dir = resolveDir(dir, w[j])
      return
    }
    // A shell's -c can carry other flags with it (`sh -ec`, `bash -lc`,
    // `bash -o pipefail -c`); its command runs in a subshell, so no cd escapes.
    if (SHELLS.has(name!)) {
      for (let i = 1; i < w.length; i++) {
        if (w[i] === '-o' || w[i] === '+o') { i++; continue }
        if (/^-[a-zA-Z]*c$/.test(w[i])) {
          const arg = w[i + 1] === '--' ? w[i + 2] : w[i + 1]
          if (arg) hits.push(...scan(arg, dir).hits)
          return
        }
        if (!w[i].startsWith('-')) return
      }
      return
    }
    if (name === 'gh') {
      const rest = w.slice(1).filter((x, j, a) => !x.startsWith('-') && !['--repo', '-R', '--hostname'].includes(a[j - 1]))
      if (rest[0] === 'pr' && rest[1] === 'create') hits.push({ action: 'pr', dir })
      return
    }
    if (name !== 'git') return
    let gdir = dir, i = 1
    while (i < w.length && w[i].startsWith('-')) {
      if (w[i] === '-C') { gdir = resolveDir(gdir, w[i + 1]); i += 2 }
      else if (w[i] === '-c' || w[i] === '--git-dir' || w[i] === '--work-tree' || w[i] === '--namespace') i += 2
      else i += 1
    }
    if (w[i] === 'commit' || w[i] === 'push') hits.push({ action: w[i] as GitAction, dir: gdir })
  }
  for (let k = 0; k < cmd.length; k++) {
    const c = cmd[k]
    // Heredoc: its body is data, not commands. Skip to the line holding only the delimiter.
    if (!quote && c === '<' && cmd[k + 1] === '<' && cmd[k + 2] !== '<') {
      const m = cmd.slice(k).match(/^<<-?\s*(['"]?)([A-Za-z0-9_]+)\1/)
      if (m) {
        const nl = cmd.indexOf('\n', k)
        const head = nl < 0 ? cmd.slice(k + m[0].length) : cmd.slice(k + m[0].length, nl)
        const close = nl < 0 ? -1 : cmd.slice(nl + 1).search(new RegExp(`^\\s*${m[2]}\\s*$`, 'm'))
        cmd = cmd.slice(0, k) + head + '\n' + (close < 0 ? '' : cmd.slice(nl + 1 + close).replace(/^[^\n]*\n?/, ''))
        k -= 1; continue
      }
    }
    if (quote) { if (c === quote) quote = null; else if (c === '\\' && quote === '"') word += cmd[++k] ?? ''; else word += c; continue }
    if (c === '"' || c === "'") { quote = c; inWord = true; continue }
    if (c === '\\') { word += cmd[++k] ?? ''; inWord = true; continue }
    if (c === ';' || c === '\n') { endCommand(); segDir = dir; continue }
    // `&&` / `||` continue in this shell; a bare `|` (pipeline element) or `&`
    // (background job) runs its command in a SUBSHELL, so its `cd` dies with it.
    if (c === '&' || c === '|') {
      // Not a separator at all inside a redirection: `>&2`, `2>&1`, `&>log`.
      if (c === '&' && (word.endsWith('>') || cmd[k + 1] === '>')) { word += c; inWord = true; continue }
      const chained = cmd[k + 1] === c
      endCommand()
      if (chained) k++
      else dir = segDir
      segDir = dir
      continue
    }
    // A substitution splits the token stream here, so the word it belongs to is
    // only half-read. Feed it a `$` so resolveDir reads it as unresolvable —
    // otherwise `cd `pwd`` ends a BARE `cd` and resolves it to $HOME, and
    // `cd `echo child`` would check the parent repo's marker for a child commit.
    if (c === '(' || (c === '`' && !inBacktick)) {
      word += '$'; inWord = true
      endCommand(); stack.push(dir); if (c === '`') inBacktick = true; continue
    }
    if (c === ')' || c === '`') { endCommand(); dir = stack.pop() ?? dir; segDir = dir; if (c === '`') inBacktick = false; continue }
    if (c === ' ' || c === '\t') { endWord(); continue }
    word += c; inWord = true
  }
  endCommand()
  return { hits, dir }
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

/** Check a Bash command against the steward sign-off: every git action in it, most restrictive wins. */
export async function stewardGate(cmd: string, cwd: string, mode: StewardMode = stewardMode()): Promise<GateResult> {
  if (mode === 'off') return { decision: 'allow' }
  let unsigned: GitAction | null = null, failed: string | null = null
  for (const hit of gitActions(cmd, cwd)) {
    // An unknown directory (`cd $VAR`, `cd -`) or one the command has not created
    // yet is skipped, as before: there is no repo to read, and nothing the agent
    // could do about a complaint. `git worktree add w && cd w && git commit` is
    // the ordinary case, not an evasion.
    if (hit.dir === null || !existsSync(hit.dir)) continue
    let gitDir: string
    try { gitDir = await git(hit.dir, ['rev-parse', '--absolute-git-dir']) } catch { continue }  // not a repo
    try {
      const markerPath = join(gitDir, MARKER_FILE)
      const marker = existsSync(markerPath) ? (await readFile(markerPath, 'utf8')).trim() : ''
      if (!marker || !await signedFor(hit.dir, hit.action, marker)) { unsigned = unsigned ?? hit.action }
    } catch (e) {
      failed = (e as Error).message.split('\n')[0].slice(0, 160)
      console.log(`[steward-gate] could not check ${hit.action} in ${hit.dir}: ${failed}`)
    }
  }
  if (!unsigned && !failed) return { decision: 'allow' }
  const message = unsigned
    ? `The steward has not signed off on the code in ${unsigned === 'pr' ? 'opening this PR' : `this ${unsigned}`}: run the \`steward\` agent on the change first ` +
      `(it records its sign-off for this exact content; any later edit needs a new sign-off).`
    : `The steward sign-off could not be checked (${failed}).`
  return mode === 'block' ? { decision: 'deny', message } : { decision: 'advise', message }
}
