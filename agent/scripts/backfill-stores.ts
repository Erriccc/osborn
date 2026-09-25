/**
 * backfill-stores.ts — Build a session.db for every session that has a search-index.txt.
 *
 * Walks ~/.claude/projects/{slug}/osb/{sessionId}/ and, for each session that already has
 * a search-index.txt (the legacy flat index), builds/updates the new embedded session.db
 * (full text + FTS5 + sqlite-vec int8). Idempotent — resumes from stored byte offsets, so
 * re-running only ingests new JSONL bytes.
 *
 * Runs locally or on a Fly machine (where sessions actually live).
 *
 * Usage:
 *   npx tsx scripts/backfill-stores.ts [--no-embed] [--slug <slug>] [--limit N] [--all-sessions]
 *
 *   --no-embed       keyword-only (skip MiniLM). Fast; vec layer stays empty.
 *   --slug <slug>    only this project slug (e.g. -workspace).
 *   --limit N        cap number of sessions processed.
 *   --all-sessions   target every {sessionId}.jsonl, not just those with a search-index.
 */

import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { updateSessionStore } from '../src/session-store.js'
import { getEmbedder } from '../src/embedder.js'

function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

interface Target { slug: string; sessionId: string; jsonl: string }

/** Discover (slug, sessionId) pairs to backfill. slug doubles as workingDir (round-trips). */
function discover(opts: { slug?: string; allSessions?: boolean }): Target[] {
  const projects = join(claudeDir(), 'projects')
  if (!existsSync(projects)) return []
  const slugs = (opts.slug ? [opts.slug] : readdirSync(projects))
    .filter(s => existsSync(join(projects, s)) && statSync(join(projects, s)).isDirectory())

  const targets: Target[] = []
  for (const slug of slugs) {
    const base = join(projects, slug)
    if (opts.allSessions) {
      // every {sessionId}.jsonl at the project root
      for (const f of readdirSync(base)) {
        if (f.endsWith('.jsonl')) {
          const sid = f.slice(0, -'.jsonl'.length)
          targets.push({ slug, sessionId: sid, jsonl: join(base, f) })
        }
      }
    } else {
      // only sessions that already have osb/{sid}/search-index.txt
      const osb = join(base, 'osb')
      if (!existsSync(osb)) continue
      for (const sid of readdirSync(osb)) {
        if (existsSync(join(osb, sid, 'search-index.txt'))) {
          targets.push({ slug, sessionId: sid, jsonl: join(base, `${sid}.jsonl`) })
        }
      }
    }
  }
  return targets
}

async function main() {
  const argv = process.argv.slice(2)
  const has = (f: string) => argv.includes(f)
  const val = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined }

  const noEmbed = has('--no-embed')
  const allSessions = has('--all-sessions')
  const slug = val('--slug')
  const limit = val('--limit') ? parseInt(val('--limit')!, 10) : Infinity

  let targets = discover({ slug, allSessions })
  if (targets.length > limit) targets = targets.slice(0, limit)

  console.log(`backfill: ${targets.length} session(s) [${allSessions ? 'all-sessions' : 'has-search-index'}]${noEmbed ? ' keyword-only' : ' hybrid'}`)
  if (!targets.length) { console.log('nothing to do'); return }

  const embed = noEmbed ? null : await getEmbedder()
  if (!noEmbed && !embed) console.log('  (embedder unavailable — proceeding keyword-only)')

  let ok = 0, failed = 0, totalNew = 0, totalEmbedded = 0
  const t0 = Date.now()
  for (const [i, t] of targets.entries()) {
    if (!existsSync(t.jsonl)) { console.log(`  [${i + 1}/${targets.length}] SKIP ${t.sessionId} (no jsonl)`); continue }
    try {
      const stats = await updateSessionStore(t.sessionId, t.slug, { embed: embed ?? undefined })
      ok++; totalNew += stats.newRows; totalEmbedded += stats.embeddedRows
      console.log(`  [${i + 1}/${targets.length}] ${t.sessionId}  +${stats.newRows} rows, ${stats.totalRows} total, ${(stats.bytes / 1024 / 1024).toFixed(2)}MB, embedded=${stats.embeddedRows}`)
    } catch (err: any) {
      failed++
      console.log(`  [${i + 1}/${targets.length}] FAIL ${t.sessionId}: ${err?.message || err}`)
    }
  }
  console.log(`\ndone: ${ok} ok, ${failed} failed, +${totalNew} rows, ${totalEmbedded} embedded, ${((Date.now() - t0) / 1000).toFixed(1)}s`)
}

main().catch(err => { console.error('backfill error:', err); process.exit(1) })
