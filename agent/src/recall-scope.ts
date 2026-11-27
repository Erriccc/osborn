/**
 * recall-scope.ts — which project's memory may reach the model (#657).
 *
 * Default: only the active project. A recalled row from another project (its JSONL
 * `cwd` is not the active working directory or inside it) is dropped, and `osborn-recall`
 * refuses a store of another project. `OSBORN_CROSS_PROJECT_RECALL=on` (or `1`/`true`)
 * is the explicit opt-in. A row with no cwd is kept: it sits in this session's own store.
 */
import { envFlagOn } from './env-keys.js'
import { isWithin } from './lib/safe-artifact-path.js'

export function crossProjectRecallEnabled(): boolean {
  return envFlagOn(process.env.OSBORN_CROSS_PROJECT_RECALL)
}

/** True when a row recorded at `rowCwd` may be shown in a session for `activeCwd`. */
export function rowInScope(rowCwd: string | null | undefined, activeCwd: string | undefined): boolean {
  if (!rowCwd || !activeCwd || crossProjectRecallEnabled()) return true
  return isWithin(rowCwd, activeCwd)
}
