/**
 * content-checks.ts — Stage A gates. A HARD flag ⇒ the piece is "blocked":
 * never ingested, never auto-fixed (content-run records the flags).
 * HARD always: dev-voice pre-pass, truth-check, length below the tier min or
 * more than +15% over the tier max, an empty script.
 * ADVISORY by default (warnings → the draft's quality_flags; still ingested):
 * the structure gate (stake / "no visible proof", causes, terms/min, spoken
 * versions/codes), up to +15% over the tier max, and the audience check.
 * OSBORN_CONTENT_STRICT=1 makes every advisory warning a hard flag again.
 *
 * Order (cheapest first; a failing stage skips the paid ones after it):
 *   1. length      deterministic: estimated seconds within the tier bounds.
 *   2. dev-voice   deterministic pre-pass (rules §7): every dev line must be a
 *                  substring of ONE user row of the period. Ellipsis cuts ("…" / "...")
 *                  are allowed only if every piece is ≥12 chars, the pieces occur in
 *                  order in that row, and they cover ≥80% of the row span they were
 *                  cut from (so a cut can't flip the meaning). Records the row id.
 *                  Also caps dev lines per tier (a highlight is not a quote chain).
 *   3. truth-check LLM, PINNED: deepseek/deepseek-chat on deepinfra/fp4 with
 *                  allow_fallbacks:false (as videos-test-3/vt3-render.ts); the served
 *                  provider must be DeepInfra. Cached by sha256(draft+sources+prompt+model+provider).
 *   4. audience    LLM (same pin): rules §4 — every quote/term familiar to the viewer or set up nearby.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DbRecord } from './lens-db.js'
import { CHECK_MODEL, CHECK_PROVIDER, CHECK_PROVIDER_NAME, isContentStrict, llmJson, type ContentLlmOptions } from './content-llm.js'
import { writeAtomic, type CheckSummary } from './content-manifest.js'
import { AUDIENCE_RULES, TIER_TEMPLATES, scriptLimits, type ScriptLimits } from './content-script-rules.js'
import { lengthCheck, type Script, type ScriptLine } from './content-script.js'
import type { Brief } from './content-brief.js'

export const CHECK_CACHE_DIR = '.content-check-cache'
export const MIN_PIECE_CHARS = 12
export const MIN_CUT_COVERAGE = 0.8
/** Non-strict: a script may run up to this fraction over the tier max (flagged, not blocked). */
export const OVER_LENGTH_TOLERANCE = 0.15
export const NO_PROOF_FLAG = 'no visible proof: brief has no before -> after stake quantity (rule 1: stake and proof both visible)'

/** Whitespace + typographic quote/dash normalisation only (never wording). */
export const normText = (s: string): string =>
  String(s ?? '')
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()

