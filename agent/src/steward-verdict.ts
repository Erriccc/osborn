// Steward verdict card (#221, #224): the steward's return text (agent/src/prompts/steward.md,
// "What to return") parsed into the fields the chat card shows, and kept in a sidecar next to
// compactions.jsonl so a reload rebuilds the card where it happened.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { getStorePath } from './session-store.js'

export type StewardVerdictKind = 'CLEAN' | 'REFACTORED' | 'BLOCK'

export interface StewardVerdict {
  verdict: StewardVerdictKind
  summary: string
  /** BLOCK only: the decision a human has to make. */
  decision?: string
  rootCause?: string
  netNew: string[]
  removed: string[]
  lines?: string
  history: string[]
  /** IMPACT: each changed symbol → its usages → verdict, then SIBLINGS. */
  impact?: string[]
  /** The full return, so the card can show the whole record. */
  raw: string
  /** ISO time the steward returned. */
  at: string
}

/** The sign-off gate advised on or refused a commit / push / PR (#254). Kept in the same sidecar. */
export interface StewardGateRecord {
  gate: 'advise' | 'deny'
  message: string
  at: string
}
export type StewardRecord = StewardVerdict | StewardGateRecord

const LABELS: Record<string, string> = {
  'VERDICT': 'verdict', 'REUSE MAP': 'reuse', 'INVENTORY': 'reuse', 'DUPLICATES': 'reuse', 'BEHAVIOUR': 'regressions', 'NET-NEW': 'netNew', 'REMOVED': 'removed',
  'REGRESSION MAP': 'regressions', 'IMPACT': 'impact', 'CHALLENGED': 'regressions', 'TESTS': 'regressions',
  'SETTLED': 'regressions', 'USER TIME': 'regressions', 'STEPS': 'regressions', 'LINES': 'lines', 'HISTORY': 'history', 'ROOT CAUSE': 'rootCause',
  'DECISION': 'decision', 'HUMAN DECISION': 'decision', 'DECISION NEEDED': 'decision',
}
// A label line, tolerant of markdown: "- **VERDICT:** ...", "## HISTORY", "ROOT CAUSE — ...".
const LABEL_RE = new RegExp(
  `^[\\s>#*_\\-•]*(${Object.keys(LABELS).sort((a, b) => b.length - a.length).join('|')})[*_\\s]*(?::|—|–|$)[*_\\s]*(.*)$`, 'i')
const strip = (s: string) => s.replace(/^[\s>*_\-•]+|[\s*_]+$/g, '').replace(/\*\*/g, '').trim()
const isNone = (s: string) => /^(none|n\/a|nothing)\b\.?$/i.test(s)
// Labels the template puts after HISTORY: only these may end it from a bullet line, so a
// "- IMPACT: …" or "- coupled: …" bullet inside HISTORY stays history (#259).
const AFTER_HISTORY = new Set(['CHALLENGED', 'SETTLED', 'USER TIME', 'STEPS', 'ROOT CAUSE', 'DECISION', 'HUMAN DECISION', 'DECISION NEEDED'])
const BULLET_RE = /^\s*(?:[-•*]\s|>)/
// Bounds, so a long return cannot overflow the data-channel packet on reload.
const MAX_ENTRIES = 20, MAX_ENTRY = 300, MAX_TEXT = 1000, MAX_RAW = 6000
const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '… [truncated]' : s)

