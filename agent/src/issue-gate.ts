// GitHub write gate (#651, privacy mode #663, push and PR #689). In a project switched to public
// mode the agent may run `gh issue create` and `gh pr create` (on the repo of the project's own
// github.com origin only) and `git push`, each through the approval mode (the dialog unless the user
// chose Allow all). Incognito (the default) keeps the work local: nothing is filed, pushed or opened.
// `gh repo create` asks (private) or is refused (public): a new project never gets a public
// repo by default. Like the steward gate it guides the agent and is not a sandbox (`gh api`,
// `GH_REPO=` are not parsed).
import { gitActions } from './steward-gate.js'
import { readPublicSince } from './config.js'
import { isWithin } from './lib/safe-artifact-path.js'
import { repoFromCwd } from './loops-ledger.js'
import type { FlushDeps } from './loops-flush.js'
import { ISSUE_GATE_DENIED } from './prompts.js'

export type IssueGateResult = { decision: 'allow' | 'ask' | 'deny'; message?: string }

/** The same test seams as the follow-through flush (loops-flush.ts), which applies the same public-mode rule. */
export type IssueGateDeps = Pick<FlushDeps, 'publicSince' | 'repoFor'>

/** The value of `--repo X` / `-R X` / `--repo=X` in a gh argument list. */
function repoArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repo' || args[i] === '-R') return args[i + 1]
    if (args[i].startsWith('--repo=')) return args[i].slice(7)
    if (/^-R./.test(args[i])) return args[i].slice(2)
  }
  return undefined
}

/** Rule on every `gh issue|pr|repo create` and `git push` in a Bash command; the strictest answer wins. */
export function issueGate(cmd: string, cwd: string, deps: IssueGateDeps = {}): IssueGateResult {
  let result: IssueGateResult = { decision: 'allow' }
  for (const hit of gitActions(cmd, cwd)) {
    if (hit.action === 'commit') continue
    // The shell's directory could not be worked out (`cd $VAR`): never rule on a guess.
    if (!hit.dir) return { decision: 'deny', message: ISSUE_GATE_DENIED.unknownDir }
    const dir = hit.dir
    if (hit.action === 'repo') {
      // A private repo may still upload the project: it goes through the approval mode.
      if (hit.args?.includes('--private')) { result = { decision: 'ask' }; continue }
      return { decision: 'deny', message: ISSUE_GATE_DENIED.publicRepo }
    }
    // The mode is kept for the session folder, so a command run in a folder inside it uses that folder's mode.
    if (!(deps.publicSince ?? readPublicSince)(isWithin(dir, cwd) ? cwd : dir)) {
      return { decision: 'deny', message: hit.action === 'issue' ? ISSUE_GATE_DENIED.incognito : ISSUE_GATE_DENIED.incognitoShip }
    }
    // A push goes to whatever remote git names; the dialog shows the command, so it is not narrowed to the origin.
    if (hit.action === 'push') { result = { decision: 'ask' }; continue }
    const repo = (deps.repoFor ?? repoFromCwd)(dir)
    if (!repo) {
      return { decision: 'deny', message: ISSUE_GATE_DENIED.noOrigin }
    }
    const target = repoArg(hit.args ?? [])
    if (target && target.toLowerCase() !== repo.toLowerCase()) {
      return { decision: 'deny', message: ISSUE_GATE_DENIED.otherRepo(repo, target) }
    }
    result = { decision: 'ask' }
  }
  return result
}
