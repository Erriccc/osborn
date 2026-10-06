/**
 * content-script.ts — Stage A script generation: one script per brief.
 * A period yields at most 1 highlight (61-90s narrated timeline) + up to 3
 * how-tos (~150s "if you're in this situation…"); content-run enforces the count.
 *
 * Writing rules and per-tier beats come ONLY from content-script-rules.ts
 * (SCRIPT_RULES / TIER_TEMPLATES), so they can be replaced without touching
 * this logic. Dev-voice lines must be verbatim user rows: the model is shown
 * row-tagged rows and must cite the row; content-checks.ts verifies every dev
 * line deterministically before anything else runs. Throws CapError / Error.
 */

import { recordView, type DbRecord } from './lens-db.js'
import { llmJson, type ContentLlmOptions } from './content-llm.js'
import { FORMAT_CATALOG, SCRIPT_RULES, TIER_TEMPLATES, WORDS_PER_SECOND, type Tier } from './content-script-rules.js'
import type { Brief } from './content-brief.js'

export type Speaker = 'narrator' | 'dev' | 'agent'
export interface ScriptLine {
  speaker: Speaker
  text: string
  /** Source row (required for dev lines). */
  row?: number
}
export interface Script {
  id: string
  tier: Tier
  title: string
  hook: string
  lines: ScriptLine[]
  /** Model-declared distinct causes (faults/catches needing their own fix) — gated by content-checks. */
  causes: string[]
  /** Model-declared load-bearing terms — gated per minute by content-checks. */
  terms: string[]
  words: number
  estSeconds: number
}

const ROWS_MAX_CHARS = 40_000
const PAGE_MAX_CHARS = 40_000
const MAX_LINES = 60