/** Parse a steward return. Null when the text carries no VERDICT line. */
export function parseStewardVerdict(text: string, at: string = new Date().toISOString()): StewardVerdict | null {
  const sections: Record<string, string[]> = {}
  const loose: string[] = []
  let current: string | null = null
  // Model-written text: CRLF or lone CR line endings are normalised, or no label would match (#250).
  for (const line of String(text ?? '').split(/\r\n?|\n/)) {
    const m = line.match(LABEL_RE)
    const label = m ? m[1].toUpperCase().replace(/\s+/g, ' ') : ''
    if (m && !(current === 'history' && BULLET_RE.test(line) && !AFTER_HISTORY.has(label))) {
      current = LABELS[label]
      ;(sections[current] ??= [])
      const rest = strip(m[2])
      if (rest) sections[current].push(rest)
      continue
    }
    const s = strip(line)
    if (!s) continue
    if (current) sections[current].push(s)
    else loose.push(s)
  }
  const head = (sections.verdict ?? []).join(' ')
  const vm = head.match(/^(CLEAN|REFACTORED|BLOCK)\b[\s—–:\-|]*(.*)$/i)
  if (!vm) return null
  const verdict = vm[1].toUpperCase() as StewardVerdictKind
  // Every line is an entry; a single line holding several is split on ";".
  const entries = (k: string) => {
    const ls = sections[k] ?? []
    const out = (ls.length === 1 ? ls[0].split(/;\s+/) : ls).map(strip).filter(Boolean)
    return out.length === 1 && isNone(out[0]) ? [] : out.map((e) => e.slice(0, MAX_ENTRY))
  }
  const bounded = (k: string) => entries(k).slice(0, MAX_ENTRIES)
  // REUSE MAP stays in `raw` only; a NET-NEW entry inside the reuse map is lifted out, then capped.
  const netNew = entries('netNew')
  for (const e of entries('reuse')) {
    if (/NET-NEW/i.test(e)) netNew.push(e.replace(/\s*(?:→|->|\|)?\s*NET-NEW\s*:?\s*/i, ' — ').replace(/^ — /, ''))
  }
  const joined = (k: string) => cap((sections[k] ?? []).join(' ').trim(), MAX_TEXT) || undefined
  const impact = bounded('impact')
  // "For BLOCK, name the decision": a labelled DECISION line, else the free text that follows.
  const decision = verdict === 'BLOCK' ? joined('decision') ?? (loose.join(' ') || undefined) : undefined
  return {
    verdict,
    summary: cap(strip(vm[2]), MAX_TEXT),
    ...(decision ? { decision: cap(decision, MAX_TEXT) } : {}),
    ...(joined('rootCause') ? { rootCause: joined('rootCause') } : {}),
    netNew: netNew.slice(0, MAX_ENTRIES),
    removed: bounded('removed'),
    ...(joined('lines') ? { lines: joined('lines') } : {}),
    history: bounded('history'),
    ...(impact.length ? { impact } : {}),
    raw: cap(String(text).trim(), MAX_RAW),
    at,
  }
}

/** The `prior_messages` push: the last `n` verdicts and the last `n` gate events (so gates never crowd the
 *  verdicts out), file order, without `raw` and `impact` so it stays under the packet limit.
 *  `/session-messages` serves the full records. */
export function stewardPushRecords(records: StewardRecord[], n = 10): StewardRecord[] {
  const keep = new Set([...records.filter((r) => 'verdict' in r).slice(-n), ...records.filter((r) => 'gate' in r).slice(-n)])
  return records.filter((r) => keep.has(r)).map((r) => ('verdict' in r ? { ...r, raw: undefined, impact: undefined } : r))
}

/** Sidecar path: next to session.db and compactions.jsonl. */
export function getStewardLogPath(sessionId: string, workingDir: string): string {
  return join(dirname(getStorePath(sessionId, workingDir)), 'steward.jsonl')
}

export function appendStewardRecord(sessionId: string, workingDir: string, v: StewardRecord): void {
  const p = getStewardLogPath(sessionId, workingDir)
  mkdirSync(dirname(p), { recursive: true })
  appendFileSync(p, JSON.stringify(v) + '\n', 'utf-8')
}

/** Every recorded verdict and gate event for a session, file order. Missing file or torn lines are skipped. */
export function readStewardRecords(sessionId: string, workingDir: string): StewardRecord[] {
  const p = getStewardLogPath(sessionId, workingDir)
  if (!existsSync(p)) return []
  const out: StewardRecord[] = []
  for (const line of readFileSync(p, 'utf-8').split('\n')) {
    try {
      const o = JSON.parse(line)
      if (o && (typeof o.verdict === 'string' || typeof o.gate === 'string') && typeof o.at === 'string') out.push(o)
    } catch { /* blank or torn line */ }
  }
  return out
}