const ELLIPSIS = /\s*(?:…|\.\.\.)\s*/
const stripWrapQuotes = (s: string) => s.replace(/^["'\s]+|["'\s]+$/g, '')

/** Pieces of a dev line split at ellipsis cuts (leading/trailing cuts allowed). */
export const devPieces = (text: string): string[] => normText(text).split(ELLIPSIS).map(stripWrapQuotes).filter(Boolean)

/** Match pieces in order inside `row`. Returns the covered span ratio, or null when not all found. */
export function matchInRow(row: string, pieces: string[]): number | null {
  const hay = normText(row)
  let at = 0
  let first = -1
  let end = 0
  for (const p of pieces) {
    const k = hay.indexOf(p, at)
    if (k < 0) return null
    if (first < 0) first = k
    at = k + p.length
    end = at
  }
  const kept = pieces.reduce((n, p) => n + p.length, 0)
  return end > first ? kept / (end - first) : 1
}

export interface PrepassResult {
  ok: boolean
  flags: string[]
  rows: { line: number; row: number; match: string }[]
}

/** Deterministic dev-voice pre-pass. `rows` = the period's records (only user rows are eligible). */
export function devVoicePrepass(lines: ScriptLine[], rows: DbRecord[], tier?: Script['tier']): PrepassResult {
  const users = rows.filter(r => r.speaker === 'user')
  const res: PrepassResult = { ok: true, flags: [], rows: [] }
  let devCount = 0
  lines.forEach((l, i) => {
    if (l.speaker !== 'dev') return
    devCount++
    const n = i + 1
    const pieces = devPieces(l.text)
    if (!pieces.length) return void res.flags.push(`dev line ${n}: empty`)
    const short = pieces.find(p => p.length < MIN_PIECE_CHARS)
    if (short) return void res.flags.push(`dev line ${n}: piece "${short}" is under ${MIN_PIECE_CHARS} chars`)
    // The cited row first, then every other user row.
    const order = [...users.filter(r => r.id === l.row), ...users.filter(r => r.id !== l.row)]
    let best: { row: number; cov: number } | null = null
    for (const r of order) {
      const cov = matchInRow(r.text, pieces)
      if (cov === null) continue
      if (pieces.length === 1 || cov >= MIN_CUT_COVERAGE) {
        best = { row: r.id, cov }
        break
      }
      if (!best || cov > best.cov) best = { row: r.id, cov }
    }
    if (!best) return void res.flags.push(`dev line ${n}: not verbatim in any user row of the period`)
    if (pieces.length > 1 && best.cov < MIN_CUT_COVERAGE) {
      return void res.flags.push(`dev line ${n}: ellipsis cuts keep ${(best.cov * 100).toFixed(0)}% of row #${best.row} span (< ${MIN_CUT_COVERAGE * 100}%)`)
    }
    res.rows.push({ line: n, row: best.row, match: pieces.length > 1 ? `ellipsis ${(best.cov * 100).toFixed(0)}%` : 'substring' })
  })
  if (tier && devCount > TIER_TEMPLATES[tier].devLines.max) res.flags.push(`${devCount} dev lines > ${TIER_TEMPLATES[tier].devLines.max} allowed for ${tier} (not a quote chain)`)
  res.ok = res.flags.length === 0
  return res
}

const TAG: Record<ScriptLine['speaker'], string> = {
  dev: '[DEVELOPER, verbatim user line; … marks elided words]',
  agent: '[AGENT]',
  narrator: '[NARRATOR]',
}
export const draftText = (s: Script): string =>
  `ON-SCREEN TITLE: ${s.title}\nHOOK: ${s.hook}\n\nNARRATION (one line per caption):\n` + s.lines.map((l, i) => `${i + 1}. ${TAG[l.speaker]} ${l.text}`).join('\n')

/** pipeline-e2e LEG 5 / vt3-render.ts truth-check prompt, unchanged. */
export const TRUTH_SYSTEM =
  'You are a strict fact-checking editor. You are given a DRAFT post and the SOURCE records (the ONLY ' +
  'ground truth). Identify every factual claim, event, metric, or specific detail in the draft that is ' +
  'NOT directly supported by the source records. Treat invented stories, numbers, or named mechanisms as ' +
  'unsupported. Do NOT rewrite or soften the post. Return ONLY a JSON array of strings — each string one ' +
  'specific ungrounded claim (quote or tight paraphrase from the draft). If every claim is grounded, return [].'
export const truthUser = (sources: string, draft: string) =>
  `SOURCE RECORDS (ground truth, speaker-tagged):\n${sources}\n\nDRAFT POST:\n${draft}\n\nList the ungrounded claims as a JSON array of strings.`

export const AUDIENCE_SYSTEM =
  'You are an editor checking a short developer video script for ONE target viewer. Reply with ONE JSON object only.'
export const audienceUser = (brief: Pick<Brief, 'viewer' | 'situation'>, draft: string) =>
  `${AUDIENCE_RULES}\n\nTARGET VIEWER: ${brief.viewer}\nTHEY ARE LIVING THROUGH: ${brief.situation}\n\nSCRIPT:\n${draft}\n\n` +
  'List each quote or term that lands with no context for this viewer. Output ONLY: {"flags": [{"item": quote or term, "why": one line}]} — [] when every one passes.'

/** Flags from any reply shape: ["..."], {flags:[...]}, [{claim|item|text}], … */
export function flagsFrom(json: unknown): string[] {
  let arr: unknown = json
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const o = json as Record<string, unknown>
    arr = [o.flags, o.unsupported, o.issues, o.claims, o.unfamiliar].find(Array.isArray) ?? []
  }
  if (!Array.isArray(arr)) return []
  return arr
    .map(x => (typeof x === 'string' ? x : x && typeof x === 'object' ? [(x as any).claim ?? (x as any).item ?? (x as any).text ?? (x as any).term ?? '', (x as any).why ?? (x as any).reason ?? ''].filter(Boolean).join(' — ') : ''))
    .map(s => String(s).replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 20)
}

/** Spoken software versions / error codes (WHAT-WORKS rule 4). Starting patterns; dev lines are exempt (verbatim). */
export const VERSION_CODE_PATTERNS: RegExp[] = [
  /\b\d+\.\d+\.\d+\b/, // 0.9.73
  /\bv\d+(?:\.\d+)+\b/i, // v2.1
  /\bversion\s+\d+(?:\.\d+)*\b/i, // version 186
  /\b(?:HTTP|status|error|exit|code)\s*(?:code\s*)?\d{3,5}\b/i, // HTTP 502, error 1006, exit code 137
  /\b\d{3,5}\s+(?:error|status code)\b/i, // 404 error
  /\b(?:ws|websocket)\s+\d{4}\b/i, // WS 1006
  /\bE[A-Z]{4,}\b/, // ENOENT, EADDRINUSE, ECONNRESET
]

export interface StructureResult {
  ok: boolean
  flags: string[]
  causes: number
  termsPerMin: number
}

/** WHAT-WORKS deterministic gate, run on the script BEFORE any LLM judge. Thresholds: scriptLimits() (env-tunable). */
export function structureCheck(s: Script, brief: Pick<Brief, 'stake'>, limits: ScriptLimits = scriptLimits()): StructureResult {
  const flags: string[] = []
  if (!brief.stake) flags.push(NO_PROOF_FLAG)
  const seconds = lengthCheck(s).seconds
  const causes = s.causes.length
  const maxC = limits.maxCauses[s.tier]
  if (causes === 0) flags.push('script declares no cause')
  else {
    if (causes > maxC) flags.push(`${causes} causes > ${maxC} allowed for ${s.tier}`)
    if (seconds / causes < limits.secondsPerCause) flags.push(`${(seconds / causes).toFixed(0)}s per cause < ${limits.secondsPerCause}s (${causes} causes in ~${seconds.toFixed(0)}s)`)
  }
  const termsPerMin = seconds > 0 ? Number((s.terms.length / (seconds / 60)).toFixed(2)) : 0
  if (termsPerMin > limits.maxTermsPerMin[s.tier]) flags.push(`${termsPerMin} load-bearing terms/min > ${limits.maxTermsPerMin[s.tier]} (${s.terms.length} terms)`)
  const spoken = [{ n: 0, text: s.title }, { n: 0, text: s.hook }, ...s.lines.map((l, i) => ({ n: i + 1, text: l.speaker === 'dev' ? '' : l.text }))]
  for (const { n, text } of spoken) {
    const re = VERSION_CODE_PATTERNS.find(p => p.test(text))
    if (re) flags.push(`${n ? `line ${n}` : 'title/hook'}: spoken version or error code ("${text.match(re)![0]}")`)
  }
  return { ok: flags.length === 0, flags, causes, termsPerMin }
}

export interface CheckContext {
  projectDir: string | null
  llm: ContentLlmOptions
  /** The period's records (session.db, redacted) — dev lines are matched against the user rows. */
  records: DbRecord[]
  /** Truth-check ground truth: library page + cited rows + research digest (already scrubbed). */
  sources: string
}

function cachePath(projectDir: string | null, key: string): string | null {
  return projectDir ? join(projectDir, CHECK_CACHE_DIR, `${key}.json`) : null
}

/** Pinned LLM judge with a content-addressed cache. Throws CapError / Error. */
async function pinnedJudge(kind: 'truth' | 'audience', system: string, user: string, ctx: CheckContext): Promise<{ flags: string[]; provider: string; cacheKey: string; cached: boolean }> {
  const key = createHash('sha256').update(JSON.stringify({ kind, system, user, model: CHECK_MODEL, provider: CHECK_PROVIDER })).digest('hex')
  const p = cachePath(ctx.projectDir, key)
  if (p) {
    try {
      const c = JSON.parse(readFileSync(p, 'utf-8'))
      if (c?.key === key && Array.isArray(c.flags)) return { flags: c.flags, provider: String(c.provider), cacheKey: key, cached: true }
    } catch {
      /* miss */
    }
  }
  const r = await llmJson(ctx.llm, {
    what: kind === 'truth' ? 'truth-check' : 'audience-check', system, user, maxOut: 1200, temperature: 0,
    model: CHECK_MODEL, pin: { endpoint: CHECK_PROVIDER, name: CHECK_PROVIDER_NAME },
  })
  if (r.json === null) throw new Error(`${kind}-check: unparseable reply`)
  const flags = flagsFrom(r.json)
  if (p) {
    try {
      mkdirSync(join(ctx.projectDir!, CHECK_CACHE_DIR), { recursive: true })
      writeAtomic(p, JSON.stringify({ key, kind, model: CHECK_MODEL, provider: r.provider, flags, at: new Date().toISOString() }, null, 2) + '\n')
    } catch {
      /* best-effort */
    }
  }
  return { flags, provider: r.provider, cacheKey: key, cached: false }
}

/**
 * All gates for one script. `flags` (hard) non-empty ⇒ blocked. `warnings` are advisory
 * quality flags (empty under OSBORN_CONTENT_STRICT=1, where they are hard flags instead).
 * Throws CapError / Error (piece → capped / error).
 */
export async function runChecks(s: Script, brief: Brief, ctx: CheckContext): Promise<{ summary: CheckSummary; flags: string[]; warnings: string[] }> {
  const strict = isContentStrict()
  const length = lengthCheck(s)
  const prepass = devVoicePrepass(s.lines, ctx.records, s.tier)
  const structure = structureCheck(s, brief)
  const summary: CheckSummary = { prepass, truth: null, audience: null, length, structure }
  const flags: string[] = []
  const warnings: string[] = []
  // Advisory unless strict: same text either way, only where it lands differs.
  const soft = (f: string) => (strict ? flags : warnings).push(f)
  if (!length.ok) {
    const msg = `length ~${length.seconds}s outside ${length.min}-${length.max}s for ${s.tier}`
    const tolerated = length.seconds > length.max && length.seconds <= length.max * (1 + OVER_LENGTH_TOLERANCE)
    if (tolerated) soft(`${msg} (within +${OVER_LENGTH_TOLERANCE * 100}% over-length tolerance)`)
    else flags.push(msg)
  }
  flags.push(...prepass.flags)
  structure.flags.forEach(soft)
  if (!s.lines.length) flags.push('script has no lines')
  if (flags.length) return { summary, flags, warnings }
  const draft = draftText(s)
  const t = await pinnedJudge('truth', TRUTH_SYSTEM, truthUser(ctx.sources, draft), ctx)
  summary.truth = { ok: t.flags.length === 0, flags: t.flags, model: CHECK_MODEL, provider: t.provider, cacheKey: t.cacheKey, cached: t.cached }
  if (t.flags.length) return { summary, flags: t.flags.map(f => `truth: ${f}`), warnings }
  const a = await pinnedJudge('audience', AUDIENCE_SYSTEM, audienceUser(brief, draft), ctx)
  summary.audience = { ok: a.flags.length === 0, flags: a.flags, model: CHECK_MODEL, provider: a.provider }
  a.flags.forEach(f => soft(`audience: ${f}`))
  return { summary, flags, warnings }
}
