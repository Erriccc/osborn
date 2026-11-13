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
  reuse: string[]
  netNew: string[]
  removed: string[]
  regressions: string[]
  lines?: string
  history: string[]
  /** The full return, so the card can show the whole record. */
  raw: string
  /** ISO time the steward returned. */
  at: string
}

const LABELS: Record<string, string> = {
  'VERDICT': 'verdict', 'REUSE MAP': 'reuse', 'NET-NEW': 'netNew', 'REMOVED': 'removed',
  'REGRESSION MAP': 'regressions', 'LINES': 'lines', 'HISTORY': 'history', 'ROOT CAUSE': 'rootCause',
  'DECISION': 'decision', 'HUMAN DECISION': 'decision', 'DECISION NEEDED': 'decision',
}
// A label line, tolerant of markdown: "- **VERDICT:** ...", "## HISTORY", "ROOT CAUSE — ...".
const LABEL_RE = new RegExp(
  `^[\\s>#*_\\-•]*(${Object.keys(LABELS).sort((a, b) => b.length - a.length).join('|')})[*_\\s]*(?::|—|–|$)[*_\\s]*(.*)$`, 'i')
const strip = (s: string) => s.replace(/^[\s>*_\-•]+|[\s*_]+$/g, '').replace(/\*\*/g, '').trim()
const isNone = (s: string) => /^(none|n\/a|nothing)\b\.?$/i.test(s)

/** Parse a steward return. Null when the text carries no VERDICT line. */
export function parseStewardVerdict(text: string, at: string = new Date().toISOString()): StewardVerdict | null {
  const sections: Record<string, string[]> = {}
  const loose: string[] = []
  let current: string | null = null
  for (const line of String(text ?? '').split('\n')) {
    const m = line.match(LABEL_RE)
    if (m) {
      current = LABELS[m[1].toUpperCase().replace(/\s+/g, ' ')]
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
    return out.length === 1 && isNone(out[0]) ? [] : out
  }
  const reuse: string[] = [], netNew = entries('netNew')
  for (const e of entries('reuse')) {
    if (/NET-NEW/i.test(e)) netNew.push(e.replace(/\s*(?:→|->|\|)?\s*NET-NEW\s*:?\s*/i, ' — ').replace(/^ — /, ''))
    else reuse.push(e)
  }
  const joined = (k: string) => (sections[k] ?? []).join(' ').trim() || undefined
  // "For BLOCK, name the decision": a labelled DECISION line, else the free text that follows.
  const decision = verdict === 'BLOCK' ? joined('decision') ?? (loose.join(' ') || undefined) : undefined
  return {
    verdict,
    summary: strip(vm[2]),
    ...(decision ? { decision } : {}),
    ...(joined('rootCause') ? { rootCause: joined('rootCause') } : {}),
    reuse,
    netNew,
    removed: entries('removed'),
    regressions: entries('regressions'),
    ...(joined('lines') ? { lines: joined('lines') } : {}),
    history: entries('history'),
    raw: String(text).trim().slice(0, 6000),
    at,
  }
}

/** Sidecar path: next to session.db and compactions.jsonl. */
export function getStewardLogPath(sessionId: string, workingDir: string): string {
  return join(dirname(getStorePath(sessionId, workingDir)), 'steward.jsonl')
}

export function appendStewardVerdict(sessionId: string, workingDir: string, v: StewardVerdict): void {
  const p = getStewardLogPath(sessionId, workingDir)
  mkdirSync(dirname(p), { recursive: true })
  appendFileSync(p, JSON.stringify(v) + '\n', 'utf-8')
}

/** Every recorded verdict for a session, file order. Missing file or torn lines are skipped. */
export function readStewardVerdicts(sessionId: string, workingDir: string): StewardVerdict[] {
  const p = getStewardLogPath(sessionId, workingDir)
  if (!existsSync(p)) return []
  const out: StewardVerdict[] = []
  for (const line of readFileSync(p, 'utf-8').split('\n')) {
    try {
      const o = JSON.parse(line)
      if (o && typeof o.verdict === 'string' && typeof o.at === 'string') out.push(o)
    } catch { /* blank or torn line */ }
  }
  return out
}
