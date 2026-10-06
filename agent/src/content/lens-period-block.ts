/**
 * lens-period-block.ts — the PERIOD MAP's input: ONE raw, sequential block of
 * conversation (no sweep of small windows, no summaries). Pure + deterministic.
 *
 * Default block = everything since the most recent compaction boundary of the
 * session (the compaction trigger; boundaries from lens-period-boundaries'
 * readCompactionBoundaries — the boundary row itself is kept, minus its stripped
 * <session_tail> replay, because the user's words that followed the compaction
 * live in it). Alternatively a time range (--since / --until).
 *
 * Cap = maxTokens (callers pass 25% of the model's live context length). When the
 * block is larger, the MOST RECENT rows that fit are kept and the left-out
 * stretch is reported.
 *
 * Records arrive already stripped of injected context (lens-strip.ts),
 * sanitized and secret + client redacted (lens-db.ts loadConversationRows).
 */

import { estimateTokens, recordView, type DbRecord } from './lens-db.js'

export interface BlockOptions {
  /** content.ids of compaction seams, ascending. */
  boundaries: number[]
  /** Explicit start row (inclusive); overrides the boundary default. */
  fromRowId?: number
  /** Explicit end row (inclusive); only applies together with fromRowId. */
  toRowId?: number
  /** Time range (ms epoch); when set, overrides the boundary default. */
  sinceMs?: number
  untilMs?: number
  maxTokens: number
}

export interface PeriodBlock {
  records: DbRecord[]
  text: string
  chars: number
  estTokens: number
  firstRowId: number
  lastRowId: number
  from: string
  to: string
  /** How the start was chosen. */
  basis: string
  /** Rows in the selected period that did not fit the cap (oldest end), or null. */
  leftOut: { rows: number; estTokens: number; firstRowId: number; lastRowId: number; from: string; to: string } | null
  /** Rows in the period before capping. */
  periodRows: number
}

/**
 * Start row for the default block: the most recent compaction seam at or before
 * the last loaded record (seams past the end of `records` are ignored), or null
 * when there is none. The seam is returned however few rows follow it — there is
 * no minimum-rows fallback to an earlier seam.
 */
export function lastBoundaryStart(records: DbRecord[], boundaries: number[]): number | null {
  const lastId = records.length ? records[records.length - 1].id : 0
  const seams = boundaries.filter(b => b <= lastId).sort((a, b) => a - b)
  return seams.length ? seams[seams.length - 1] : null
}

/** "24h", "90m", "2d", or an ISO timestamp → ms epoch (relative to now). NaN when unparseable. */
export function parseSince(v: string, now = Date.now()): number {
  const m = v.trim().match(/^(\d+(?:\.\d+)?)\s*(m|h|d)$/i)
  if (m) return now - Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2].toLowerCase() as 'm' | 'h' | 'd']
  return Date.parse(v)
}

export function selectBlock(all: DbRecord[], o: BlockOptions): PeriodBlock | null {
  let period: DbRecord[]
  let basis: string
  if (o.sinceMs !== undefined || o.untilMs !== undefined) {
    const lo = o.sinceMs ?? -Infinity
    const hi = o.untilMs ?? Infinity
    period = all.filter(r => {
      const t = Date.parse(r.timestamp)
      return t >= lo && t <= hi
    })
    basis = `time range ${Number.isFinite(lo) ? new Date(lo).toISOString() : 'start'} → ${Number.isFinite(hi) ? new Date(hi).toISOString() : 'now'}`
  } else if (o.fromRowId !== undefined) {
    const to = o.toRowId ?? Infinity
    period = all.filter(r => r.id >= o.fromRowId! && r.id <= to)
    basis = Number.isFinite(to) ? `rows #${o.fromRowId}–#${to}` : `from row #${o.fromRowId}`
  } else {
    const start = lastBoundaryStart(all, o.boundaries)
    period = start === null ? all : all.filter(r => r.id >= start)
    basis = start === null ? 'whole session (no compaction boundary found)' : `since the last compaction boundary (row #${start})`
  }
  if (!period.length) return null
  const views = period.map(recordView)
  const maxChars = o.maxTokens * 4
  // Walk back from the newest row; keep what fits.
  let used = 0
  let firstKept = period.length
  for (let i = period.length - 1; i >= 0; i--) {
    const c = views[i].length + 2
    if (used + c > maxChars && firstKept < period.length) break
    used += c
    firstKept = i
  }
  const kept = period.slice(firstKept)
  const dropped = period.slice(0, firstKept)
  const text = views.slice(firstKept).join('\n\n')
  const droppedChars = views.slice(0, firstKept).reduce((s, v) => s + v.length + 2, 0)
  return {
    records: kept,
    text,
    chars: text.length,
    estTokens: estimateTokens(text.length),
    firstRowId: kept[0].id,
    lastRowId: kept[kept.length - 1].id,
    from: kept[0].timestamp,
    to: kept[kept.length - 1].timestamp,
    basis,
    periodRows: period.length,
    leftOut: dropped.length
      ? {
          rows: dropped.length,
          estTokens: estimateTokens(droppedChars),
          firstRowId: dropped[0].id,
          lastRowId: dropped[dropped.length - 1].id,
          from: dropped[0].timestamp,
          to: dropped[dropped.length - 1].timestamp,
        }
      : null,
  }
}
