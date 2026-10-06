/**
 * compaction-lens.ts — the content-lens PIPELINE (runs inside the detached
 * worker process, never in the live agent).
 *
 *  1. SOURCE = the session's recall store (session.db), conversation rows only
 *     (user + assistant text), secret-sanitized + client-redacted (lens-db.ts)
 *  2. incremental: rows newer than the per-session high-water mark;
 *     backfill: the whole session from row 0
 *  3. page IN ORDER in windows of ~25% of the model's context; MAP each window
 *  4. extract ANGLES + CAPABILITIES (shipped | root-caused), verbatim quotes;
 *     plans/speculation and billing angles dropped
 *  5. DETERMINISTIC grounding check against the rows — unverifiable items dropped
 *  6. REDUCE/merge across windows; grounding check again
 *  7. HN gap check (fail-open), optional recording, client-redact the entry,
 *     APPEND to <project>/content-profile.md (or a scratch file); advance HWM
 */

import { basename, dirname } from 'node:path'
import { loadConversationRows, packWindows, resolveSessionDb, type DbRecord } from './lens-db.js'
import {
  buildRecordIndex, explainQuote, parseJsonObject, readAngles, readCapabilities, splitByEvidence, verifyItems,
  type Evidence, type QuoteIndex, type RawAngle, type RawCapability,
} from './lens-quotes.js'
import { Budget, chat, getModelInfo, mapPrompt, reducePrompt, windowTokensFor } from './lens-model.js'
import { DENYLIST_FILE, hasBillingQuote, isBillingAngle, isBillingCapability, loadClientRedactor } from './lens-redact.js'
import { gapCheck } from './lens-hn.js'
import { makeScrubber } from './content-redact.js'
import { gateQueries, privateSegments } from './content-query-gate.js'
import { alignRecording, findSessionRecording } from './lens-audio.js'
import { appendProfile, formatEntry, writeScratch, type FinalAngle, type FinalCapability } from './lens-profile.js'
import { findTranscriptBySessionId, isProjectDir, readHwm, refuseOutPath, resolveProjectDir, writeHwm } from './lens-paths.js'

const LIMITS = {
  map: { a: 4, c: 8 },
  incremental: { a: 3, c: 6 },
  backfill: { a: 8, c: 20 },
}
const envInt = (k: string, d: number): number => {
  const n = Math.floor(Number(process.env[k]))
  return Number.isFinite(n) && n > 0 ? n : d
}

export interface LensRunOptions {
  sessionId: string
  transcriptPath?: string
  cwd?: string
  /** incremental (default, per compaction) = rows after the HWM; backfill = whole session. */
  mode?: 'incremental' | 'backfill'
  /** Cap on windows processed this run (incremental default OSBORN_LENS_MAX_WINDOWS || 2). */
  maxWindows?: number
  /** Override the starting row (exclusive). */
  startAfterRowId?: number
  /** Write here (overwrite) instead of appending to content-profile.md. Never the profile/HWM file; forces no HWM update. */
  outPath?: string
  /** Ignored (always false) when outPath is set. */
  updateHwm?: boolean
  /** Called after each window (worker refreshes its lock). */
  onWindow?: () => void
  /** Harness-only hook to tamper with candidates before the final grounding check. */
  mutateCandidates?: (c: Candidates) => void
  log?: (msg: string) => void
}

export interface WindowStat { rows: number; chars: number; estTokens: number; firstRowId: number; lastRowId: number }

export interface LensRunReport {
  status: 'no-key' | 'no-db' | 'model-unknown' | 'no-input' | 'nothing-survived' | 'written'
  mode: 'incremental' | 'backfill'
  projectDir: string | null
  dbPath: string | null
  model?: { id: string; contextLength: number; promptPerM: number; completionPerM: number; verified: boolean }
  windowTokens: number
  rowsRead: number
  records: number
  sanitizerDropped: number
  windowsTotal: number
  windowsProcessed: number
  windows: WindowStat[]
  modelCalls: number
  modelFailures: number
  refused: number
  costUsd: number
  mapDropped: { angles: number; capabilities: number }
  dropped: { angles: number; capabilities: number }
  notDone: number
  billingDropped: number
  kept: { angles: number; capabilities: number }
  hwmBefore: number
  hwmAfter: number
  redactTerms: number
  denylistLoaded: boolean
  recording: string | null
  angles: FinalAngle[]
  capabilities: FinalCapability[]
  outPath?: string
  entry?: string
}

