/**
 * loops-flush.ts — files a session's open follow-through items (#378).
 *
 * Run by the detached loops-flush worker. Per session: take the per-session
 * flush lock (a second worker exits quietly), fold the ledger, send only the
 * unfiled items the foreground session wrote, append `filed` for each one the
 * frontend confirms (created, or already on GitHub). Any failure writes
 * nothing, so the items stay open for the next flush or the next-start drain.
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { acquireLock, releaseLock } from './content/lens-paths.js'
import { postFollowThrough, type FollowThroughItem } from './follow-through-client.js'
import {
  LOOPS_LOCK, LOOPS_LOCK_TTL_MS, appendLoopRecord, fileableLoops, getLoopsPath, loopKey, readLoopRecords, repoFromCwd,
} from './loops-ledger.js'
import { osbornFrontendUrl } from './pushover.js'
import { getProjectMode, type ProjectMode } from './project-mode.js'

export type FlushStatus = 'locked' | 'incognito' | 'nothing' | 'no-repo' | 'no-token' | 'error' | 'done'

export interface FlushDeps {
  fetchFn?: typeof fetch
  syncToken?: string
  frontendUrl?: string
  /** Test seam: the repo for a cwd (default: the github.com origin). */
  repoFor?: (cwd: string) => string | undefined
  /** Test seam: the fallback repo when the cwd has no origin (default: OSBORN_FOLLOW_THROUGH_DEFAULT_REPO). */
  defaultRepo?: string
  /** Test seam: the project's privacy mode (default: the saved one; incognito unless switched to public). */
  modeFor?: (cwd: string) => ProjectMode
  now?: number
}

// Small enough that the route answers inside the client's timeout (it creates issues one by one).
const MAX_BATCH = 10

/** The cwd or any parent holds `.git`, as `git remote get-url` resolves it (a subfolder counts). */
function inGitCheckout(cwd: string): boolean {
  for (let d = resolve(cwd); ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return true
    if (dirname(d) === d) return false
  }
}

export async function flushSession(sessionId: string, cwd: string, deps: FlushDeps = {}): Promise<{ status: FlushStatus; filed: number; repo?: string; via?: 'origin' | 'default'; detail?: string }> {
  // Incognito (the default) never writes to GitHub: items stay in the local ledger.
  if ((deps.modeFor ?? getProjectMode)(cwd) !== 'public') return { status: 'incognito', filed: 0 }
  const lockDir = dirname(getLoopsPath(sessionId, cwd))
  if (!acquireLock(lockDir, deps.now ?? Date.now(), LOOPS_LOCK, LOOPS_LOCK_TTL_MS)) return { status: 'locked', filed: 0 }
  try {
    const records = readLoopRecords(sessionId, cwd)
    const open = fileableLoops(records)
    if (!open.length) return { status: 'nothing', filed: 0 }
    // The cwd's own origin wins; a multi-project folder with none falls back to the configured default
    // (validated by the route, whose refusal the worker logs).
    const origin = (deps.repoFor ?? repoFromCwd)(cwd)
    // Only a folder that is not a git checkout at all: a repo with a non-GitHub origin never files elsewhere.
    const fallback = inGitCheckout(cwd) ? undefined : deps.defaultRepo ?? (process.env.OSBORN_FOLLOW_THROUGH_DEFAULT_REPO?.trim() || undefined)
    const repo = origin ?? fallback
    const via = origin ? 'origin' as const : 'default' as const
    if (!repo) return { status: 'no-repo', filed: 0 }
    // Once this repo has held an item back it is known public: inferred items, and any ask it held
    // (a security-sounding one), are not re-sent (they would only be held again; if the repo later
    // turns private, they stay local). The user's own asks go first so a long tail of inferred
    // items cannot starve them out.
    const repoKey = repo.toLowerCase()
    const heldHere = new Set(records.filter((r) => r.kind === 'held' && r.repo?.toLowerCase() === repoKey).map((r) => r.id))
    const repoPublic = heldHere.size > 0
    const items = open
      .filter((i) => !(repoPublic && i.source !== 'explicit') && !heldHere.has(i.id))
      .sort((a, b) => (a.source === 'explicit' ? 0 : 1) - (b.source === 'explicit' ? 0 : 1))
      .slice(0, MAX_BATCH)
    if (!items.length) return { status: 'nothing', filed: 0 }
    const syncToken = deps.syncToken ?? process.env.OSBORN_SYNC_TOKEN
    if (!syncToken) return { status: 'no-token', filed: 0 }

    const byKey = new Map<string, string>()
    const payload: FollowThroughItem[] = []
    for (const it of items) {
      const key = loopKey(it.kind, it.text)
      if (byKey.has(key)) continue
      byKey.set(key, it.id)
      payload.push({ key, kind: it.kind, text: it.text, source: it.source, origin: it.origin, ...(typeof it.turn === 'number' ? { turn: it.turn } : {}) })
    }
    if (!payload.length) return { status: 'nothing', filed: 0 }

    let detail: string | undefined
    const results = await postFollowThrough(deps.frontendUrl ?? osbornFrontendUrl(), syncToken, repo, payload, deps.fetchFn, undefined, (d) => { detail = d })
    if (results === 'error') return { status: 'error', filed: 0, repo, via, ...(detail ? { detail } : {}) }
    let filed = 0
    for (const r of results) {
      const id = byKey.get(r.key)
      if (!id) continue
      // Held: the repo is public (or its visibility unknown) and the item is not the user's own ask.
      if (r.action === 'held') appendLoopRecord(sessionId, cwd, { kind: 'held', id, repo })
      if (!r.url || (r.action !== 'created' && r.action !== 'skipped')) continue
      if (appendLoopRecord(sessionId, cwd, { kind: 'filed', id, url: r.url })) filed++
    }
    return { status: 'done', filed, repo, via }
  } finally {
    releaseLock(lockDir, LOOPS_LOCK)
  }
}
