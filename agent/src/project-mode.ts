/**
 * project-mode.ts — per-project privacy mode (#663).
 *
 * 'incognito' (default): Osborn writes nothing to the project's GitHub repo.
 * 'public' (delegate): the founder turned it on for this project; follow-through
 * may file issues there. Stored in ~/.osborn/project-modes.json, keyed by the
 * resolved project folder. Anything unreadable or unknown means incognito.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export type ProjectMode = 'incognito' | 'public'

export function projectModesPath(): string {
  return join(process.env.OSBORN_HOME_DIR || join(homedir(), '.osborn'), 'project-modes.json')
}

const key = (cwd: string) => resolve(cwd)

function readAll(): Record<string, ProjectMode> {
  try {
    const raw = JSON.parse(readFileSync(projectModesPath(), 'utf8'))
    const out: Record<string, ProjectMode> = {}
    if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw)) if (v === 'public') out[k] = 'public'
    return out
  } catch { return {} }
}

/** The project's mode; incognito unless the founder switched it to public. */
export function getProjectMode(cwd: string): ProjectMode {
  return cwd && readAll()[key(cwd)] === 'public' ? 'public' : 'incognito'
}

/** Saves the mode (incognito removes the entry). Returns false if it could not be written. */
export function setProjectMode(cwd: string, mode: ProjectMode): boolean {
  if (!cwd || (mode !== 'public' && mode !== 'incognito')) return false
  try {
    const all = readAll()
    if (mode === 'public') all[key(cwd)] = 'public'
    else delete all[key(cwd)]
    const p = projectModesPath()
    if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true })
    const tmp = `${p}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(all, null, 2))
    renameSync(tmp, p)
    return true
  } catch { return false }
}
