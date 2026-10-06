/**
 * lens-clip-window.ts — pass two (the clipper), step 1-2: pick the anchor rows
 * and pull the FULL surrounding stretch of conversation out of session.db.
 *
 * Pure + deterministic (no model): keyword-overlap topic heuristic. Starts from
 * anchors ± seedRows, grows outward one block at a time, alternating sides; a
 * block counts as on-topic when it shares enough weighted (idf) terms with the
 * seed's topic profile. Short off-topic detours are bridged (gapBlocks); a longer
 * one ends that side. Compaction seams and long silences (time gaps) are SOFT
 * limits: crossed only by a strongly on-topic block. Hard cap = maxTokens
 * (callers pass 25% of the model's context).
 */

import { recordView, estimateTokens, type DbRecord } from './lens-db.js'

export type StopReason = 'topic-shift' | 'soft-limit:compaction' | 'soft-limit:time-gap' | 'cap' | 'session-edge'

export interface ExpandOptions {
  seedRows?: number
  blockRows?: number
  /** Block score (0..1) at/above which a block is on-topic. */
  threshold?: number
  /** Mean score of the 2 blocks beyond a soft limit (compaction seam / time gap) needed to cross it. */
  strongThreshold?: number
  /** Off-topic blocks bridged before a side stops. */
  gapBlocks?: number
  maxTokens?: number
  /** Silence between adjacent rows treated as a soft limit. */
  softGapMs?: number
  /** content.ids of compaction seams (readCompactionBoundaries). */
  boundaries?: number[]
  /** Anchors within this many conversation rows of each other are merged. */
  mergeRows?: number
}

export interface ClipWindow {
  records: DbRecord[]
  firstRowId: number
  lastRowId: number
  estTokens: number
  anchors: number[]
  /** Anchor rows in other (far-away) clusters, not used for this window. */
  otherAnchors: number[]
  stop: { before: StopReason; after: StopReason }
  profile: string[]
  blocks: { side: 'before' | 'after'; firstRowId: number; lastRowId: number; score: number; kept: boolean }[]
}

const STOP = new Set(
  ('the and for that this with you your are was were have has had not but just like what when then them they there ' +
    'their about from into would could should will can its it\'s i\'m don\'t that\'s okay yeah yes so um uh know ' +
    'mean really actually basically right going gonna wanna want need let\'s lets thing things also well even still ' +
    'here more some only very much make made does did doing done been being which where while because since each ' +
    'other than over our out all any one two who how why way get got see say said sure think now back time ' +
    'kind sort something maybe stuff look looks good same work working').split(/\s+/),
)