export const countWords = (s: string): number => (s.match(/[A-Za-z0-9][A-Za-z0-9'’.-]*/g) ?? []).length
export const estimateSeconds = (lines: Pick<ScriptLine, 'text'>[]): number =>
  Number((lines.reduce((n, l) => n + countWords(l.text), 0) / WORDS_PER_SECOND).toFixed(1))
export function tierBounds(tier: Tier): { min: number; max: number; target: number } {
  const t = TIER_TEMPLATES[tier]
  return { min: t.minS, max: t.maxS, target: t.targetS }
}
export function lengthCheck(s: Pick<Script, 'tier' | 'lines'>): { ok: boolean; seconds: number; min: number; max: number } {
  const b = tierBounds(s.tier)
  const seconds = estimateSeconds(s.lines)
  return { ok: seconds >= b.min && seconds <= b.max, seconds, min: b.min, max: b.max }
}

/** Row-tagged session rows for the brief's range (widened to the whole period when thin), capped. */
export function rowsForBrief(records: DbRecord[], brief: Pick<Brief, 'fromRow' | 'toRow'>): DbRecord[] {
  let rows = records.filter(r => r.id >= brief.fromRow && r.id <= brief.toRow)
  if (rows.filter(r => r.speaker === 'user').length < 4) rows = records
  const out: DbRecord[] = []
  let used = 0
  // Keep the range's start in view: walk forward, stop at the cap.
  for (const r of rows) {
    const c = recordView(r).length + 2
    if (used + c > ROWS_MAX_CHARS && out.length) break
    used += c
    out.push(r)
  }
  return out
}

export const SCRIPT_SYSTEM =
  'You write the spoken script for a developer\'s own short vertical video, made from their real work session with an AI coding agent. ' +
  'You never invent facts. Developer lines are copied verbatim from the user rows given. Reply with ONE JSON object only.'

export function scriptPrompt(brief: Brief, page: string, rows: DbRecord[], researchText: string): string {
  const t = TIER_TEMPLATES[brief.tier]
  const fmt = FORMAT_CATALOG.find(f => f.id === brief.format)
  return [
    '<period_page>',
    page.length > PAGE_MAX_CHARS ? page.slice(0, PAGE_MAX_CHARS) : page,
    '</period_page>',
    '<session_rows> (header = [#row | timestamp | speaker]; dev lines may ONLY copy from rows whose speaker is "user")',
    rows.map(recordView).join('\n\n'),
    '</session_rows>',
    '<research> (what people actually hit; cite nothing, just speak to it)',
    researchText || '(none)',
    '</research>',
    `BRIEF:\n- Viewer: ${brief.viewer}\n- They are living through: ${brief.situation}\n- Angle: ${brief.angle}\n- Problems to speak to: ${brief.problems.join(' | ') || '(none)'}\n` +
      (brief.stake ? `- STAKE (show it): ${brief.stake.quantity}: BEFORE ${brief.stake.before} -> AFTER ${brief.stake.after}\n` : '') +
      `- Built on: "${brief.story}" (rows ${brief.fromRow}-${brief.toRow})\n- Format: ${fmt ? `${fmt.name} — beats: ${fmt.beats}` : brief.format}` +
      (brief.owner ? `\n- Developer (owns the video): ${brief.owner.name}${brief.owner.handle ? ` (${brief.owner.handle})` : ''}` : '\n- Developer name unknown: no name in the sign-off'),
    `TIER: ${t.label}. ${t.promise}\nBeats:\n${t.beats.map((b, i) => `${i + 1}. ${b}`).join('\n')}\n` +
      `BUDGET: ${t.budget}\nLENGTH: ${t.words.min}-${t.words.max} spoken words in total (hard limit ${t.minS}-${t.maxS}s at ${WORDS_PER_SECOND} words/s). Dev lines: ${t.devLines.min}-${t.devLines.max}.`,
    `RULES:\n${SCRIPT_RULES.map(r => `- ${r}`).join('\n')}`,
    'Output ONLY: {"title": "<= 80 chars", "hook": "one line", "lines": [{"speaker": "narrator"|"dev"|"agent", "text": "...", "row": <row number, dev lines only>}], ' +
      '"causes": [each distinct cause (fault or catch needing its own fix) the script tells, one short phrase each], ' +
      '"terms": [each load-bearing term the viewer must understand, as written]}',
  ].join('\n\n')
}

const SPEAKER: Record<string, Speaker> = {
  dev: 'dev', developer: 'dev', user: 'dev', agent: 'agent', assistant: 'agent', ai: 'agent', narrator: 'narrator', narr: 'narrator',
}

/** Tolerant parse of the model's reply into a Script. Never throws. */
export function normalizeScript(raw: unknown, brief: Pick<Brief, 'id' | 'tier'>): Script {
  const j: any = raw && typeof raw === 'object' ? raw : {}
  const src: any = Array.isArray(j.lines) ? j : j.script && typeof j.script === 'object' ? j.script : j
  const lines: ScriptLine[] = []
  for (const l of Array.isArray(src.lines) ? src.lines.slice(0, MAX_LINES) : []) {
    const who = String(l?.speaker ?? l?.voice ?? l?.who ?? 'narrator').toLowerCase().trim()
    const text = String(l?.text ?? l?.say ?? l?.line ?? '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    const speaker = SPEAKER[who] ?? 'narrator'
    const rowN = Math.floor(Number(String(l?.row ?? l?.source_row ?? '').replace(/^#/, '')))
    lines.push({ speaker, text, ...(Number.isFinite(rowN) && rowN > 0 ? { row: rowN } : {}) })
  }
  const list = (v: unknown) => (Array.isArray(v) ? v : []).map(x => String(typeof x === 'object' && x ? ((x as any).text ?? (x as any).term ?? (x as any).cause ?? '') : x).replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 30)
  const clip = (s: unknown, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
  return {
    id: brief.id, tier: brief.tier, title: clip(src.title, 120), hook: clip(src.hook, 280), lines,
    causes: list(src.causes ?? j.causes), terms: list(src.terms ?? j.terms),
    words: lines.reduce((n, l) => n + countWords(l.text), 0), estSeconds: estimateSeconds(lines),
  }
}

/** Generate one script. One model call. */
export async function writeScript(brief: Brief, page: string, records: DbRecord[], researchText: string, llm: ContentLlmOptions): Promise<{ script: Script; costUsd: number }> {
  const rows = rowsForBrief(records, brief)
  const maxOut = brief.tier === 'howto' ? 3000 : 1800
  const r = await llmJson(llm, { what: `script ${brief.id}`, system: SCRIPT_SYSTEM, user: scriptPrompt(brief, page, rows, researchText), maxOut, temperature: 0.4 })
  return { script: normalizeScript(r.json, brief), costUsd: r.costUsd }
}

const LABEL: Record<Speaker, string> = { narrator: 'NARRATOR', dev: 'DEVELOPER (verbatim)', agent: 'AGENT' }

/** Plain transcript (one line per spoken line) — the ingest `transcript` field. */
export const scriptTranscript = (s: Script): string => s.lines.map(l => `${LABEL[l.speaker]}: ${l.text}`).join('\n')
