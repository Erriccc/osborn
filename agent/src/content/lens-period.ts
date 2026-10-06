/**
 * lens-period.ts — the PERIOD MAP: one model call over one raw block
 * (lens-period-block.ts) → what this stretch of work was, as a map.
 *
 * Sections: high_leverage (ranked first), period_goal, arc, what_worked,
 * stories (with the user's own verbatim lines at the turning points), angles
 * (each with the demand question it answers) and anchors (row ranges per story,
 * for a later clip/library step).
 *
 * Every quote is verified DETERMINISTICALLY with lens-quotes against the block's
 * rows; the speaker/row/timestamp written out are the matched row's. A failing
 * quote is dropped (and logged with the reason); an item left with no verified
 * quote is dropped. Story lines must be the user's own words (not pasted text).
 */

import { recordView, type DbRecord } from './lens-db.js'
import { buildRecordIndex, explainQuote, parseJsonObject, verifyQuote, type Quote, type QuoteIndex } from './lens-quotes.js'
import { isPastedSpan } from './lens-clip-arc.js'
import { clipOffset, type RecordingAlignment } from './lens-audio.js'

export type LeverageEvidence = 'shipped' | 'root-caused' | 'decided'
export interface HighLeverage { title: string; why: string; evidence: LeverageEvidence; quotes: Quote[] }
export interface ArcStep { step: string; what: string; why: string; quotes: Quote[] }
export interface WorkedItem { name: string; kind: string; why: string; quotes: Quote[] }
export interface TurningPoint { moment: string; userLines: Quote[] }
export interface Story { title: string; whyItMatters: string; turningPoints: TurningPoint[]; from: number; to: number }
export interface Angle { title: string; demandQuestion: string; story: string; quotes: Quote[] }
export interface Anchor {
  story: string
  from: number
  to: number
  rows: number
  fromTs: string
  toTs: string
  /** Only when an AudioAdapter (lens-audio.ts) found a recording; transcript-only runs keep row ranges. */
  audio?: { path: string; start: string | null; end: string | null; approximate: boolean }
}
export interface QuoteDrop { section: string; item: string; text: string; row: string; reason: string }

export interface PeriodMap {
  highLeverage: HighLeverage[]
  periodGoal: { text: string; quotes: Quote[] } | null
  arc: ArcStep[]
  whatWorked: { heldUp: WorkedItem[]; didnt: WorkedItem[] }
  stories: Story[]
  angles: Angle[]
  anchors: Anchor[]
  drops: QuoteDrop[]
  quotesKept: number
  itemsDropped: string[]
}

const QUOTE_RULES =
  'QUOTES: every "quotes"/"user_lines" entry = {"row": the record\'s row number from its [#row | timestamp | speaker] header ' +
  '(digits only), "text": an exact verbatim substring (12-300 chars) copied character-for-character from THAT ONE record}. ' +
  'ONE contiguous span: no ellipses, no skipped words, no merged sentences, no typo or grammar fixes — the person speaks by ' +
  'voice, keep their disfluencies exactly. Never quote secrets, keys, tokens, emails, or personal details; keep masked tags ' +
  'like [client] exactly as written.'

const SHAPE =
  '{"high_leverage": [{"title", "why": one line — why it is high-leverage, "evidence": "shipped"|"root-caused"|"decided", "quotes": [1-3]}],\n' +
  ' "period_goal": {"text": 1-2 sentences, "quotes": [1-3]},\n' +
  ' "arc": [{"step": "tried"|"failed"|"pivot"|"worked"|"outcome", "what": one line, "why": one line (why it failed / why it worked / what changed), "quotes": [1-2]}],\n' +
  ' "what_worked": {"held_up": [{"name", "kind": "tool"|"model"|"approach", "why", "quotes": [1-2]}], "didnt": [same shape]},\n' +
  ' "stories": [{"title", "why_it_matters": one line, "from_row": first row of the story, "to_row": last row, ' +
  '"turning_points": [{"moment": one line, "user_lines": [1-2 USER quotes]}]}],\n' +
  ' "angles": [{"title", "demand_question": the question a real person is asking that this would answer, "story": story title or "", "quotes": [1-2]}]}'