export type Candidates = { angles: RawAngle[]; capabilities: RawCapability[] }

/** Parse + done-vs-planned gate + billing exclusion (angles: title/why; capabilities: name/did/proof). */
export function readCandidates(raw: string, maxA: number, maxC: number, r: Pick<LensRunReport, 'billingDropped' | 'notDone'>): Candidates {
  const o = parseJsonObject(raw)
  const angles = readAngles(o?.angles, maxA)
  const { done, notDone } = splitByEvidence(readCapabilities(o?.capabilities, maxC))
  r.notDone += notDone
  const keptA = angles.filter(a => !isBillingAngle(a))
  const keptC = done.filter(c => !isBillingCapability(c))
  r.billingDropped += angles.length - keptA.length + done.length - keptC.length
  return { angles: keptA, capabilities: keptC }
}

/** Grounding check; afterwards drops any item whose VERIFIED quote text is billing talk (counted in billingDropped). */
export function ground(c: Candidates, idx: QuoteIndex, r: Pick<LensRunReport, 'billingDropped'>): { c: Candidates; dA: number; dC: number } {
  const a = verifyItems(c.angles, idx)
  const k = verifyItems(c.capabilities, idx)
  const angles = a.kept.filter(x => !hasBillingQuote(x)) as RawAngle[]
  const capabilities = k.kept.filter(x => !hasBillingQuote(x)) as RawCapability[]
  r.billingDropped += a.kept.length - angles.length + k.kept.length - capabilities.length
  return { c: { angles, capabilities }, dA: a.dropped, dC: k.dropped }
}

