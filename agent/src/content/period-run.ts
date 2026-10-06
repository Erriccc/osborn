/**
 * period-run.ts — run the PERIOD MAP for one session. Stages (each its own module,
 * swappable / rerunnable alone):
 *   1. block loader   lens-db.loadConversationRows + lens-period-block.selectBlock
 *   2. strip/redact   lens-strip (inside loadConversationRows) + secret/client redaction
 *   3. period map     lens-period (one OpenRouter call, quotes verified deterministically)
 *   4. audio (opt.)   lens-audio AudioAdapter — offsets only when a recording exists
 *   5. render         lens-period-render → review .md (redacted again)
 * OpenRouter only. Hard cap: 1 call, $0.50. Never writes content-profile.md or the HWM.
 *
 * CLI: npx tsx agent/src/content/period-run.ts --session <id> --out <file.md>
 *        [--since 24h|ISO] [--until ISO] [--from-row N] [--dry]
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadConversationRows, resolveSessionDb } from './lens-db.js'
import { Budget, chat, getModelInfo, windowTokensFor } from './lens-model.js'
import { loadClientRedactor } from './lens-redact.js'
import { redactSecrets } from './transcript-sanitizer.js'
import { readCompactionBoundaries } from './lens-period-boundaries.js'
import { localRecordingAdapter, type AudioAdapter } from './lens-audio.js'
import { refuseOutPath } from './lens-paths.js'
import { parseSince, selectBlock } from './lens-period-block.js'
import { attachAudio, periodPrompt, readPeriodMap } from './lens-period.js'
import { renderPeriodMd, type PeriodRunReport } from './lens-period-render.js'

export const PERIOD_CAP_USD = 0.5
const MAX_OUT = 12_000

export interface PeriodOptions {
  sessionId: string
  outPath: string
  since?: string
  until?: string
  fromRowId?: number
  /** Inclusive end row (with fromRowId) — the library step's closed period. */
  toRowId?: number
  /** Block stats only — no model call. */
  dry?: boolean
  audio?: AudioAdapter
  log?: (m: string) => void
}

