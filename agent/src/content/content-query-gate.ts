/**
 * content-query-gate.ts — deterministic gate on every search query that leaves
 * the machine (HN Algolia stories/comments, GitHub issue search). Runs AFTER
 * the scrubber, as a second, rule-based line: a query either passes untouched
 * or is dropped whole (never "repaired").
 *
 * A query is DROPPED when it:
 *   - has any character outside [A-Za-z0-9 .+#-] (this covers / \ @ :// _ etc.)
 *   - has a token containing "_" or CamelCase in the middle (refreshToken, MyApp)
 *   - has a token equal to the project basename or a cwd path segment, or
 *     contains such a segment as a phrase (acme-billing ⇔ "acme billing"), case-insensitive
 *   - is not 2-5 plain words
 */

import { basename } from 'node:path'

const ALLOWED = /^[A-Za-z0-9 .+#-]+$/
const CAMEL_MID = /[a-z0-9][A-Z]/
const MIN_WORDS = 2
const MAX_WORDS = 5

const norm = (s: string) => s.toLowerCase().replace(/[-_.\s]+/g, ' ').trim()

/** Private path terms: every segment of each path, plus each path's basename (and the raw value of non-path terms). */
export function privateSegments(paths: (string | null | undefined)[]): string[] {
  const out = new Set<string>()
  for (const p of paths) {
    const s = String(p ?? '').trim()
    if (!s) continue
    for (const seg of s.split(/[\\/]+/)) if (seg.trim()) out.add(seg.trim().toLowerCase())
    const b = basename(s.replace(/[\\/]+$/, ''))
    if (b) out.add(b.toLowerCase())
  }
  return [...out]
}

/** Returns the query (whitespace-collapsed) if it may leave the machine, else null. */
export function gateQuery(q: string, privateTerms: string[] = []): string | null {
  const s = String(q ?? '').replace(/\s+/g, ' ').trim()
  if (!s || !ALLOWED.test(s)) return null
  if (/:\/\/|[\\/@_]/.test(s)) return null
  const tokens = s.split(' ')
  if (tokens.length < MIN_WORDS || tokens.length > MAX_WORDS) return null
  for (const t of tokens) {
    if (!/[A-Za-z0-9]/.test(t)) return null
    if (t.includes('_') || CAMEL_MID.test(t)) return null
  }
  const lowTokens = new Set(tokens.map(t => t.toLowerCase()))
  const phrase = ` ${norm(s)} `
  for (const term of privateTerms) {
    const raw = term.trim().toLowerCase()
    if (!raw) continue
    if (lowTokens.has(raw)) return null
    const n = norm(raw)
    if (n && phrase.includes(` ${n} `)) return null
  }
  return s
}

/** Gate a list: survivors only, de-duplicated, order kept. */
export function gateQueries(qs: string[], privateTerms: string[] = []): string[] {
  const out: string[] = []
  for (const q of qs) {
    const g = gateQuery(q, privateTerms)
    if (g && !out.some(o => o.toLowerCase() === g.toLowerCase())) out.push(g)
  }
  return out
}