/** Transcript FIRST, instructions AFTER (measured on minimax-m3: the task gets lost otherwise). */
export function periodPrompt(blockText: string, meta: { from: string; to: string; rows: number }): string {
  return [
    `Below is ONE raw, unedited, chronological stretch (${meta.rows} records, ${meta.from} to ${meta.to}) of a long voice work ` +
      'session between a person (user) and their AI coding assistant (assistant). Conversation only — tool calls are not shown. ' +
      'Read all of it, beginning to end; your task follows after the transcript.',
    '<transcript>',
    blockText,
    '</transcript>',
    'TASK: map this whole period. Do not summarise record by record — understand what the stretch of work was about and how ' +
      'it unfolded, then fill every section:\n' +
      '- high_leverage (0-6, strongest first): the high-value work of the period — something that unblocked a lot, saved real ' +
      'money or time, a fix that took a whole class of problems off the table, a reusable technique others could use, or a ' +
      'decision that changed direction. "evidence": shipped (built and shown working), root-caused (cause found/proven), ' +
      'decided (a direction-changing decision the person made).\n' +
      '- period_goal: what this stretch of work was about overall.\n' +
      '- arc (4-12 steps, in order): what was tried, what failed and why, the pivots, what finally worked, and the outcome.\n' +
      '- what_worked: tools, models and approaches that held up, and ones that did not (with why).\n' +
      '- stories (1-6): self-contained sub-stories inside the period. Each with a title, why it matters, its row range, and the ' +
      'PERSON\'s own verbatim lines (user records, their spoken words — not pasted logs/reviews) at the turning points.\n' +
      '- angles (1-6): postable angles, each with the demand question it would answer.\n' +
      'Keep masked tags like [client]; never reintroduce client names, IDs or amounts. No personal invoicing/money-owed items.',
    QUOTE_RULES,
    `Output ONLY one JSON object: ${SHAPE}`,
  ].join('\n\n')
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '')
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : [])

export function normalizeLeverage(v: unknown): LeverageEvidence | '' {
  const s = str(v).toLowerCase().replace(/[\s_]+/g, '-')
  if (s === 'shipped' || s === 'verified' || s === 'done') return 'shipped'
  if (s === 'root-caused' || s === 'root-cause' || s === 'rootcaused') return 'root-caused'
  if (s === 'decided' || s === 'decision') return 'decided'
  return ''
}

