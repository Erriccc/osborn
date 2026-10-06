/**
 * lens-quotes.ts — the DETERMINISTIC anti-hallucination guard (no model).
 *
 * Every quote the model returns must be an exact (whitespace-normalized)
 * substring of a sanitized session.db conversation row carrying the SAME
 * timestamp (rows the model actually saw). Items (angles or capabilities) with
 * any unverifiable quote are dropped wholesale. The speaker and row id written
 * to disk are taken from the matched row, never from the model.
 */

export interface Quote {
  text: string
  timestamp: string
  speaker: 'user' | 'assistant'
  /** session.db content.id of the row the quote was verified against. */
  row: number
  /** The model cited a slightly wrong timestamp; `timestamp` is the source row's. */
  tsCorrected?: boolean
}

/** Anything row-shaped: DbRecord from lens-db.ts (id = content.id). */
export interface QuotableRecord {
  id?: number
  text: string
  timestamp: string
  speaker: 'user' | 'assistant'
}

const MIN_QUOTE_CHARS = 12
const MAX_QUOTE_CHARS = 400

export const normalizeWs = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** Strip wrapping quote marks the model may add; nothing else is altered. */
function unwrapQuote(s: string): string {
  return s.trim().replace(/^["“”'`]+/, '').replace(/["“”'`]+$/, '').trim()
}

export type RecordIndex = Map<string, string[]>

type IndexEntry = { text: string; loose: string; speaker: Quote['speaker']; row: number; ts: string; ms: number }

/**
 * Formatting-only normalization applied identically to quote AND row: markdown
 * emphasis/code marks, typographic quotes/ellipsis, whitespace, letter case. Words, digits and
 * punctuation that carry meaning are untouched, so this is still a substring check.
 */
export const looseText = (s: string): string =>
  normalizeWs(
    s
      .replace(/\*\*|__|`+/g, '')
      .replace(/(^|[\s(])\*(?=\S)|(?<=\S)\*(?=[\s).,;:!?]|$)/g, '$1')
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/…/g, '...'),
  ).toLowerCase()

/** A cited timestamp may slip (neighbouring row, one digit); beyond this it's a different moment. */
export const TS_TOLERANCE_MS = 3 * 60 * 60_000

/** timestamp → rows carrying it (normalized + loose text, row id, parsed time). */
export function buildRecordIndex(records: QuotableRecord[]): Map<string, IndexEntry[]> {
  const idx = new Map<string, IndexEntry[]>()
  for (const r of records) {
    const list = idx.get(r.timestamp) ?? []
    const text = normalizeWs(r.text)
    list.push({ text, loose: looseText(text), speaker: r.speaker, row: r.id ?? 0, ts: r.timestamp, ms: Date.parse(r.timestamp) })
    idx.set(r.timestamp, list)
  }
  return idx
}

export type QuoteIndex = ReturnType<typeof buildRecordIndex>

/**
 * Verified quote or null. Pure + deterministic. The quote text must be a
 * substring (whitespace/markdown-normalized) of a SOURCE row. Exact timestamp
 * match is preferred; otherwise the nearest row containing the text is accepted
 * only if the cited timestamp is within TS_TOLERANCE_MS, or the cited row id is
 * that row. The timestamp, speaker and row written out are ALWAYS the source
 * row's, never the model's (tsCorrected marks a fixed citation).
 */
export function verifyQuote(q: { text?: unknown; timestamp?: unknown; row?: unknown }, idx: QuoteIndex): Quote | null {
  if (typeof q?.text !== 'string' || typeof q?.timestamp !== 'string') return null
  const text = normalizeWs(unwrapQuote(q.text))
  if (text.length < MIN_QUOTE_CHARS || text.length > MAX_QUOTE_CHARS) return null
  const loose = looseText(text)
  if (loose.length < MIN_QUOTE_CHARS) return null
  const ts = q.timestamp.trim()
  const hint = Number(String(q.row ?? '').replace(/^#/, ''))
  const hit = (c: IndexEntry) => c.text.includes(text) || c.loose.includes(loose)
  const exact = (idx.get(ts) ?? []).filter(hit).sort((a, b) => Number(b.row === hint) - Number(a.row === hint))
  if (exact.length) return { text, timestamp: exact[0].ts, speaker: exact[0].speaker, row: exact[0].row }
  const cited = Date.parse(ts)
  let best: IndexEntry | null = null
  let bestDiff = Infinity
  for (const list of idx.values()) {
    for (const c of list) {
      if (!hit(c)) continue
      const diff = c.row === hint ? 0 : Number.isFinite(cited) && Number.isFinite(c.ms) ? Math.abs(c.ms - cited) : Infinity
      if (diff < bestDiff) {
        best = c
        bestDiff = diff
      }
    }
  }
  if (!best || bestDiff > TS_TOLERANCE_MS) return null
  return { text, timestamp: best.ts, speaker: best.speaker, row: best.row, tsCorrected: true }
}

/** Why a quote failed (debug only; same rules as verifyQuote). */
export function explainQuote(q: { text?: unknown; timestamp?: unknown; row?: unknown }, idx: QuoteIndex): string {
  if (verifyQuote(q, idx)) return 'ok'
  if (typeof q?.text !== 'string' || typeof q?.timestamp !== 'string') return 'malformed'
  const text = normalizeWs(unwrapQuote(q.text))
  if (text.length < MIN_QUOTE_CHARS || text.length > MAX_QUOTE_CHARS) return `length ${text.length}`
  const cands = idx.get(q.timestamp.trim())
  if (!cands) {
    for (const [ts, list] of idx) if (list.some(c => c.text.includes(text))) return `wrong-timestamp (text is in ${ts})`
    return 'unknown-timestamp, text not found anywhere'
  }
  for (const [ts, list] of idx) if (ts !== q.timestamp && list.some(c => c.text.includes(text))) return `text belongs to ${ts}`
  return 'timestamp ok, text not a substring (paraphrased/edited)'
}

/**
 * Keep items whose quotes ALL verify (1..maxQuotes required). Returns the kept
 * items with verified quotes substituted, plus the drop count.
 */
export function verifyItems<T extends { quotes: unknown[] }>(
  items: T[],
  idx: QuoteIndex,
  maxQuotes = 3,
): { kept: (Omit<T, 'quotes'> & { quotes: Quote[] })[]; dropped: number } {
  const kept: (Omit<T, 'quotes'> & { quotes: Quote[] })[] = []
  let dropped = 0
  for (const it of items) {
    const qs = Array.isArray(it.quotes) ? it.quotes.slice(0, maxQuotes) : []
    const verified = qs.map(q => verifyQuote(q as any, idx))
    if (qs.length === 0 || verified.some(v => v === null)) {
      dropped++
      continue
    }
    kept.push({ ...it, quotes: verified as Quote[] })
  }
  return { kept, dropped }
}

/** Tolerant JSON-object parse: accepts fences or leading prose. */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
  if (!raw) return null
  const s = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const o = JSON.parse(s.slice(start, end + 1))
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null
  } catch {
    return null
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

export interface RawAngle {
  title: string
  why: string
  quotes: unknown[]
  queries: string[]
}
export type Evidence = 'shipped' | 'root-caused'
export interface RawCapability {
  name: string
  did: string
  /** Normalized evidence type; '' when the model gave none / something else (= not done). */
  evidence: Evidence | ''
  proof: string
  quotes: unknown[]
}

/** Done-vs-planned gate: only shipped/verified or proven-root-cause items count. */
export function normalizeEvidence(v: unknown): Evidence | '' {
  const s = str(v).toLowerCase().replace(/[\s_]+/g, '-')
  if (s === 'shipped' || s === 'verified' || s === 'done') return 'shipped'
  if (s === 'root-caused' || s === 'rootcaused' || s === 'root-cause') return 'root-caused'
  return ''
}

export function splitByEvidence(caps: RawCapability[]): { done: RawCapability[]; notDone: number } {
  const done = caps.filter(c => c.evidence !== '')
  return { done, notDone: caps.length - done.length }
}

export function readAngles(v: unknown, max: number): RawAngle[] {
  if (!Array.isArray(v)) return []
  const out: RawAngle[] = []
  for (const o of v as any[]) {
    const title = str(o?.title)
    if (!title) continue
    const queries = Array.isArray(o?.queries) ? o.queries.map(str).filter(Boolean).slice(0, 2) : []
    out.push({ title, why: str(o?.why), quotes: Array.isArray(o?.quotes) ? o.quotes : [], queries })
    if (out.length >= max) break
  }
  return out
}

export function readCapabilities(v: unknown, max: number): RawCapability[] {
  if (!Array.isArray(v)) return []
  const out: RawCapability[] = []
  for (const o of v as any[]) {
    const name = str(o?.name)
    if (!name) continue
    out.push({
      name,
      did: str(o?.did),
      evidence: normalizeEvidence(o?.evidence),
      proof: str(o?.proof),
      quotes: Array.isArray(o?.quotes) ? o.quotes : [],
    })
    if (out.length >= max) break
  }
  return out
}
