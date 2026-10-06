/**
 * lens-library.ts — the LIBRARY STEP of the detached content-lens worker.
 *
 * On each compaction: pick the period that just ended (lens-library-select),
 * run the existing period map on exactly that row range (period-run: strip →
 * redact → one OpenRouter call under PERIOD_CAP_USD, review mode — never the
 * profile or the HWM), and publish ONE page per period to
 *   <project>/osb/<sessionId>/library/<sid8>/<YYYY-MM-DD>-period-<NN>.md
 * then rebuild INDEX.md there. Same layout as the manual c97588f4 backfill.
 *
 * Idempotent: pages are keyed on the period's opening boundary row in
 * .library-manifest.json; a period already written ("ok") is skipped with no
 * model call. A failed run publishes nothing (the reply stays in .staging/) and
 * is retried next time. Fail-open: never throws; the caller just logs the result.
 * Opt-out: OSBORN_CONTENT_LENS=0 (same switch as the launcher).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { loadConversationRows, resolveSessionDb } from './lens-db.js'
import { isContentLensEnabled } from './lens-launch.js'
import { readCompactionBoundaries } from './lens-period-boundaries.js'
import { loadClientRedactor } from './lens-redact.js'
import { redactSecrets } from './transcript-sanitizer.js'
import { runPeriodMap } from './period-run.js'
import { DEFAULT_MIN_SPAN_MS, pageFileName, pickLibraryPeriod, segmentPeriods, type LibraryPeriod } from './lens-library-select.js'
import { rebuildIndex } from './lens-library-index.js'
import { contentHashFor, ingestPage, needsIngest, resolveIngestConfig, type IngestOptions, type IngestState } from './lens-ingest.js'

export const MANIFEST_FILE = '.library-manifest.json'
const STAGING_DIR = '.staging'

export interface ManifestEntry {
  startRowId: number
  endRowId: number
  closedBy: number | 'compaction'
  index: number
  file: string
  status: 'ok' | 'error' | 'dry'
  costUsd: number
  errors: string[]
  updatedAt: string
  /** Cloud ingest outcome (content_ingest RPC). Anything but ok/oversize is retried next run. */
  ingest?: IngestState
}
export interface Manifest {
  version: 1
  sessionId: string
  /** key = String(startRowId) */
  periods: Record<string, ManifestEntry>
}

export type LibraryStatus =
  | 'disabled' | 'no-key' | 'no-db' | 'no-rows' | 'deferred' | 'already-written' | 'written' | 'dry' | 'model-error' | 'failed'

export interface LibraryStepResult {
  status: LibraryStatus
  libraryDir: string | null
  period: LibraryPeriod | null
  page: string | null
  index: string | null
  costUsd: number
  errors: string[]
}

export interface LibraryStepOptions {
  sessionId: string
  projectDir?: string | null
  cwd?: string
  /** No model call: block stats page only (manifest status "dry", never counts as written). */
  dry?: boolean
  /** Write here instead of the session's library dir (dry runs / review). */
  outDir?: string
  minSpanMs?: number
  /** Called every 60s while the step runs (worker refreshes its lock). */
  keepAlive?: () => void
  log?: (m: string) => void
}

/** The record handed to the ingest seam. */
export interface LibraryPageRecord {
  sessionId: string
  key: string
  period: LibraryPeriod
  pagePath: string
  markdown: string
  costUsd: number
}

/**
 * ── INGEST SEAM ──────────────────────────────────────────────────────────────
 * The ONE place a published page goes to the cloud library: Supabase RPC
 * content_ingest (migration 007) as a private draft, authed by OSBORN_SYNC_TOKEN
 * (see lens-ingest.ts). Never throws; the returned state is recorded in the
 * manifest so failures retry next run. Errors here never affect the local page.
 * Opt-out: OSBORN_CONTENT_INGEST=0 (and OSBORN_CONTENT_LENS=0).
 */
export async function ingestLibraryPage(page: LibraryPageRecord, o: IngestOptions = {}): Promise<IngestState> {
  const p = page.period
  return ingestPage({
    sessionId: page.sessionId, startRowId: p.startRowId, endRowId: p.endRowId, index: p.index,
    closedBy: p.closedBy ?? 'compaction', file: basename(page.pagePath), markdown: page.markdown,
  }, o)
}

/**
 * Retry pass: ingest every written ("ok") page whose ingest never succeeded (or
 * whose content changed). No model call. Does nothing when ingest isn't
 * configured. Returns true if the manifest changed. Never throws.
 */
export async function ingestPendingPages(dir: string, m: Manifest, o: IngestOptions & { skipKey?: string } = {}): Promise<boolean> {
  if (!resolveIngestConfig().ok) return false
  let changed = false
  for (const [key, e] of Object.entries(m.periods)) {
    if (e.status !== 'ok' || key === o.skipKey) continue
    try {
      const path = join(dir, e.file)
      if (!existsSync(path)) continue
      const markdown = readFileSync(path, 'utf-8')
      if (!needsIngest(e.ingest, contentHashFor({ sessionId: m.sessionId, startRowId: e.startRowId, markdown }))) continue
      e.ingest = await ingestPage({ sessionId: m.sessionId, startRowId: e.startRowId, endRowId: e.endRowId, index: e.index, closedBy: e.closedBy, file: e.file, markdown }, o)
      changed = true
    } catch {
      /* fail-open: try again next run */
    }
  }
  return changed
}

export function libraryDirFor(dbPath: string, sessionId: string): string {
  return join(dirname(dbPath), 'library', sessionId.slice(0, 8))
}

