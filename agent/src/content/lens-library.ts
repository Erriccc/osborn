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
 *
 * The step writes one page per run. libraryBacklog lists everything else that is unwritten
 * (older periods, gaps between pages, short stretches) for the catch-up sweep
 * (lens-library-sweep.ts), which writes each through runLibraryStep({ period }).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { resolveSessionDb, loadRowStamps } from './lens-db.js'
import { isContentLensEnabled } from './lens-launch.js'
import { readCompactionBoundaries } from './lens-period-boundaries.js'
import { loadClientRedactor } from './lens-redact.js'
import { redactSecrets } from './transcript-sanitizer.js'
import { runPeriodMap } from './period-run.js'
import { isTransportError } from './lens-model.js'
import { DEFAULT_MIN_SPAN_MS, pageFileName, period, pickLibraryPeriod, segmentPeriods, type LibraryPeriod, type Segmentation } from './lens-library-select.js'
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
  /** Consecutive model errors on this period; the sweep stops retrying it at MAX_PERIOD_FAILURES. */
  failures?: number
  /** Cloud ingest outcome (content_ingest RPC). Anything but ok/oversize is retried next run. */
  ingest?: IngestState
}
export interface Manifest {
  version: 1
  sessionId: string
  /** key = String(startRowId) */
  periods: Record<string, ManifestEntry>
  /** Keys of malformed entries dropped on read (never written back). */
  invalid?: string[]
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
  /** Write exactly this period (the catch-up sweep, from libraryBacklog) instead of picking one. */
  period?: LibraryPeriod
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

const posInt = (n: unknown): n is number => Number.isInteger(n) && (n as number) > 0

/** A manifest entry the segmentation can trust: finite row range and index, a page file, its own key. */
function isValidEntry(key: string, e: any): e is ManifestEntry {
  return !!e && typeof e === 'object' && ['ok', 'error', 'dry'].includes(e.status) && posInt(e.startRowId) && posInt(e.endRowId) &&
    e.endRowId >= e.startRowId && posInt(e.index) && typeof e.file === 'string' && !!e.file && key === String(e.startRowId)
}

/**
 * Malformed entries (hand-edited, legacy, partly written) are dropped and their keys listed in
 * `invalid`, so NaN never reaches segmentation or file names (#271). The next write leaves them out.
 */
export function readManifest(dir: string, sessionId: string): Manifest {
  try {
    const o = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf-8'))
    if (o && typeof o.periods === 'object' && o.periods && !Array.isArray(o.periods)) {
      const periods: Record<string, ManifestEntry> = {}
      const invalid: string[] = []
      for (const [k, e] of Object.entries(o.periods)) {
        if (isValidEntry(k, e)) periods[k] = e
        else invalid.push(k)
      }
      return { version: 1, sessionId, periods, ...(invalid.length ? { invalid } : {}) }
    }
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
  const { invalid: _invalid, ...out } = m
  writeAtomic(join(dir, MANIFEST_FILE), JSON.stringify(out, null, 2) + '\n')
}

const envNum = (k: string): number | undefined => {
  const n = Number(process.env[k])
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * The session's periods as the library writes them (shared with the content step): compaction
 * seams plus the end of every written page, so without a compaction the tail moves on past a
 * written page instead of keeping its start row forever.
 */
export function librarySegments(db: string, manifest: Manifest, minSpanMs = libraryMinSpanMs()): Segmentation {
  const s = segmentLibrary(db, manifest, minSpanMs)
  const closed = [...s.frozen, ...s.gapPeriods, ...s.rest.closed].sort((a, b) => a.startRowId - b.startRowId)
  return { closed, tail: s.rest.tail }
}

/**
 * Written pages are frozen: they keep their rows, index and file whatever the period length is
 * now. Rows after the last written page are segmented and numbered on. Rows BEFORE a written
 * page that no page covers (a tail written while an earlier closed period was not) are segmented
 * too, numbered on from the page before them, so that period is never orphaned (#267). A gap's
 * last stretch is closed by the next written page: a period if it spans the min span, else short.
 */
function segmentLibrary(db: string, manifest: Manifest, minSpanMs: number) {
  const rows = loadRowStamps(db) // ids + timestamps only: no blob is decompressed for segmentation
  const seams = readCompactionBoundaries(db)
  const written = Object.values(manifest.periods).filter(e => e.status === 'ok').sort((a, b) => a.startRowId - b.startRowId)
  const frozen = written.map(e => period(e.index, e.startRowId, e.endRowId, typeof e.closedBy === 'number' ? e.closedBy : null,
    rows.filter(r => r.id >= e.startRowId && r.id <= e.endRowId)))
  const gapPeriods: LibraryPeriod[] = []
  const gapShort: LibraryPeriod[] = []
  let prevEnd = 0
  let prevIndex = 0
  for (const e of written) {
    const gap = rows.filter(r => r.id > prevEnd && r.id < e.startRowId)
    if (gap.length) {
      const g = segmentPeriods(gap, seams, minSpanMs)
      const at = (p: LibraryPeriod): LibraryPeriod => ({ ...p, index: p.index + prevIndex })
      gapPeriods.push(...g.closed.map(at))
      if (g.tail) {
        const t = { ...at(g.tail), closedBy: e.startRowId }
        if (t.spanMs >= minSpanMs) gapPeriods.push(t)
        else gapShort.push(t)
      }
    }
    prevEnd = Math.max(prevEnd, e.endRowId)
    prevIndex = Math.max(prevIndex, e.index)
  }
  const after = segmentPeriods(rows.filter(r => r.id > prevEnd), seams, minSpanMs)
  const renumber = (p: LibraryPeriod): LibraryPeriod => ({ ...p, index: p.index + prevIndex })
  return { frozen, gapPeriods, gapShort, rest: { closed: after.closed.map(renumber), tail: after.tail ? renumber(after.tail) : null } }
}

export function libraryMinSpanMs(): number {
  const envH = envNum('OSBORN_LIBRARY_MIN_PERIOD_H')
  return envH ? envH * 3_600_000 : DEFAULT_MIN_SPAN_MS
}

/** A period whose reply was unusable this many times in a row is no longer retried by the sweep (manual run only). */
const MAX_PERIOD_FAILURES = 3

export interface LibraryBacklog {
  /** Every unwritten period that spans >= the min span, oldest first. */
  periods: LibraryPeriod[]
  /** Stretches that will never reach a page on their own (span < min span): daily-digest material. */
  short: LibraryPeriod[]
}

/**
 * ALL the work the one-per-run pick leaves behind: closed periods older than the last one, the
 * gaps between written pages (rows a later page skipped past), and the tail. Same seams and
 * numbering as librarySegments, so a period found here has the key, index and file the step
 * would give it. Excludes written periods, periods that keep failing, and periods whose file
 * name is already another page's.
 */
export function libraryBacklog(db: string, manifest: Manifest, minSpanMs = libraryMinSpanMs(), log: (m: string) => void = () => {}): LibraryBacklog {
  const s = segmentLibrary(db, manifest, minSpanMs)
  const periods = [...s.gapPeriods, ...s.rest.closed]
  const short = [...s.gapShort]
  const tail = s.rest.tail
  if (tail && tail.spanMs >= minSpanMs) periods.push(tail)
  else if (tail) short.push(tail)
  const owner = new Map(Object.values(manifest.periods).filter(e => e.status === 'ok').map(e => [e.file, e.startRowId]))
  return {
    periods: periods.filter(p => {
      const e = manifest.periods[String(p.startRowId)]
      if (e?.status === 'ok' || (e?.status === 'error' && (e.failures ?? 0) >= MAX_PERIOD_FAILURES)) return false
      const file = pageFileName(p)
      const o = owner.get(file)
      if (o === undefined || o === p.startRowId) return true
      log(`library: period #${p.startRowId}–#${p.endRowId} would be ${file}, which is period #${o}'s page — skipped (write it by hand)`)
      return false
    }),
    short,
  }
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
    const dir = (res.libraryDir = o.outDir ?? libraryDirFor(db, o.sessionId))
    const manifest = readManifest(dir, o.sessionId)
    if (manifest.invalid?.length) log(`library: dropped ${manifest.invalid.length} malformed manifest entry(ies): ${manifest.invalid.slice(0, 5).join(', ')}`)
    const minSpan = o.minSpanMs ?? libraryMinSpanMs()
    const isDone = (start: number) => manifest.periods[String(start)]?.status === 'ok'
    let target: LibraryPeriod | null
    let skipped: LibraryStatus = 'already-written'
    if (o.period) {
      target = isDone(o.period.startRowId) ? null : o.period
      log(`library: backlog period ${o.period.index} rows #${o.period.startRowId}–#${o.period.endRowId} → ${target ? 'backlog' : skipped}`)
    } else {
      const seg = librarySegments(db, manifest, minSpan)
      const pick = pickLibraryPeriod(seg, isDone, minSpan)
      target = pick.period
      if (pick.reason !== 'tail' && pick.reason !== 'last-closed') skipped = pick.reason
      log(`library: ${seg.closed.length} closed period(s), tail ${seg.tail ? `#${seg.tail.startRowId}–#${seg.tail.endRowId} (${(seg.tail.spanMs / 3_600_000).toFixed(1)}h)` : 'none'} → ${pick.reason}`)
    }
    const red = loadClientRedactor(projectDir)
    const scrub = (s: string) => redactSecrets(red.redact(s), { assistant: true })
    if (!target) {
      // Nothing new to write; still retry pages whose cloud ingest never landed (no model call).
      if (!o.dry && !o.outDir && (await ingestPendingPages(dir, manifest, { scrub, log }))) writeManifest(dir, manifest)
      return { ...res, status: skipped }
    }
    const p = (res.period = target)
    const key = String(p.startRowId)
    const file = pageFileName(p)
    // Never overwrite a page this manifest did not write (e.g. a manual backfill page),
    // nor another period's written page that happens to share the file name.
    if (!o.outDir && existsSync(join(dir, file)) && !Object.values(manifest.periods).some(e => e.file === file)) {
      log(`library: ${file} exists and is not ours — not overwritten`)
      return { ...res, status: 'already-written' }
    }
    if (!o.outDir && Object.values(manifest.periods).some(e => e.file === file && e.status === 'ok' && e.startRowId !== p.startRowId)) {
      log(`library: ${file} belongs to another written period — not overwritten`)
      return { ...res, status: 'already-written' }
    }

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
      // Only a reply the step could not use counts toward giving up; an outage (HTTP / network) does not.
      ...(!o.dry && !r.map ? { failures: (manifest.periods[key]?.failures ?? 0) + (isTransportError(r.errors) ? 0 : 1) } : {}),
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
