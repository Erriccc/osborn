// Issue-filing gate (#651, privacy mode #663). The agent may file a handoff issue with
// `gh issue create` only in a project switched to public mode, only on the repo named by
// the project's own github.com origin, and only through the approval dialog. Incognito
// (the default) keeps the handoff local: nothing leaves the machine. `gh repo create`
// is refused unless it is private: a new project never gets a public repo by default.
import { gitActions } from './steward-gate.js'
import { readPublicSince } from './config.js'
import { repoFromCwd } from './loops-ledger.js'

export type IssueGateResult = { decision: 'allow' | 'ask' | 'deny'; message?: string }

export interface IssueGateDeps {
  publicSince?: (cwd: string) => string | undefined
  repoFor?: (cwd: string) => string | undefined
}

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
      return { decision: 'deny', message: 'A new repository is never public by default. Offer the user a PRIVATE repo (`gh repo create --private`) and ask before creating it.' }
    }
    if (!(deps.publicSince ?? readPublicSince)(dir)) {
      return { decision: 'deny', message: 'This project is incognito (the default), so nothing is filed on GitHub. Keep the handoff local: write it to the session workspace and tell the user where it is.' }
    }
    const repo = (deps.repoFor ?? repoFromCwd)(dir)
    if (!repo) {
      return { decision: 'deny', message: 'This project has no github.com origin to name, so no issue is filed. Keep the handoff local, or offer the user a PRIVATE repo for it.' }
    }
    const target = repoArg(hit.args ?? [])
    if (target && target.toLowerCase() !== repo.toLowerCase()) {
      return { decision: 'deny', message: `Issues for this project go to ${repo} only; --repo ${target} is refused.` }
    }
    result = { decision: 'ask' }
  }
  return result
}
