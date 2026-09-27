// Housekeeping: prune stale sub-agent transcripts and empty/corrupt slug dirs from the Claude
// projects tree. Runs on the agent (boot + periodic). Ships DRY-RUN by default so we can eyeball
// what it WOULD delete in fly logs before enabling real deletion (OSBORN_HOUSEKEEPING_DRYRUN=0).
//
// Layout (see session-access.ts for the canonical map):
//   ~/.claude/projects/{slug}/
//     ├── {sessionId}.jsonl                 ← main conversation (the source of truth — NEVER deleted here)
//     ├── {sessionId}/subagents/agent-*.jsonl   ← SDK sub-agent transcripts (TTL target)
//     ├── agent-*.jsonl                     ← project-level native Task transcripts (TTL target)
//     └── osb/{sessionId}/session.db        ← recall store, SLUG-LEVEL sibling of the jsonl (NEVER deleted here)
import { existsSync, readdirSync, statSync, lstatSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { getClaudeProjectsDir } from './config.js'

const DAY_MS = 24 * 60 * 60 * 1000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface HousekeepingResult {
  subagentsRemoved: string[]
  corruptSlugsRemoved: string[]
  scannedSlugs: number
}

/**
 * Prune stale sub-agent transcripts (>ttl) and empty/corrupt slug dirs.
 * SAFE BY DESIGN: never deletes a {sessionId}.jsonl, never touches the active session's
 * subtree, and (unless dryRun=false) deletes nothing at all. Conservative — only removes
 * sub-agent artifacts older than the TTL and slug dirs that contain NO conversation jsonl.
 */
export function cleanupHousekeeping(opts: {
  dryRun: boolean
  activeSessionId?: string | null
  subagentTtlMs?: number
}): HousekeepingResult {
  const { dryRun, activeSessionId } = opts
  const ttl = opts.subagentTtlMs ?? DAY_MS
  const now = Date.now()
  const tag = dryRun ? '🧹[dry-run] WOULD remove' : '🧹 removed'
  const result: HousekeepingResult = { subagentsRemoved: [], corruptSlugsRemoved: [], scannedSlugs: 0 }

  let projectsDir: string
  try { projectsDir = getClaudeProjectsDir() } catch { return result }
  let slugs: string[]
  try { slugs = readdirSync(projectsDir) } catch { return result }

  const rm = (p: string) => { if (!dryRun) { try { rmSync(p, { recursive: true, force: true }) } catch {} } }

  for (const slug of slugs) {
    if (slug.startsWith('.')) continue
    const slugPath = join(projectsDir, slug)
    let slugStat
    try { slugStat = lstatSync(slugPath) } catch { continue }
    if (slugStat.isSymbolicLink()) continue  // never follow or delete symlinked entries

    // Stray non-directory entry directly under projects/ — garbage. Only if old enough,
    // to avoid racing a write-in-progress.
    if (!slugStat.isDirectory()) {
      if (now - slugStat.mtimeMs > ttl) {
        console.log(`${tag} stray projects entry: ${slugPath}`)
        result.corruptSlugsRemoved.push(slugPath); rm(slugPath)
      }
      continue
    }

    result.scannedSlugs++
    let entries: string[]
    try { entries = readdirSync(slugPath) } catch { continue }

    // Which session ids have a live top-level {sessionId}.jsonl in this slug?
    const liveSessionIds = new Set<string>()
    for (const e of entries) {
      if (e.endsWith('.jsonl')) {
        const base = e.slice(0, -6)
        if (UUID_RE.test(base)) liveSessionIds.add(base)
      }
    }
    const slugContainsActive = !!activeSessionId && liveSessionIds.has(activeSessionId)

    // (a) Sub-agent TTL sweep.
    for (const e of entries) {
      const full = join(slugPath, e)
      // Project-level native SDK Task transcripts. Skip the active project's — a long-running
      // active session may have legitimately old task transcripts still relevant to it.
      if (e.startsWith('agent-') && e.endsWith('.jsonl')) {
        if (slugContainsActive) continue
        try {
          if (now - statSync(full).mtimeMs > ttl) {
            console.log(`${tag} subagent transcript: ${full}`)
            result.subagentsRemoved.push(full); rm(full)
          }
        } catch { /* ignore per-entry */ }
        continue
      }
      // Per-session subdir → its subagents/ transcripts. Never the active session's subtree.
      if (UUID_RE.test(e)) {
        if (activeSessionId && e === activeSessionId) continue
        const subagentsDir = join(full, 'subagents')
        if (!existsSync(subagentsDir)) continue
        let subFiles: string[] = []
        try { subFiles = readdirSync(subagentsDir) } catch { continue }
        for (const sf of subFiles) {
          const sfull = join(subagentsDir, sf)
          try {
            if (now - statSync(sfull).mtimeMs > ttl) {
              console.log(`${tag} subagent transcript: ${sfull}`)
              result.subagentsRemoved.push(sfull); rm(sfull)
            }
          } catch { /* ignore per-entry */ }
        }
      }
    }

    // (b) Corrupt/empty slug: ONLY a TRULY EMPTY directory (zero entries) that is stale.
    // We deliberately do NOT delete a slug that merely lacks a top-level *.jsonl — such a dir
    // can still hold a slug-level `osb/{sessionId}/session.db` recall store or orphan subdirs,
    // and a directory's mtime does NOT reflect nested writes, so "no jsonl + stale dir-mtime"
    // is not a safe delete signal. An empty dir has nothing nested to lose.
    if (entries.length === 0 && now - slugStat.mtimeMs > ttl) {
      console.log(`${tag} empty slug dir: ${slugPath}`)
      result.corruptSlugsRemoved.push(slugPath); rm(slugPath)
    }
  }

  const verb = dryRun ? 'would remove' : 'removed'
  console.log(
    `🧹 housekeeping: scanned ${result.scannedSlugs} slug(s); ${verb} ` +
    `${result.subagentsRemoved.length} stale sub-agent artifact(s), ` +
    `${result.corruptSlugsRemoved.length} empty/corrupt slug(s)` +
    (dryRun ? ' (dry-run — set OSBORN_HOUSEKEEPING_DRYRUN=0 to enable deletion)' : ''),
  )
  return result
}
