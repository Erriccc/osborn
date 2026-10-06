/**
 * lens-clip.ts — PASS TWO, "the clipper". Pass one (compaction-lens) finds
 * moments with demand evidence; pass two works like a streamer clipping a
 * highlight out of a very long livestream (one session.db):
 *   1. take the moment (anchor rows; or a demand thread → search; or a topic),
 *   2. pull the FULL surrounding stretch(es) from session.db (lens-clip-window),
 *   3. understand what really happened — a human arc carried by the user's own
 *      verified lines (lens-clip-arc),
 *   4. cut it into formats, truth-check + redact (lens-clip-formats).
 *
 * Modes: forward (anchors → clip; several anchor clusters → a short montage),
 * reverse (demand thread → search → clip + reply comment, or "no genuine matching
 * experience"), compilation (the polished edit: many stretches of the SAME
 * session → one episode, noise cut and listed).
 * OpenRouter only. Hard cost cap: $0.50 per clip run, $1.00 for a compilation.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { loadConversationRows, recordView, resolveSessionDb, type DbRecord } from './lens-db.js'
import { Budget, chat, getModelInfo, windowTokensFor, type ModelInfo } from './lens-model.js'
import { loadClientRedactor } from './lens-redact.js'
import { redactSecrets } from './transcript-sanitizer.js'
import { expandClusters, parseLensAnchors, readCompactionBoundaries, type ClipWindow } from './lens-clip-window.js'
import { arcPrompt, readArc, type Arc } from './lens-clip-arc.js'
import { checkFormats, formatsPrompt, formatTexts, parseStringArray, readFormats, truthCheckPrompt, type Formats } from './lens-clip-formats.js'
import { fetchThread, queriesPrompt, readQueries, searchSession, type SearchResult } from './lens-clip-search.js'
import { renderClipMd } from './lens-clip-render.js'

export type ClipMode = 'forward' | 'reverse' | 'compilation'

export interface ClipOptions {
  sessionId: string
  mode: ClipMode
  anchors?: number[]
  lensFile?: string
  /** Angle/capability title queries matched against lensFile. */
  lensQueries?: string[]
  threadUrl?: string
  threadText?: string
  topic?: string
  outPath: string
  log?: (m: string) => void
}

export interface ClipReport {
  mode: ClipMode
  sessionId: string
  model: string
  anchors: number[]
  anchorSources: string[]
  windows: { label: string; firstRowId: number; lastRowId: number; rows: number; estTokens: number; from: string; to: string; stop: ClipWindow['stop'] }[]
  search?: { problem: string; queries: string[]; result: Omit<SearchResult, 'clusters'> & { top: SearchResult['clusters'] } }
  thread?: { url?: string; title: string }
  arc: Arc | null
  formats: Formats | null
  truth: Record<string, string[] | null>
  noGenuineMatch: string | null
  calls: number
  costUsd: number
  capUsd: number
  errors: string[]
}

class ClipBudget extends Budget {
  constructor(info: ModelInfo, cap: number) {
    super(info, { maxCostUsd: cap, maxCalls: 16 })
  }
}

const label = (i: number) => String.fromCharCode(65 + i)

