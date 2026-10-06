/**
 * content-run.ts — Stage A orchestrator ("content plan"): step 3 of the
 * compaction-lens worker, after the library step, and the --content CLI entry.
 *
 *   period page (library) → plan pieces → research per topic (demand + §8a
 *   problems, cited, 7-day cache) → briefs (viewer, tier, format, stake) →
 *   scripts (≤1 highlight + ≤3 how-tos) → checks (length, dev-voice pre-pass,
 *   structure, pinned truth-check, audience) → ingest clean drafts (text_post).
 *
 * NEVER throws. Idempotent per period via .content-manifest.json (library dir):
 * a done period costs nothing; settled pieces are never regenerated; a blocked
 * piece is never ingested and never auto-fixed. Caps ⇒ status "capped".
 * Flags: OSBORN_CONTENT_PIPELINE (default ON), OSBORN_CONTENT_LENS, OSBORN_CONTENT_INGEST.
 * --dry: everything except the ingest (it still spends; the caps apply).
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { loadConversationRows, recordView, resolveSessionDb, type DbRecord } from './lens-db.js'
import { readCompactionBoundaries } from './lens-period-boundaries.js'
import { pageFileName, segmentPeriods, type LibraryPeriod } from './lens-library-select.js'
import { libraryDirFor, readManifest } from './lens-library.js'
import { CapError, contentCaps, daySpent, genModel, isContentPipelineEnabled, SpendGuard, type ContentLlmOptions } from './content-llm.js'
import { makeScrubber, type ContentScrubber } from './content-redact.js'
import {
  CONTENT_DIR, isPieceSettled, periodDirName, periodStatusFor, readContentManifest, writeAtomic, writeContentManifest,
  type ContentManifest, type PeriodEntry, type PieceEntry,
} from './content-manifest.js'
import { buildBriefs, loadOwner, planPieces, type Brief, type PieceCandidate } from './content-brief.js'
import { researchCitations, researchDigest, researchTopic, type TopicResearch } from './content-research.js'
import { writeScript, type Script } from './content-script.js'
import { runChecks } from './content-checks.js'
import { ingestScript, isIngestConfigured, pieceContentHash, scriptMarkdown, type ScriptDraft } from './content-ingest.js'
import { needsIngest } from './lens-ingest.js'

export { isContentPipelineEnabled } from './content-llm.js'

export type ContentRunStatus =
  | 'disabled' | 'no-key' | 'no-db' | 'no-page' | 'already-done' | 'done' | 'partial' | 'capped' | 'dry' | 'no-pieces' | 'error' | 'failed'

export interface ContentRunOptions {
  sessionId: string
  projectDir?: string | null
  cwd?: string
  /** The period the library step just handled (hand-off). Otherwise the newest period with a page is picked. */
  period?: LibraryPeriod | null
  dry?: boolean
  /** Bypass the 7-day research cache for this run. */
  researchRefresh?: boolean
  keepAlive?: () => void
  log?: (m: string) => void
}

export interface ContentPieceReport {
  id: string
  tier: string
  status: PieceEntry['status']
  title: string
  flags: string[]
  seconds: number | null
  citations: number
  file: string | null
}

export interface ContentRunResult {
  status: ContentRunStatus
  libraryDir: string | null
  period: { index: number; startRowId: number; endRowId: number; page: string } | null
  pieces: ContentPieceReport[]
  costUsd: number
  capHit: 'period' | 'day' | null
  errors: string[]
}

/** Plan stored once per period (manifest) so reruns never re-plan or re-research. */
interface StoredPlan {
  candidates: PieceCandidate[]
  briefs: Brief[]
  research: Record<string, { key: string; digest: string; citations: { url: string; title: string; source: string }[] }>
}

const PAGE_RANGE_RE = /Rows in block: #(\d+)[–-]#(\d+)/

/**
 * Pick the period: the hand-off when given, else the newest of the last three
 * periods that has a library page on disk and is not done here.
 */