/** Run the pipeline once. Throws only on unexpected errors (worker catches). */
export async function runCompactionLens(opts: LensRunOptions): Promise<LensRunReport> {
  const log = opts.log ?? (() => {})
  const mode = opts.mode ?? 'incremental'
  let projectDir = resolveProjectDir(opts.transcriptPath, opts.cwd)
  if (!projectDir) {
    const t = findTranscriptBySessionId(opts.sessionId)
    if (t && isProjectDir(dirname(t))) projectDir = dirname(t)
  }
  const r: LensRunReport = {
    status: 'no-input', mode, projectDir, dbPath: null, windowTokens: 0, rowsRead: 0, records: 0, sanitizerDropped: 0,
    windowsTotal: 0, windowsProcessed: 0, windows: [], modelCalls: 0, modelFailures: 0, refused: 0, costUsd: 0,
    mapDropped: { angles: 0, capabilities: 0 }, dropped: { angles: 0, capabilities: 0 }, notDone: 0, billingDropped: 0,
    kept: { angles: 0, capabilities: 0 }, hwmBefore: 0, hwmAfter: 0, redactTerms: 0, denylistLoaded: false, recording: null, angles: [], capabilities: [],
  }
  if (opts.outPath !== undefined) {
    const why = refuseOutPath(opts.outPath, projectDir)
    if (why) throw new Error(`content lens: ${why}`)
  }
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) return { ...r, status: 'no-key' }
  r.dbPath = resolveSessionDb(opts.sessionId, projectDir, opts.cwd)
  if (!r.dbPath) return { ...r, status: 'no-db' }
  if (!projectDir) projectDir = r.projectDir = dirname(dirname(dirname(r.dbPath)))

  const info = await getModelInfo(apiKey)
  if (!info) return { ...r, status: 'model-unknown' }
  r.model = { id: info.id, contextLength: info.contextLength, promptPerM: info.promptPerTok * 1e6, completionPerM: info.completionPerTok * 1e6, verified: info.verified }
  r.windowTokens = windowTokensFor(info)

  r.hwmBefore = r.hwmAfter = readHwm(projectDir, opts.sessionId)
  const start = opts.startAfterRowId ?? (mode === 'backfill' ? 0 : r.hwmBefore)
  const redactor = loadClientRedactor(projectDir)
  r.redactTerms = redactor.terms
  r.denylistLoaded = !!redactor.source
  if (!redactor.source) log(`WARNING: no client denylist loaded (${DENYLIST_FILE} in project dir or OSBORN_LENS_DENYLIST) — shape-based redaction only`)
  const load = loadConversationRows(r.dbPath, start, redactor.redact)
  r.rowsRead = load.stats.rowsRead
  r.records = load.records.length
  r.sanitizerDropped = load.stats.dropped
  // A review copy (outPath) NEVER moves the HWM, whatever updateHwm says.
  const updateHwm = opts.outPath !== undefined ? false : (opts.updateHwm ?? true)
  const bumpHwm = (rowId: number) => {
    if (!updateHwm || rowId <= r.hwmAfter) return
    writeHwm(projectDir!, opts.sessionId, rowId)
    r.hwmAfter = rowId
  }

  const all = packWindows(load.records, r.windowTokens)
  r.windowsTotal = all.length
  const maxWindows = opts.maxWindows ?? (mode === 'backfill' ? all.length : envInt('OSBORN_LENS_MAX_WINDOWS', 2))
  const todo = all.slice(0, maxWindows)
  log(`db ${r.dbPath}: rows>${start} read=${r.rowsRead} kept=${r.records} → ${all.length} window(s) of ≤${r.windowTokens} tok; running ${todo.length}`)
  if (!todo.length) {
    bumpHwm(load.maxRowId) // everything new was sanitizer-dropped noise
    return r
  }

  // MAP — in order; stop at the first failure/refusal so the HWM never skips a window.
  const budget = new Budget(info)
  const pool: Candidates = { angles: [], capabilities: [] }
  const seen: DbRecord[] = []
  for (const w of todo) {
    r.windows.push({ rows: w.records.length, chars: w.chars, estTokens: w.estTokens, firstRowId: w.firstRowId, lastRowId: w.lastRowId })
    let res: Awaited<ReturnType<typeof chat>>
    try {
      res = await chat(budget, mapPrompt(w.text, w.index + 1, all.length, LIMITS.map.a, LIMITS.map.c), apiKey)
    } catch (err) {
      log(`map ${w.index + 1}/${all.length} failed: ${err instanceof Error ? err.message : err}`)
      break
    }
    if (!res) {
      log(`map ${w.index + 1}/${all.length}: budget cap reached ($${budget.spentUsd.toFixed(4)}/${budget.maxCostUsd}, ${budget.calls}/${budget.maxCalls} calls) — stopping`)
      break
    }
    seen.push(...w.records)
    r.windowsProcessed++
    const parsed = readCandidates(res.content, LIMITS.map.a, LIMITS.map.c, r)
    if (parsed.angles.length + parsed.capabilities.length === 0) {
      log(`map ${w.index + 1}: no items parsed (provider=${res.provider}); reply head: ${res.content.slice(0, 300)}`)
    }
    const widx = buildRecordIndex(w.records)
    if (process.env.OSBORN_LENS_DEBUG) {
      for (const it of [...parsed.angles, ...parsed.capabilities] as { quotes: any[] }[]) {
        for (const q of it.quotes) {
          const why = explainQuote(q, widx)
          if (why !== 'ok') log(`  quote fail [${why}] @${q?.timestamp} #${q?.row}: ${String(q?.text).slice(0, 120)}`)
        }
      }
    }
    const g = ground(parsed, widx, r)
    r.mapDropped.angles += g.dA
    r.mapDropped.capabilities += g.dC
    pool.angles.push(...g.c.angles)
    pool.capabilities.push(...g.c.capabilities)
    log(`map ${w.index + 1}/${all.length}: ${w.records.length} rows ~${w.estTokens} tok, ${res.promptTokens}+${res.completionTokens} tok finish=${res.finish} $${res.costUsd.toFixed(4)}; kept ${g.c.angles.length}A/${g.c.capabilities.length}C dropped ${g.dA}A/${g.dC}C`)
    opts.onWindow?.()
  }
  r.modelCalls = budget.calls
  if (!r.windowsProcessed) {
    r.modelFailures = budget.failures
    r.refused = budget.refused
    r.costUsd = budget.spentUsd
    return { ...r, status: 'nothing-survived' }
  }
  const lim = LIMITS[mode]
  const idx = buildRecordIndex(seen)

  // REDUCE — merge across windows (skipped when one window already fits the caps).
  let cands: Candidates = pool
  const needReduce = r.windowsProcessed > 1 || pool.angles.length > lim.a || pool.capabilities.length > lim.c
  if (needReduce && pool.angles.length + pool.capabilities.length > 0) {
    try {
      const res = await chat(budget, reducePrompt(JSON.stringify(pool), lim.a, lim.c), apiKey, 12_000)
      const out = res ? readCandidates(res.content, lim.a, lim.c, r) : null
      if (out && out.angles.length + out.capabilities.length > 0) cands = out
      else log(res ? 'reduce returned nothing — using grounded pool' : 'reduce refused by budget — using grounded pool')
    } catch (err) {
      log(`reduce failed: ${err instanceof Error ? err.message : err}`)
    }
  }
  cands = { angles: cands.angles.slice(0, lim.a), capabilities: cands.capabilities.slice(0, lim.c) }
  r.modelCalls = budget.calls
  r.modelFailures = budget.failures
  r.refused = budget.refused
  r.costUsd = budget.spentUsd
  opts.mutateCandidates?.(cands)

  // Final deterministic grounding check (no model).
  const fin = ground(cands, idx, r)
  r.dropped = { angles: fin.dA, capabilities: fin.dC }
  r.kept = { angles: fin.c.angles.length, capabilities: fin.c.capabilities.length }
  log(`calls ${r.modelCalls} $${r.costUsd.toFixed(4)}; final kept ${r.kept.angles}A/${r.kept.capabilities}C, dropped ${fin.dA}A/${fin.dC}C, notDone ${r.notDone}, billing ${r.billingDropped}`)

  const covered = r.windowsProcessed === all.length ? load.maxRowId : todo[r.windowsProcessed - 1].lastRowId
  if (r.kept.angles + r.kept.capabilities === 0) {
    bumpHwm(covered)
    return { ...r, status: 'nothing-survived' }
  }
  // Outbound HN queries are model output built from session text: scrub, then the same
  // deterministic gate research uses (project basename / cwd segments never leave the machine).
  // gapCheck([]) makes no fetch and returns its neutral "no queries" result.
  const sc = makeScrubber(projectDir)
  const privateTerms = privateSegments([opts.cwd, process.env.OSBORN_CWD, basename(projectDir)])
  for (const a of fin.c.angles) {
    const scrubbed = (a.queries ?? []).map(q => sc.scrub(String(q ?? '')).replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim()).filter(q => q.length >= 3)
    const queries = gateQueries(scrubbed, privateTerms)
    if ((a.queries ?? []).length > queries.length) log(`gap check "${a.title.slice(0, 60)}": ${(a.queries ?? []).length - queries.length} query(ies) held back by the outbound gate`)
    r.angles.push({ title: a.title, why: a.why, quotes: a.quotes as any, gap: await gapCheck(queries) })
  }
  r.capabilities = fin.c.capabilities.map(c => ({
    name: c.name, did: c.did, evidence: c.evidence as Evidence, proof: c.proof, quotes: c.quotes as any,
  }))

  const rec = findSessionRecording(opts.sessionId, projectDir)
  const align = rec ? alignRecording(rec, seen[0]?.timestamp) : null
  r.recording = align?.path ?? null

  const entry = formatEntry(r.angles, r.capabilities, {
    sessionId: opts.sessionId, source: 'recall-db', mode, model: info.id, records: seen.length,
    rowRange: [seen[0].id, seen[seen.length - 1].id], windows: r.windowsProcessed, windowsTotal: all.length,
    modelCalls: r.modelCalls, costUsd: r.costUsd, notDone: r.notDone, billingDropped: r.billingDropped, recording: align,
    noDenylist: !r.denylistLoaded,
    dropped: { angles: r.mapDropped.angles + r.dropped.angles, capabilities: r.mapDropped.capabilities + r.dropped.capabilities },
  })
  r.entry = redactor.redact(entry) // client redaction again on everything written
  r.outPath = opts.outPath ? writeScratch(opts.outPath, r.entry) : appendProfile(projectDir, r.entry)
  bumpHwm(covered)
  r.status = 'written'
  log(`wrote ${r.outPath}; hwm ${r.hwmBefore}→${r.hwmAfter}`)
  return r
}