/** Lower-cased content terms (3+ chars, no stopwords). Keeps tokens like x-forwarded-host, 1006, 0.9.153. */
export function terms(text: string): Set<string> {
  const out = new Set<string>()
  for (const m of text.toLowerCase().matchAll(/[a-z0-9][a-z0-9._'-]*[a-z0-9]/g)) {
    const t = m[0]
    if (t.length >= 3 && !STOP.has(t) && !/^\d{1,2}$/.test(t)) out.add(t)
  }
  return out
}

/** Merge anchor row ids into clusters of nearby conversation rows (by record index). */
export function clusterAnchors(records: DbRecord[], anchors: number[], mergeRows = 60): number[][] {
  const idxOf = (id: number) => {
    let i = records.findIndex(r => r.id >= id)
    if (i === -1) i = records.length - 1
    return i
  }
  const pts = [...new Set(anchors)].filter(n => Number.isFinite(n)).map(id => ({ id, i: idxOf(id) })).sort((a, b) => a.i - b.i)
  const clusters: { id: number; i: number }[][] = []
  for (const p of pts) {
    const last = clusters[clusters.length - 1]
    if (last && p.i - last[last.length - 1].i <= mergeRows) last.push(p)
    else clusters.push([p])
  }
  return clusters.map(c => c.map(p => p.id))
}

/** Soft limit between two adjacent records (earlier a, later b), or null. */
function softLimit(a: DbRecord, b: DbRecord, o: Required<ExpandOptions>): StopReason | null {
  if (o.boundaries.some(x => x > a.id && x <= b.id)) return 'soft-limit:compaction'
  const gap = Date.parse(b.timestamp) - Date.parse(a.timestamp)
  if (Number.isFinite(gap) && gap >= o.softGapMs) return 'soft-limit:time-gap'
  return null
}

export function expandWindow(records: DbRecord[], anchorIds: number[], opts: ExpandOptions = {}): ClipWindow | null {
  const o: Required<ExpandOptions> = {
    seedRows: 12, blockRows: 8, threshold: 0.1, strongThreshold: 0.1, gapBlocks: 4, maxTokens: 200_000,
    softGapMs: 3 * 3600_000, boundaries: [], mergeRows: 60, ...opts,
  }
  if (!records.length || !anchorIds.length) return null
  const clusters = clusterAnchors(records, anchorIds, o.mergeRows)
  const main = [...clusters].sort((a, b) => b.length - a.length)[0]
  const idx = main.map(id => Math.max(0, records.findIndex(r => r.id >= id))).map(i => (i === -1 ? records.length - 1 : i))
  let lo = Math.max(0, Math.min(...idx) - o.seedRows)
  let hi = Math.min(records.length - 1, Math.max(...idx) + o.seedRows)
  // Seed never crosses a soft limit away from the anchors.
  for (let i = Math.min(...idx); i > lo; i--) if (softLimit(records[i - 1], records[i], o)) { lo = i; break }
  for (let i = Math.max(...idx); i < hi; i++) if (softLimit(records[i], records[i + 1], o)) { hi = i; break }

  // Topic profile: seed terms weighted by session idf (rare-in-session terms weigh more).
  const df = new Map<string, number>()
  const termCache = records.map(r => terms(r.text))
  for (const ts of termCache) for (const t of ts) df.set(t, (df.get(t) ?? 0) + 1)
  const N = records.length
  const tf = new Map<string, number>()
  for (let i = lo; i <= hi; i++) for (const t of termCache[i]) tf.set(t, (tf.get(t) ?? 0) + 1)
  const weighted = [...tf]
    .map(([t, c]) => [t, (1 + Math.log(c)) * Math.log((N + 1) / (df.get(t) ?? 1))] as [string, number])
    .filter(([, w]) => w > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
  const profile = new Map(weighted)
  const total = weighted.reduce((a, [, w]) => a + w, 0) || 1
  const score = (from: number, to: number): number => {
    const seen = new Set<string>()
    for (let i = from; i <= to; i++) for (const t of termCache[i]) if (profile.has(t)) seen.add(t)
    let s = 0
    for (const t of seen) s += profile.get(t)!
    return s / total
  }
  const viewTok = records.map(r => estimateTokens(recordView(r).length + 2))
  let tokens = 0
  for (let i = lo; i <= hi; i++) tokens += viewTok[i]

  /** Far index of a block starting at `start` going `dir`, never spanning a soft limit. */
  const blockEnd = (start: number, dir: -1 | 1): number => {
    let end = start
    for (let k = 1; k < o.blockRows; k++) {
      const nx = end + dir
      if (nx < 0 || nx >= N) break
      const p = dir < 0 ? [records[nx], records[end]] : [records[end], records[nx]]
      if (softLimit(p[0], p[1], o)) break
      end = nx
    }
    return end
  }
  const blocks: ClipWindow['blocks'] = []
  type Side = { dir: -1 | 1; edge: number; pending: number; misses: number; done: StopReason | null }
  const sides: Side[] = [
    { dir: -1, edge: lo, pending: lo, misses: 0, done: null },
    { dir: 1, edge: hi, pending: hi, misses: 0, done: null },
  ]
  while (sides.some(s => !s.done)) {
    for (const s of sides) {
      if (s.done) continue
      const start = s.pending + s.dir
      if (start < 0 || start >= N) { s.done = 'session-edge'; continue }
      const pair = s.dir < 0 ? [records[start], records[s.pending]] : [records[s.pending], records[start]]
      const limit = softLimit(pair[0], pair[1], o)
      const end = blockEnd(start, s.dir)
      const [from, to] = s.dir < 0 ? [end, start] : [start, end]
      const sc = score(from, to)
      if (limit) {
        // Cross a seam/silence only if the story clearly continues: mean of this block and the next one beyond it.
        const nStart = end + s.dir
        let ahead = sc
        if (nStart >= 0 && nStart < N) {
          const nEnd = blockEnd(nStart, s.dir)
          ahead = (sc + (s.dir < 0 ? score(nEnd, nStart) : score(nStart, nEnd))) / 2
        }
        if (ahead < o.strongThreshold) { s.done = limit as StopReason; continue }
      }
      // Tokens of everything between the kept edge and this block's far end.
      let add = 0
      const [pf, pt] = s.dir < 0 ? [end, s.edge - 1] : [s.edge + 1, end]
      for (let i = pf; i <= pt; i++) add += viewTok[i]
      const on = sc >= o.threshold
      if (on && tokens + add > o.maxTokens) { s.done = 'cap'; continue }
      blocks.push({ side: s.dir < 0 ? 'before' : 'after', firstRowId: records[from].id, lastRowId: records[to].id, score: +sc.toFixed(3), kept: on })
      s.pending = end
      if (on) {
        tokens += add
        s.edge = end
        s.misses = 0
        if (s.dir < 0) lo = end
        else hi = end
      } else if (++s.misses > o.gapBlocks) s.done = 'topic-shift'
    }
  }
  // Bridged detours are kept only when a later block was accepted: mark trailing misses unkept.
  const recs = records.slice(lo, hi + 1)
  return {
    records: recs,
    firstRowId: recs[0].id,
    lastRowId: recs[recs.length - 1].id,
    estTokens: tokens,
    anchors: main,
    otherAnchors: clusters.filter(c => c !== main).flat(),
    stop: { before: sides[0].done!, after: sides[1].done! },
    profile: weighted.slice(0, 15).map(([t]) => t),
    blocks: blocks.map(b => ({ ...b, kept: b.firstRowId >= recs[0].id && b.lastRowId <= recs[recs.length - 1].id })),
  }
}

/** Compaction seams: moved to the period-owned lens-period-boundaries.ts (re-exported for the clipper). */
export { readCompactionBoundaries } from './lens-period-boundaries.js'

/** Row anchors from a lens output file: every `(row #N)` inside angles/capabilities whose title matches `query`. */
export function parseLensAnchors(md: string, query: string): { title: string; rows: number[] }[] {
  const q = query.toLowerCase().split(/\s+/).filter(Boolean)
  const items: { title: string; body: string[] }[] = []
  let cur: { title: string; body: string[] } | null = null
  for (const line of md.split('\n')) {
    const angle = line.match(/^####\s+(.+)$/)
    const cap = line.match(/^- \*\*(.+?)\*\*(?!:)/)
    if (angle || (cap && !/^(Why postable|Verified quotes|Gap evidence)/.test(cap[1]))) {
      cur = { title: (angle ? angle[1] : cap![1]).trim(), body: [] }
      items.push(cur)
    } else if (/^#{1,3}\s/.test(line)) cur = null
    else if (cur) cur.body.push(line)
  }
  return items
    .filter(it => q.every(w => it.title.toLowerCase().includes(w)))
    .map(it => ({ title: it.title, rows: [...it.body.join('\n').matchAll(/\(row #(\d+)\)/g)].map(m => Number(m[1])) }))
    .filter(it => it.rows.length)
}

/**
 * Multi-stretch: every anchor cluster expanded on its own (each gets an equal share
 * of maxTokens), overlapping windows merged, ordered chronologically. Used for
 * montage clips and the polished compilation (same session, different stretches).
 */
export function expandClusters(records: DbRecord[], anchorIds: number[], opts: ExpandOptions & { maxClusters?: number } = {}): ClipWindow[] {
  const clusters = clusterAnchors(records, anchorIds, opts.mergeRows ?? 60).slice(0, opts.maxClusters ?? 8)
  if (!clusters.length) return []
  const share = Math.floor((opts.maxTokens ?? 200_000) / clusters.length)
  const wins = clusters
    .map(c => expandWindow(records, c, { ...opts, maxTokens: share, mergeRows: Number.MAX_SAFE_INTEGER }))
    .filter((w): w is ClipWindow => !!w)
    .sort((a, b) => a.firstRowId - b.firstRowId)
  const out: ClipWindow[] = []
  for (const w of wins) {
    const last = out[out.length - 1]
    if (last && w.firstRowId <= last.lastRowId) {
      const ids = new Set(last.records.map(r => r.id))
      const recs = [...last.records, ...w.records.filter(r => !ids.has(r.id))].sort((a, b) => a.id - b.id)
      out[out.length - 1] = {
        ...last,
        records: recs,
        lastRowId: recs[recs.length - 1].id,
        estTokens: recs.reduce((s, r) => s + estimateTokens(recordView(r).length + 2), 0),
        anchors: [...last.anchors, ...w.anchors],
        stop: { before: last.stop.before, after: w.stop.after },
        blocks: [...last.blocks, ...w.blocks],
      }
    } else out.push(w)
  }
  return out.map(w => ({ ...w, otherAnchors: [] }))
}