export function pickContentPeriod(db: string, sessionId: string, dir: string, m: ContentManifest, handoff?: LibraryPeriod | null): { period: LibraryPeriod; page: string } | { period: null; reason: 'no-page' | 'already-done' } {
  const isDone = (start: number) => ['done', 'no-pieces'].includes(m.periods[String(start)]?.status ?? '')
  const hasPage = (p: LibraryPeriod) => existsSync(join(dir, pageFileName(p)))
  if (handoff) {
    if (!hasPage(handoff)) return { period: null, reason: 'no-page' }
    return isDone(handoff.startRowId) ? { period: null, reason: 'already-done' } : { period: handoff, page: pageFileName(handoff) }
  }
  const rows = loadConversationRows(db, 0).records.map(r => ({ id: r.id, timestamp: r.timestamp }))
  const seg = segmentPeriods(rows, readCompactionBoundaries(db))
  const lib = readManifest(dir, sessionId)
  const recent = [...(seg.tail ? [seg.tail] : []), ...[...seg.closed].reverse()].slice(0, 3)
  let done = false
  for (const p of recent) {
    const le = lib.periods[String(p.startRowId)]
    if ((le && le.status !== 'ok') || !hasPage(p)) continue
    if (!isDone(p.startRowId)) return { period: p, page: pageFileName(p) }
    done = true
  }
  return { period: null, reason: done ? 'already-done' : 'no-page' }
}

/** The row range the page itself states (manual backfill pages can run past the segment end). */
export function pageRange(page: string, p: LibraryPeriod): { from: number; to: number } {
  const m = page.match(PAGE_RANGE_RE)
  const a = m ? Number(m[1]) : NaN
  const b = m ? Number(m[2]) : NaN
  return { from: Number.isFinite(a) ? Math.min(a, p.startRowId) : p.startRowId, to: Number.isFinite(b) ? Math.max(b, p.endRowId) : p.endRowId }
}

/** Truth-check ground truth: the page, the rows the script draws on, and the research it speaks to. */
export function truthSources(page: string, records: DbRecord[], brief: Brief, script: Script, researchText: string): string {
  const cited = new Set(script.lines.map(l => l.row).filter((r): r is number => !!r))
  const inRange = records.filter(r => cited.has(r.id) || (r.id >= brief.fromRow && r.id <= brief.toRow))
  let used = 0
  const rows: string[] = []
  for (const r of inRange) {
    const v = recordView(r)
    if (used + v.length > 30_000 && !cited.has(r.id)) continue
    used += v.length
    rows.push(v)
  }
  return [`LIBRARY PAGE (period map of the session):\n${page.slice(0, 40_000)}`, `SESSION ROWS:\n${rows.join('\n\n')}`, researchText ? `RESEARCH (public threads):\n${researchText}` : ''].filter(Boolean).join('\n\n')
}

function scrubScript(s: Script, sc: ContentScrubber): Script {
  return { ...s, title: sc.scrub(s.title), hook: sc.scrub(s.hook), lines: s.lines.map(l => ({ ...l, text: sc.scrub(l.text) })), causes: s.causes.map(sc.scrub), terms: s.terms.map(sc.scrub) }
}

const report = (p: PieceEntry, d?: ScriptDraft | null): ContentPieceReport => ({
  id: p.id, tier: p.kind, status: p.status, title: p.title, flags: p.flags,
  seconds: d?.script.estSeconds ?? null, citations: d?.citations.length ?? 0, file: p.file ?? null,
})

function readDraft(dir: string, p: PieceEntry): ScriptDraft | null {
  if (!p.file) return null
  try {
    return JSON.parse(readFileSync(join(dir, p.file), 'utf-8')).draft ?? null
  } catch {
    return null
  }
}

/** Persist one piece's draft (JSON for retries + markdown for review). Returns the path relative to the library dir. */
function saveDraft(dir: string, d: ScriptDraft, piece: PieceEntry): string {
  const rel = join(CONTENT_DIR, periodDirName(d.period.index), `${piece.id}.json`)
  mkdirSync(dirname(join(dir, rel)), { recursive: true })
  writeAtomic(join(dir, rel), JSON.stringify({ status: piece.status, flags: piece.flags, draft: d }, null, 2) + '\n')
  const flags = piece.flags.length ? `\n\n## BLOCKED — ${piece.flags.length} flag(s), not ingested\n${piece.flags.map(f => `- ${f}`).join('\n')}\n` : '\n'
  writeAtomic(join(dir, rel.replace(/\.json$/, '.md')), scriptMarkdown(d) + flags)
  return rel
}