export async function runClip(o: ClipOptions): Promise<ClipReport> {
  const log = o.log ?? (() => {})
  const key = process.env.OPENROUTER_API_KEY
  if (!key) throw new Error('OPENROUTER_API_KEY not set')
  const db = resolveSessionDb(o.sessionId)
  if (!db) throw new Error(`no session.db for ${o.sessionId}`)
  const projectDir = dirname(dirname(dirname(db)))
  const info = await getModelInfo(key)
  if (!info) throw new Error('model info unavailable (cannot enforce the cost cap)')
  const capUsd = o.mode === 'compilation' ? 1.0 : 0.5
  const budget = new ClipBudget(info, capUsd)
  const red = loadClientRedactor(projectDir)
  const records = loadConversationRows(db, 0, red.redact).records
  const boundaries = readCompactionBoundaries(db)
  const r: ClipReport = {
    mode: o.mode, sessionId: o.sessionId, model: info.id, anchors: [], anchorSources: [], windows: [], arc: null, formats: null,
    truth: {}, noGenuineMatch: null, calls: 0, costUsd: 0, capUsd, errors: [],
  }
  const ask = async (prompt: string, maxOut: number, what: string): Promise<string | null> => {
    try {
      const res = await chat(budget, prompt, key, maxOut)
      if (!res) { r.errors.push(`${what}: refused by cost cap`); return null }
      log(`${what}: ${res.promptTokens}+${res.completionTokens} tok, $${res.costUsd.toFixed(4)}, finish=${res.finish}`)
      if (res.finish === 'length') r.errors.push(`${what}: output cap hit (may be truncated)`)
      return res.content
    } catch (e: any) {
      r.errors.push(`${what}: ${e?.message ?? e}`)
      return null
    }
  }
  const finish = (): ClipReport => {
    r.calls = budget.calls
    r.costUsd = +budget.spentUsd.toFixed(4)
    const md = redactSecrets(red.redact(renderClipMd(r)), { assistant: true })
    mkdirSync(dirname(o.outPath), { recursive: true })
    writeFileSync(o.outPath, md, 'utf-8')
    log(`wrote ${o.outPath}`)
    return r
  }

  // 1. anchors
  let anchors = [...(o.anchors ?? [])]
  if (o.anchors?.length) r.anchorSources.push(`rows ${o.anchors.join(', ')}`)
  if (o.lensFile && o.lensQueries?.length) {
    const md = readFileSync(o.lensFile, 'utf-8')
    for (const q of o.lensQueries) {
      const items = parseLensAnchors(md, q)
      if (!items.length) r.errors.push(`lens item not found: "${q}"`)
      for (const it of items) {
        anchors.push(...it.rows)
        r.anchorSources.push(`"${it.title}" → rows ${it.rows.join(', ')}`)
      }
    }
  }
  let thread = o.threadText ?? ''
  if (o.threadUrl && !thread) {
    try {
      const t = await fetchThread(o.threadUrl)
      thread = t.text
      r.thread = { url: o.threadUrl, title: t.title }
    } catch (e: any) {
      r.errors.push(`thread fetch failed: ${e?.message ?? e}`)
    }
  } else if (thread) r.thread = { url: o.threadUrl, title: thread.split('\n')[0].slice(0, 120) }
  const searchMaterial = o.mode === 'reverse' ? thread : o.mode === 'compilation' && !anchors.length ? o.topic ?? '' : ''
  if (o.mode === 'reverse' && !thread) throw new Error('reverse mode needs --thread <url> or --thread-text <file>')
  if (searchMaterial) {
    const qraw = await ask(queriesPrompt(searchMaterial, o.mode === 'reverse' ? 'thread' : 'topic'), 1_000, 'queries')
    const q = qraw ? readQueries(qraw) : null
    if (!q) return (r.errors.push('could not derive search queries'), finish())
    const res = await searchSession(db, records, q.queries)
    r.search = { problem: q.problem, queries: q.queries, result: { mode: res.mode, weak: res.weak, weakWhy: res.weakWhy, top: res.clusters.slice(0, 6) } }
    if (res.weak) return ((r.noGenuineMatch = `weak search match: ${res.weakWhy}`), finish())
    const best = res.clusters[0]
    const picked = o.mode === 'compilation' ? res.clusters.filter(c => c.score >= best.score * 0.25).slice(0, 6) : [best]
    for (const c of picked) {
      anchors.push(...c.rows)
      r.anchorSources.push(`search cluster rows #${c.rows[0]}–#${c.rows[c.rows.length - 1]} (score ${c.score}, ${c.hits} hits, queries: ${c.queries.join(' | ')})`)
    }
  }
  anchors = [...new Set(anchors)].sort((a, b) => a - b)
  r.anchors = anchors
  if (!anchors.length) return (r.errors.push('no anchor rows'), finish())

  // 2. windows
  const wins = expandClusters(records, anchors, {
    boundaries, maxTokens: windowTokensFor(info), mergeRows: o.mode === 'compilation' ? 40 : 60,
    maxClusters: o.mode === 'compilation' ? 6 : 4,
  })
  const labelled = wins.map((w, i) => ({ label: label(i), records: w.records }))
  r.windows = wins.map((w, i) => ({
    label: label(i), firstRowId: w.firstRowId, lastRowId: w.lastRowId, rows: w.records.length, estTokens: w.estTokens,
    from: w.records[0].timestamp, to: w.records[w.records.length - 1].timestamp, stop: w.stop,
  }))
  const allRecs: DbRecord[] = wins.flatMap(w => w.records)
  const clipOf = (row: number) => r.windows.find(w => row >= w.firstRowId && row <= w.lastRowId)?.label
  log(`windows: ${r.windows.map(w => `${w.label} #${w.firstRowId}–#${w.lastRowId} (${w.rows} rows, ~${w.estTokens} tok)`).join('; ')}`)

  // 3. arc
  const arcMode = o.mode === 'compilation' ? 'compilation' : 'single'
  const araw = await ask(arcPrompt(labelled, { mode: arcMode, thread: o.mode === 'reverse' ? thread : undefined, topic: o.topic }), 8_000, 'arc')
  r.arc = araw ? readArc(araw, allRecs, clipOf) : null
  if (!r.arc) return (r.errors.push('arc: no parseable arc'), finish())
  if (o.mode === 'reverse') {
    const solving = r.arc.beats.filter(b => /turning|fix|payoff/.test(b.beat)).some(b => b.userLines.length + b.supportLines.length > 0)
    if (r.arc.genuine && !r.arc.genuine.answers) r.noGenuineMatch = `model: ${r.arc.genuine.why || 'does not answer the thread'}`
    else if (!solving) r.noGenuineMatch = 'no verified user/assistant line in the turning-point/fix/payoff beats'
    if (r.noGenuineMatch) return finish()
  }

  // 4. formats + deterministic checks
  const fraw = await ask(formatsPrompt(labelled, r.arc, { mode: arcMode, thread: o.mode === 'reverse' ? thread : undefined }), o.mode === 'compilation' ? 14_000 : 9_000, 'formats')
  r.formats = fraw ? readFormats(fraw) : null
  if (!r.formats) return (r.errors.push('formats: no parseable output'), finish())
  const sourceText = allRecs.map(recordView).join('\n\n')
  r.formats.flags = checkFormats(r.formats, r.arc, sourceText)

  // 5. truth-check every format (flag, never block)
  for (const [name, text] of formatTexts(r.formats)) {
    const raw = await ask(truthCheckPrompt(sourceText, text), 3_000, `truth-check ${name}`)
    r.truth[name] = raw ? parseStringArray(raw) : null
  }
  return finish()
}