class Verifier {
  idx: QuoteIndex
  byId: Map<number, DbRecord>
  ids: number[]
  drops: QuoteDrop[] = []
  kept = 0
  constructor(records: DbRecord[]) {
    this.idx = buildRecordIndex(records)
    this.byId = new Map(records.map(r => [r.id, r]))
    this.ids = records.map(r => r.id)
  }
  /** Timestamp of the cited row (or the nearest row id) so lens-quotes can verify by row + time. */
  private tsFor(row: number): string {
    const r = this.byId.get(row)
    if (r) return r.timestamp
    let best = this.ids[0]
    for (const id of this.ids) if (Math.abs(id - row) < Math.abs(best - row)) best = id
    return this.byId.get(best)?.timestamp ?? ''
  }
  quotes(raw: unknown, section: string, item: string, max: number, userOnly = false): Quote[] {
    const out: Quote[] = []
    const seen = new Set<string>()
    for (const q of arr(raw).slice(0, max)) {
      const row = Number(str(q?.row).replace(/^#/, ''))
      const cand = { text: q?.text, row, timestamp: Number.isFinite(row) ? this.tsFor(row) : '' }
      const v = verifyQuote(cand, this.idx)
      const drop = (reason: string) => this.drops.push({ section, item, text: str(q?.text).slice(0, 160), row: str(q?.row), reason })
      if (!v) { drop(explainQuote(cand, this.idx)); continue }
      if (userOnly && (v.speaker !== 'user' || isPastedSpan(this.byId.get(v.row)?.text ?? '', v.text))) {
        drop(v.speaker !== 'user' ? 'not a user line' : 'pasted text, not the user\'s own words')
        continue
      }
      const key = `${v.row}:${v.text}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(v)
    }
    this.kept += out.length
    return out
  }
}

/** Parse + verify the model's map against the block rows. Null when the JSON is unusable. */
export function readPeriodMap(raw: string, records: DbRecord[]): PeriodMap | null {
  const o = parseJsonObject(raw)
  if (!o) return null
  const V = new Verifier(records)
  const itemsDropped: string[] = []
  const keep = <T extends { quotes: Quote[] }>(section: string, label: string, it: T): T | null => {
    if (it.quotes.length) return it
    itemsDropped.push(`${section}: ${label}`)
    return null
  }
  const hl = arr(o.high_leverage).slice(0, 6).map(h => {
    const title = str(h?.title)
    const evidence = normalizeLeverage(h?.evidence)
    if (!title) return null
    if (!evidence) { itemsDropped.push(`high_leverage: ${title} (evidence "${str(h?.evidence)}" not shipped/root-caused/decided)`); return null }
    return keep('high_leverage', title, { title, why: str(h?.why), evidence, quotes: V.quotes(h?.quotes, 'high_leverage', title, 3) })
  })
  const pg = o.period_goal as any
  const goalText = str(pg?.text) || str(pg)
  const goal = goalText ? keep('period_goal', 'goal', { text: goalText, quotes: V.quotes(pg?.quotes, 'period_goal', 'goal', 3) }) : null
  const arc = arr(o.arc).slice(0, 14).map((s, i) => {
    const what = str(s?.what)
    if (!what) return null
    return keep('arc', `${i + 1}. ${what}`, { step: str(s?.step) || 'step', what, why: str(s?.why), quotes: V.quotes(s?.quotes, 'arc', what, 2) })
  })
  const worked = (v: unknown, sec: string) => arr(v).slice(0, 8).map(w => {
    const name = str(w?.name)
    if (!name) return null
    return keep(sec, name, { name, kind: str(w?.kind), why: str(w?.why), quotes: V.quotes(w?.quotes, sec, name, 2) })
  }).filter((x): x is WorkedItem => !!x)
  const ww = (o.what_worked ?? {}) as any
  const blockFirst = records[0]?.id ?? 0
  const blockLast = records[records.length - 1]?.id ?? 0
  const clamp = (n: number) => Math.min(blockLast, Math.max(blockFirst, n))
  const stories: Story[] = []
  for (const s of arr(o.stories).slice(0, 6)) {
    const title = str(s?.title)
    if (!title) continue
    const tps = arr(s?.turning_points).slice(0, 5).map(tp => ({ moment: str(tp?.moment), userLines: V.quotes(tp?.user_lines, 'stories', title, 2, true) }))
      .filter(tp => tp.userLines.length)
    if (!tps.length) { itemsDropped.push(`stories: ${title} (no verified user line)`); continue }
    const rows = tps.flatMap(tp => tp.userLines.map(q => q.row))
    const f = Number(str(s?.from_row).replace(/^#/, ''))
    const t = Number(str(s?.to_row).replace(/^#/, ''))
    // Anchor range = the model's range clamped to the block, always covering every verified line.
    const from = Math.min(Number.isFinite(f) && f > 0 ? clamp(f) : Infinity, ...rows)
    const to = Math.max(Number.isFinite(t) && t > 0 ? clamp(t) : -Infinity, ...rows)
    stories.push({ title, whyItMatters: str(s?.why_it_matters), turningPoints: tps, from, to })
  }
  const angles = arr(o.angles).slice(0, 6).map(a => {
    const title = str(a?.title)
    if (!title) return null
    return keep('angles', title, { title, demandQuestion: str(a?.demand_question), story: str(a?.story), quotes: V.quotes(a?.quotes, 'angles', title, 2) })
  })
  const anchors = stories.map(s => {
    const inRange = records.filter(r => r.id >= s.from && r.id <= s.to)
    return { story: s.title, from: s.from, to: s.to, rows: inRange.length, fromTs: inRange[0]?.timestamp ?? '', toTs: inRange[inRange.length - 1]?.timestamp ?? '' }
  })
  const nn = <T>(xs: (T | null)[]): T[] => xs.filter((x): x is T => !!x)
  return {
    highLeverage: nn(hl), periodGoal: goal, arc: nn(arc), whatWorked: { heldUp: worked(ww.held_up, 'what_worked.held_up'), didnt: worked(ww.didnt, 'what_worked.didnt') },
    stories, angles: nn(angles), anchors, drops: V.drops, quotesKept: V.kept, itemsDropped,
  }
}

/** Optional audio step: attach clip offsets to anchors when a recording alignment exists; no-op otherwise. */
export function attachAudio(map: PeriodMap, align: RecordingAlignment | null): PeriodMap {
  if (!align) return map
  for (const a of map.anchors) {
    a.audio = { path: align.path, start: a.fromTs ? clipOffset(a.fromTs, align.startIso) : null, end: a.toTs ? clipOffset(a.toTs, align.startIso) : null, approximate: align.approximate }
  }
  return map
}

/** Plain-text view of the block for debugging/tests. */
export const blockView = (records: DbRecord[]): string => records.map(recordView).join('\n\n')