/** Free retry pass: "ready" pieces whose ingest never landed. No model call. Returns true if anything changed. */
async function retryIngests(dir: string, m: ContentManifest, sc: ContentScrubber, log: (s: string) => void, skipKey?: string): Promise<boolean> {
  if (!isIngestConfigured()) return false
  let changed = false
  for (const [key, e] of Object.entries(m.periods)) {
    if (key === skipKey) continue
    for (const p of Object.values(e.pieces)) {
      if (p.status !== 'ready' || !p.contentHash || !needsIngest(p.ingest, p.contentHash)) continue
      const d = readDraft(dir, p)
      if (!d) continue
      p.ingest = await ingestScript(d, sc.scrubDeep, { log })
      if (p.ingest.status === 'ok') p.status = 'ingested'
      changed = true
    }
    if (changed && e.status === 'partial' && !Object.values(e.pieces).some(p => p.status !== 'ingested' && p.status !== 'blocked')) e.status = 'done'
  }
  return changed
}

/** Run Stage A once for one period. Never throws. */
export async function runContentStep(o: ContentRunOptions): Promise<ContentRunResult> {
  const log = o.log ?? (() => {})
  const res: ContentRunResult = { status: 'failed', libraryDir: null, period: null, pieces: [], costUsd: 0, capHit: null, errors: [] }
  const timer = o.keepAlive ? setInterval(o.keepAlive, 60_000) : null
  timer?.unref()
  let guard: SpendGuard | null = null
  try {
    if (!isContentPipelineEnabled()) return { ...res, status: 'disabled' }
    const apiKey = (process.env.OPENROUTER_API_KEY || '').trim()
    if (!apiKey) return { ...res, status: 'no-key' }
    const db = resolveSessionDb(o.sessionId, o.projectDir, o.cwd)
    if (!db) return { ...res, status: 'no-db' }
    const projectDir = dirname(dirname(dirname(db)))
    const dir = (res.libraryDir = libraryDirFor(db, o.sessionId))
    const sc = makeScrubber(projectDir)
    const manifest = readContentManifest(dir, o.sessionId)
    const pick = pickContentPeriod(db, o.sessionId, dir, manifest, o.period)
    if ('reason' in pick) {
      if (!o.dry && (await retryIngests(dir, manifest, sc, log))) writeContentManifest(dir, manifest)
      log(`content: nothing to do (${pick.reason})`)
      return { ...res, status: pick.reason }
    }
    const p = pick.period
    const key = String(p.startRowId)
    const pageText = sc.scrub(readFileSync(join(dir, pick.page), 'utf-8'))
    const range = pageRange(pageText, p)
    const period = (res.period = { index: p.index, startRowId: p.startRowId, endRowId: range.to, page: pick.page })
    const entry: PeriodEntry = manifest.periods[key] ?? {
      startRowId: p.startRowId, endRowId: range.to, index: p.index, page: pick.page, status: 'error', costUsd: 0, pieces: {}, errors: [], updatedAt: '',
    }
    entry.errors = []
    manifest.periods[key] = entry
    const caps = contentCaps()
    const g = (guard = new SpendGuard(projectDir, caps, entry.costUsd))
    const llm: ContentLlmOptions = { apiKey, guard: g, scrub: sc.scrub, log }
    const save = () => {
      entry.costUsd = Number(g.periodUsd.toFixed(6))
      entry.updatedAt = new Date().toISOString()
      writeContentManifest(dir, manifest)
    }
    log(`content: period ${p.index} rows #${range.from}–#${range.to} (${pick.page}); spent so far $${entry.costUsd.toFixed(4)} period / $${daySpent(projectDir).toFixed(4)} today`)
    const records = loadConversationRows(db, range.from - 1, sc.scrub, range.to).records

    // 1. Plan → research → briefs, once per period.
    let plan = entry.plan as StoredPlan | undefined
    if (!plan?.briefs) {
      try {
        const { candidates } = await planPieces(pageText, range, caps.maxPieces, llm)
        const research = new Map<string, TopicResearch>()
        for (const c of candidates) {
          o.keepAlive?.()
          research.set(c.id, await researchTopic({ subtopic: c.subtopic, queries: c.queries }, { projectDir, llm, refresh: o.researchRefresh }))
        }
        const { briefs } = await buildBriefs(candidates, research, loadOwner(projectDir), llm)
        plan = { candidates, briefs, research: Object.fromEntries([...research].map(([id, r]) => [id, { key: r.key, digest: researchDigest(r), citations: researchCitations(r) }])) }
        entry.plan = plan
      } catch (e: any) {
        if (e instanceof CapError) res.capHit = e.cap
        else res.errors.push(`plan: ${e?.message ?? e}`)
        entry.status = e instanceof CapError ? 'capped' : 'error'
        entry.errors = [...res.errors]
        save()
        log(`content: planning stopped (${entry.status}) ${res.errors.join('; ')}`)
        return { ...res, status: entry.status, costUsd: g.runUsd }
      }
    }

    // 2. Script + checks per piece (settled pieces are never regenerated).
    const drafts = new Map<string, ScriptDraft>()
    let capped = false
    for (const b of plan.briefs.slice(0, caps.maxPieces)) {
      const prev = entry.pieces[b.id]
      if (isPieceSettled(prev)) continue
      const piece: PieceEntry = {
        id: b.id, kind: b.tier, status: 'error', title: prev?.title || b.subtopic, flags: [], costUsd: prev?.costUsd ?? 0, errors: [],
        updatedAt: new Date().toISOString(), contentHash: pieceContentHash(o.sessionId, p.startRowId, b.id),
      }
      entry.pieces[b.id] = piece
      if (capped) {
        piece.status = 'capped'
        continue
      }
      if (!b.stake) {
        // WHAT-WORKS rule 1: no provable before/after ⇒ not scripted (no spend).
        piece.status = 'blocked'
        piece.flags = ['brief has no before -> after stake quantity (rule 1: stake and proof both visible)']
        continue
      }
      const r = plan.research[b.id]
      const before = g.runUsd
      try {
        o.keepAlive?.()
        const { script: raw } = await writeScript(b, pageText, records, r?.digest ?? '', llm)
        const script = scrubScript(raw, sc)
        piece.title = script.title || piece.title
        const sources = truthSources(pageText, records, b, script, r?.digest ?? '')
        const { summary, flags } = await runChecks(script, b, { projectDir, llm, records, sources })
        piece.checks = summary
        piece.flags = flags
        piece.status = flags.length ? 'blocked' : 'ready'
        const draft: ScriptDraft = { sessionId: o.sessionId, projectDir, period, brief: b, script, checks: summary, citations: r?.citations ?? [], model: genModel() }
        piece.file = saveDraft(dir, draft, piece)
        drafts.set(b.id, draft)
        log(`content: ${b.id} → ${piece.status}${flags.length ? ` (${flags.length} flag(s))` : ''} ~${script.estSeconds}s`)
      } catch (e: any) {
        if (e instanceof CapError) {
          capped = true
          res.capHit = e.cap
          piece.status = 'capped'
        } else {
          piece.errors = [String(e?.message ?? e)]
          res.errors.push(`${b.id}: ${e?.message ?? e}`)
        }
        log(`content: ${b.id} → ${piece.status}${piece.errors.length ? ` ${piece.errors[0]}` : ''}`)
      } finally {
        piece.costUsd = Number((piece.costUsd + g.runUsd - before).toFixed(6))
        piece.updatedAt = new Date().toISOString()
      }
      save()
    }

    // 3. Ingest clean pieces (never blocked ones). Dry: no ingest.
    let ingestPending = false
    if (!o.dry) {
      for (const pe of Object.values(entry.pieces)) {
        if (pe.status !== 'ready' || (pe.ingest && pe.contentHash && !needsIngest(pe.ingest, pe.contentHash))) continue
        const d = drafts.get(pe.id) ?? readDraft(dir, pe)
        if (!d) continue
        pe.ingest = await ingestScript(d, sc.scrubDeep, { log })
        if (pe.ingest.status === 'ok') pe.status = 'ingested'
        else if (pe.ingest.status === 'error') ingestPending = true
      }
      await retryIngests(dir, manifest, sc, log, key)
    }
    entry.status = periodStatusFor(entry, { dry: !!o.dry, planned: true, ingestPending })
    entry.errors = [...res.errors]
    save()
    res.status = entry.status
    res.pieces = Object.values(entry.pieces).map(pe => report(pe, drafts.get(pe.id) ?? readDraft(dir, pe)))
    res.costUsd = g.runUsd
    log(`content: period ${p.index} → ${res.status} pieces=${res.pieces.map(x => `${x.id}:${x.status}`).join(',') || 'none'} $${g.runUsd.toFixed(4)}`)
    return res
  } catch (e: any) {
    res.errors.push(String(e?.message ?? e))
    log(`content: failed (fail-open): ${e?.message ?? e}`)
    return { ...res, status: 'failed', costUsd: guard?.runUsd ?? 0 }
  } finally {
    if (timer) clearInterval(timer)
  }
}
