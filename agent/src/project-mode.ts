/**
 * project-mode.ts — per-project privacy mode (#663).
 *
 * 'incognito' (default): Osborn writes nothing to the project's GitHub repo.
 * 'public' (delegate): the founder turned it on for this project; follow-through
 * may file issues there. Read from project-modes.json in $OSBORN_HOME (else
 * ~/.osborn), keyed by the resolved project folder: { "/abs/folder": "public" }.
 * Anything unreadable or unknown means incognito.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { osbornHomeDir } from './lib/safe-artifact-path.js'

export type ProjectMode = 'incognito' | 'public'

/** The project's mode; incognito unless the founder switched it to public. */
export function getProjectMode(cwd: string): ProjectMode {
  try {
    const all = JSON.parse(readFileSync(join(osbornHomeDir(), 'project-modes.json'), 'utf8'))
    return all?.[resolve(cwd)] === 'public' ? 'public' : 'incognito'
  } catch { return 'incognito' }
}