export function readManifest(dir: string, sessionId: string): Manifest {
  try {
    const o = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf-8'))
    if (o && typeof o.periods === 'object' && !Array.isArray(o.periods)) return { version: 1, sessionId, periods: o.periods }
  } catch {
    /* missing / unreadable → empty */
  }
  return { version: 1, sessionId, periods: {} }
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text, 'utf-8')
  renameSync(tmp, path)
}

export function writeManifest(dir: string, m: Manifest): void {
  writeAtomic(join(dir, MANIFEST_FILE), JSON.stringify(m, null, 2) + '\n')
}

const envNum = (k: string): number | undefined => {
  const n = Number(process.env[k])
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** Run the library step once. Never throws. */
export async function runLibraryStep(o: LibraryStepOptions): Promise<LibraryStepResult> {
  const log = o.log ?? (() => {})
  const res: LibraryStepResult = { status: 'failed', libraryDir: null, period: null, page: null, index: null, costUsd: 0, errors: [] }
  const timer = o.keepAlive ? setInterval(o.keepAlive, 60_000) : null
  timer?.unref()
  try {
    if (!isContentLensEnabled()) return { ...res, status: 'disabled' }
    if (!o.dry && !(process.env.OPENROUTER_API_KEY || '').trim()) return { ...res, status: 'no-key' }
    const db = resolveSessionDb(o.sessionId, o.projectDir, o.cwd)
    if (!db) return { ...res, status: 'no-db' }
    const projectDir = dirname(dirname(dirname(db)))
    const envH = envNum('OSBORN_LIBRARY_MIN_PERIOD_H')
    const minSpan = o.minSpanMs ?? (envH ? envH * 3_600_000 : DEFAULT_MIN_SPAN_MS)
    const dir = (res.libraryDir = o.outDir ?? libraryDirFor(db, o.sessionId))

    // Segment the whole session at its compaction seams (ids + timestamps only).
    const rows = loadConversationRows(db, 0).records.map(r => ({ id: r.id, timestamp: r.timestamp }))
    const seg = segmentPeriods(rows, readCompactionBoundaries(db), minSpan)
    const manifest = readManifest(dir, o.sessionId)
    const pick = pickLibraryPeriod(seg, start => manifest.periods[String(start)]?.status === 'ok', minSpan)
    log(`library: ${seg.closed.length} closed period(s), tail ${seg.tail ? `#${seg.tail.startRowId}–#${seg.tail.endRowId} (${(seg.tail.spanMs / 3_600_000).toFixed(1)}h)` : 'none'} → ${pick.reason}`)
    const red = loadClientRedactor(projectDir)
    const scrub = (s: string) => redactSecrets(red.redact(s), { assistant: true })
    if (pick.reason !== 'tail' && pick.reason !== 'last-closed') {
      // Nothing new to write; still retry pages whose cloud ingest never landed (no model call).
      if (!o.dry && !o.outDir && (await ingestPendingPages(dir, manifest, { scrub, log }))) writeManifest(dir, manifest)
      return { ...res, status: pick.reason }
    }
    const p = (res.period = pick.period)
    const key = String(p.startRowId)
    const file = pageFileName(p)

    // Period map on exactly this row range, staged first; published only when a map came back.
    mkdirSync(join(dir, STAGING_DIR), { recursive: true })
    const staged = join(dir, STAGING_DIR, file)
    const r = await runPeriodMap({ sessionId: o.sessionId, outPath: staged, fromRowId: p.startRowId, toRowId: p.endRowId, dry: o.dry, log })
    res.costUsd = r.costUsd
    res.errors = [...r.errors]
    const ok = !!r.map || !!o.dry
    const entry: ManifestEntry = {
      startRowId: p.startRowId, endRowId: p.endRowId, closedBy: p.closedBy ?? 'compaction', index: p.index, file,
      status: o.dry ? 'dry' : r.map ? 'ok' : 'error', costUsd: r.costUsd, errors: r.errors, updatedAt: new Date().toISOString(),
    }
    if (ok) {
      const marker = `<!-- osborn-library: key=${key} rows=${p.startRowId}-${p.endRowId} closed-by=${entry.closedBy} period=${p.index}${o.dry ? ' dry' : ''} -->\n`
      const markdown = marker + readFileSync(staged, 'utf-8')
      res.page = join(dir, file)
      writeAtomic(res.page, markdown)
      rmSync(staged, { force: true })
      res.index = rebuildIndex(dir, o.sessionId.slice(0, 8), scrub)
      if (!o.dry) {
        try {
          const st = await ingestLibraryPage({ sessionId: o.sessionId, key, period: p, pagePath: res.page, markdown, costUsd: r.costUsd }, { scrub, log })
          entry.ingest = st
        } catch (e: any) {
          log(`library: ingest seam failed (page kept): ${e?.message ?? e}`)
        }
      }
    }
    manifest.periods[key] = entry
    if (!o.dry && !o.outDir) await ingestPendingPages(dir, manifest, { scrub, log, skipKey: key })
    writeManifest(dir, manifest)
    res.status = o.dry ? 'dry' : r.map ? 'written' : 'model-error'
    log(`library: period ${p.index} rows #${p.startRowId}–#${p.endRowId} → ${res.status}${res.page ? ` ${res.page}` : ''} $${r.costUsd.toFixed(4)}${r.errors.length ? ` errors=${r.errors.join('; ')}` : ''}`)
    return res
  } catch (e: any) {
    res.errors.push(e?.message ?? String(e))
    log(`library: failed (fail-open): ${e?.message ?? e}`)
    return { ...res, status: 'failed' }
  } finally {
    if (timer) clearInterval(timer)
  }
}
