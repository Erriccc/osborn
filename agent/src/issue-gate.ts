// Issue-filing gate (#651, privacy mode #663). The agent may file a handoff issue with
// `gh issue create` only in a project switched to public mode, only on the repo named by
// the project's own github.com origin, and only through the approval mode (the dialog unless the
// user chose Allow all). Incognito (the default) keeps the handoff local: nothing leaves the
// machine. `gh repo create` is refused unless it is private: a new project never gets a public
// repo by default. Like the steward gate it guides the agent and is not a sandbox (`gh api`,
// `GH_REPO=` are not parsed).
import { gitActions } from './steward-gate.js'
import { readPublicSince } from './config.js'
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
  }
  return undefined
}

/** Rule on every `gh issue create` and `gh repo create` in a Bash command; the strictest answer wins. */
export function issueGate(cmd: string, cwd: string, deps: IssueGateDeps = {}): IssueGateResult {
  let result: IssueGateResult = { decision: 'allow' }
  for (const hit of gitActions(cmd, cwd)) {
    if (hit.action !== 'issue' && hit.action !== 'repo') continue
    const dir = hit.dir ?? cwd
    if (hit.action === 'repo') {
      if (hit.args?.includes('--private')) continue
      return { decision: 'deny', message: ISSUE_GATE_DENIED.publicRepo }
    }
    if (!(deps.publicSince ?? readPublicSince)(dir)) {
      return { decision: 'deny', message: ISSUE_GATE_DENIED.incognito }
    }
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