export async function runPeriodMap(o: PeriodOptions): Promise<PeriodRunReport> {
  const log = o.log ?? (() => {})
  const db = resolveSessionDb(o.sessionId)
  if (!db) throw new Error(`no session.db for ${o.sessionId}`)
  const projectDir = dirname(dirname(dirname(db)))
  const refused = refuseOutPath(o.outPath, projectDir)
  if (refused) throw new Error(refused)
  const key = process.env.OPENROUTER_API_KEY
  if (!key && !o.dry) throw new Error('OPENROUTER_API_KEY not set')
  const info = await getModelInfo(key ?? '')
  if (!info) throw new Error('model info unavailable (cannot enforce the cost cap)')
  const capTokens = windowTokensFor(info)
  const red = loadClientRedactor(projectDir)

  // 1+2. block loader (strip + sanitize + secret/client redaction happen inside the load)
  const all = loadConversationRows(db, 0, red.redact)
  const sinceMs = o.since ? parseSince(o.since) : undefined
  const untilMs = o.until ? parseSince(o.until) : undefined
  if (sinceMs !== undefined && !Number.isFinite(sinceMs)) throw new Error(`bad --since ${o.since}`)
  if (untilMs !== undefined && !Number.isFinite(untilMs)) throw new Error(`bad --until ${o.until}`)
  const block = selectBlock(all.records, { boundaries: readCompactionBoundaries(db), fromRowId: o.fromRowId, toRowId: o.toRowId, sinceMs, untilMs, maxTokens: capTokens })
  // Strip counts for exactly the block's row range (incl. rows dropped inside it).
  const scoped = block ? loadConversationRows(db, block.firstRowId - 1, red.redact, block.lastRowId) : null
  const { records: _r, text: _t, ...blockMeta } = block ?? ({} as any)
  const r: PeriodRunReport = {
    sessionId: o.sessionId, model: info.id, contextLength: info.contextLength, capTokens,
    block: block ? blockMeta : null, stripped: scoped?.stats.stripped ?? {}, rowsRead: scoped?.stats.rowsRead ?? 0,
    rowsKeptInSession: scoped?.records.length ?? 0, map: null, calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0,
    capUsd: PERIOD_CAP_USD, finish: '', provider: '', audio: 'none (transcript only — row ranges, no clip offsets)', errors: [],
  }
  const finish = (): PeriodRunReport => {
    const md = redactSecrets(red.redact(renderPeriodMd(r)), { assistant: true })
    mkdirSync(dirname(o.outPath), { recursive: true })
    writeFileSync(o.outPath, md, 'utf-8')
    log(`wrote ${o.outPath}`)
    return r
  }
  if (!block) return (r.errors.push('empty block'), finish())
  log(`block ${block.basis}: rows #${block.firstRowId}–#${block.lastRowId} (${block.records.length}), ~${block.estTokens} tok${block.leftOut ? `, left out ${block.leftOut.rows} rows` : ''}`)
  if (o.dry) return finish()

  // 3. period map — ONE call, reasoning off (lens-model.chat), instructions after the transcript
  const budget = new Budget(info, { maxCalls: 1, maxCostUsd: PERIOD_CAP_USD })
  const prompt = periodPrompt(block.text, { from: block.from, to: block.to, rows: block.records.length })
  try {
    const res = await chat(budget, prompt, key!, MAX_OUT)
    if (!res) r.errors.push('refused by the cost cap')
    else {
      Object.assign(r, { promptTokens: res.promptTokens, completionTokens: res.completionTokens, finish: res.finish, provider: res.provider })
      log(`map: ${res.promptTokens}+${res.completionTokens} tok, $${res.costUsd.toFixed(4)}, finish=${res.finish}`)
      if (res.finish === 'length') r.errors.push('output cap hit (JSON may be truncated)')
      r.map = readPeriodMap(res.content, block.records)
      if (!r.map) {
        // Keep the (redacted) raw reply next to the review file for debugging.
        const rawPath = o.outPath.replace(/\.md$/, '') + '.raw.txt'
        writeFileSync(rawPath, redactSecrets(red.redact(res.content), { assistant: true }), 'utf-8')
        r.errors.push(`no parseable period map (raw reply: ${rawPath})`)
      }
    }
  } catch (e: any) {
    r.errors.push(`model call failed: ${e?.message ?? e}`)
  }
  r.calls = budget.calls
  r.costUsd = +budget.spentUsd.toFixed(4)

  // 4. optional audio adapter
  const align = (o.audio ?? localRecordingAdapter).align(o.sessionId, projectDir, block.from)
  if (align) r.audio = `${align.path} (${align.approximate ? 'approximate' : 'exact'} start: ${align.basis})`
  if (r.map) attachAudio(r.map, align)
  return finish()
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? process.argv[i + 1] : undefined
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const sessionId = arg('session') ?? ''
  const outPath = arg('out') ?? ''
  const fromRow = arg('from-row')
  runPeriodMap({
    sessionId, outPath, since: arg('since'), until: arg('until'),
    fromRowId: fromRow ? Number(fromRow) : undefined, dry: process.argv.includes('--dry'),
    log: m => console.log(m),
  })
    .then(r => {
      const m = r.map
      console.log(JSON.stringify({
        block: r.block && { rows: r.block.periodRows - (r.block.leftOut?.rows ?? 0), estTokens: r.block.estTokens, leftOut: r.block.leftOut },
        stripped: r.stripped, cost: r.costUsd, calls: r.calls, errors: r.errors,
        map: m && { highLeverage: m.highLeverage.length, arc: m.arc.length, stories: m.stories.length, angles: m.angles.length, quotesKept: m.quotesKept, quoteDrops: m.drops.length, itemsDropped: m.itemsDropped.length },
      }, null, 2))
    })
    .catch(e => {
      console.error(`period map failed: ${e?.message ?? e}`)
      process.exitCode = 1
    })
}
