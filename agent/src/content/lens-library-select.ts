/**
 * lens-library-select.ts — which PERIOD a compaction just ended. Pure + deterministic.
 *
 * A period runs from one compaction seam (lens-period-boundaries) to the row
 * before the next seam. Seams come in clusters (several re-compactions within
 * minutes), so short periods are merged FORWARD: walking the seams in order, a
 * group only closes at a seam once it spans >= minSpanMs of conversation. The
 * walk depends only on earlier rows, so a later seam never re-numbers an earlier
 * group. That makes the group's OPENING boundary row (startRowId) a stable key:
 * the same period always gets the same key, index and file name.
 *
 * Timing: the worker runs at PostCompact, usually BEFORE the recall store has
 * ingested the seam this compaction will produce. So the db's TAIL (last seam →
 * last row) is the period that just ended; it is treated as closed by "this
 * compaction" when it spans >= minSpanMs, else it is deferred (merged into the
 * next one). If the new seam is already ingested, the tail is tiny and the last
 * seam-closed group is the one that just ended.
 */

export const DEFAULT_MIN_SPAN_MS = 4 * 3_600_000

export interface RowStamp {
  id: number
  timestamp: string
}

export interface LibraryPeriod {
  /** 1-based position in the session's period sequence (stable). */
  index: number
  /** Opening boundary row (or the session's first row for period 1) — the idempotency key. */
  startRowId: number
  /** Inclusive last row. */
  endRowId: number
  /** Seam row that closed it; null = the tail, closed by the compaction that triggered this run. */
  closedBy: number | null
  /** Conversation rows in the period. */
  rows: number
  fromTs: string
  toTs: string
  spanMs: number
}

export interface Segmentation {
  closed: LibraryPeriod[]
  tail: LibraryPeriod | null
}

function span(recs: RowStamp[]): number {
  if (recs.length < 2) return 0
  const a = Date.parse(recs[0].timestamp)
  const b = Date.parse(recs[recs.length - 1].timestamp)
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, b - a) : 0
}

function period(index: number, start: number, end: number, closedBy: number | null, recs: RowStamp[]): LibraryPeriod {
  return {
    index, startRowId: start, endRowId: end, closedBy, rows: recs.length,
    fromTs: recs[0]?.timestamp ?? '', toTs: recs[recs.length - 1]?.timestamp ?? '', spanMs: span(recs),
  }
}

/** Split records (ascending id) into greedy forward-merged periods at the given seams. */
export function segmentPeriods(records: RowStamp[], boundaries: number[], minSpanMs = DEFAULT_MIN_SPAN_MS): Segmentation {
  if (!records.length) return { closed: [], tail: null }
  const firstId = records[0].id
  const lastId = records[records.length - 1].id
  const seams = [...new Set(boundaries)].filter(b => b > firstId && b <= lastId).sort((a, b) => a - b)
  const closed: LibraryPeriod[] = []
  let start = firstId
  let i = 0 // first record index of the current group
  for (const s of seams) {
    let j = i
    while (j < records.length && records[j].id < s) j++
    const group = records.slice(i, j)
    if (span(group) >= minSpanMs) {
      closed.push(period(closed.length + 1, start, s - 1, s, group))
      start = s
      i = j
    }
  }
  const tailRecs = records.slice(i)
  return { closed, tail: tailRecs.length ? period(closed.length + 1, start, lastId, null, tailRecs) : null }
}

export type PickResult =
  | { period: LibraryPeriod; reason: 'tail' | 'last-closed' }
  | { period: null; reason: 'no-rows' | 'deferred' | 'already-written' }

/**
 * The newest period not yet written, among (1) the tail when it is long enough
 * and (2) the last seam-closed group. At most one per run; older gaps are left to
 * a manual backfill so a compaction never triggers surprise spend.
 */
export function pickLibraryPeriod(seg: Segmentation, isDone: (startRowId: number) => boolean, minSpanMs = DEFAULT_MIN_SPAN_MS): PickResult {
  if (!seg.tail && !seg.closed.length) return { period: null, reason: 'no-rows' }
  const tailReady = !!seg.tail && seg.tail.spanMs >= minSpanMs
  if (tailReady && !isDone(seg.tail!.startRowId)) return { period: seg.tail!, reason: 'tail' }
  const last = seg.closed[seg.closed.length - 1]
  if (last && !isDone(last.startRowId)) return { period: last, reason: 'last-closed' }
  return { period: null, reason: tailReady || !seg.tail ? 'already-written' : 'deferred' }
}

/** <YYYY-MM-DD of the period start>-period-<NN>.md — same scheme as the manual backfill. */
export function pageFileName(p: Pick<LibraryPeriod, 'index' | 'fromTs'>): string {
  const day = /^\d{4}-\d{2}-\d{2}/.test(p.fromTs) ? p.fromTs.slice(0, 10) : 'undated'
  return `${day}-period-${String(p.index).padStart(2, '0')}.md`
}
