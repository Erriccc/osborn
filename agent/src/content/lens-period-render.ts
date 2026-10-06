/**
 * lens-period-render.ts — Markdown review output for a period-map run. Pure.
 * high_leverage is rendered FIRST (strongest content candidates). The caller
 * redacts the final string again (secrets + client) before writing it.
 */

import type { Quote } from './lens-quotes.js'
import type { PeriodBlock } from './lens-period-block.js'
import type { PeriodMap } from './lens-period.js'

export interface PeriodRunReport {
  sessionId: string
  model: string
  contextLength: number
  capTokens: number
  block: Omit<PeriodBlock, 'records' | 'text'> | null
  stripped: Record<string, number>
  rowsRead: number
  rowsKeptInSession: number
  map: PeriodMap | null
  calls: number
  promptTokens: number
  completionTokens: number
  costUsd: number
  capUsd: number
  finish: string
  provider: string
  audio: string
  errors: string[]
}

const q = (x: Quote): string => `  - > "${x.text.replace(/\n+/g, ' ')}" — ${x.speaker}, row #${x.row}, ${x.timestamp}${x.tsCorrected ? ' (ts corrected)' : ''}`
const quotes = (xs: Quote[]): string[] => xs.map(q)

export function renderPeriodMd(r: PeriodRunReport): string {
  const L: string[] = []
  const b = r.block
  L.push(`# Period map — session ${r.sessionId}`, '')
  L.push(`Model: ${r.model} (context ${r.contextLength.toLocaleString()} tok; block cap 25% = ${r.capTokens.toLocaleString()} tok). Review output only — profile and HWM untouched.`, '')
  L.push('## Block')
  if (b) {
    L.push(
      `- Basis: ${b.basis}`,
      `- Rows in block: #${b.firstRowId}–#${b.lastRowId} (${b.periodRows - (b.leftOut?.rows ?? 0)} conversation rows of ${b.periodRows} in the period)`,
      `- Time: ${b.from} → ${b.to}`,
      `- Size: ${b.chars.toLocaleString()} chars ≈ ${b.estTokens.toLocaleString()} tokens (est. 4 chars/token)`,
      b.leftOut
        ? `- LEFT OUT (over the cap, oldest end): ${b.leftOut.rows} rows #${b.leftOut.firstRowId}–#${b.leftOut.lastRowId} (${b.leftOut.from} → ${b.leftOut.to}, ≈${b.leftOut.estTokens.toLocaleString()} tok)`
        : '- Left out: nothing (whole period fits the cap)',
    )
  } else L.push('- (no block)')
  L.push(`- Raw rows in the block's range (user+assistant, main thread): ${r.rowsRead}; kept after strip/sanitize: ${r.rowsKeptInSession}`)
  L.push(`- Audio: ${r.audio}`, '')
  L.push("### Stripped before the block (rows affected, within the block's row range)")
  const kinds = Object.entries(r.stripped).sort((a, b2) => b2[1] - a[1])
  L.push(...(kinds.length ? kinds.map(([k, n]) => `- ${k}: ${n}`) : ['- none']), '')
  L.push('## Cost', `- Calls: ${r.calls}; tokens ${r.promptTokens.toLocaleString()} in + ${r.completionTokens.toLocaleString()} out; $${r.costUsd.toFixed(4)} (cap $${r.capUsd.toFixed(2)}); finish=${r.finish || '-'}; provider=${r.provider || '-'}`, '')
  if (r.errors.length) L.push('## Errors', ...r.errors.map(e => `- ${e}`), '')
  const m = r.map
  if (!m) return L.join('\n') + '\n'
  L.push('## High-leverage work (ranked)')
  if (!m.highLeverage.length) L.push('- (none verified)')
  m.highLeverage.forEach((h, i) => L.push(`${i + 1}. **${h.title}** [${h.evidence}] — ${h.why}`, ...quotes(h.quotes)))
  L.push('', '## Period goal')
  if (m.periodGoal) L.push(m.periodGoal.text, ...quotes(m.periodGoal.quotes))
  else L.push('- (none verified)')
  L.push('', '## Arc')
  m.arc.forEach((s, i) => L.push(`${i + 1}. [${s.step}] ${s.what}${s.why ? ` — ${s.why}` : ''}`, ...quotes(s.quotes)))
  L.push('', '## What worked', '### Held up')
  for (const w of m.whatWorked.heldUp) L.push(`- **${w.name}** (${w.kind || '-'}) — ${w.why}`, ...quotes(w.quotes))
  L.push('### Did not')
  for (const w of m.whatWorked.didnt) L.push(`- **${w.name}** (${w.kind || '-'}) — ${w.why}`, ...quotes(w.quotes))
  L.push('', '## Stories')
  for (const s of m.stories) {
    L.push(`### ${s.title}`, `Why it matters: ${s.whyItMatters}`, `Rows: #${s.from}–#${s.to}`)
    for (const tp of s.turningPoints) L.push(`- Turning point: ${tp.moment}`, ...tp.userLines.map(x => '  ' + q(x)))
    L.push('')
  }
  L.push('## Angles')
  for (const a of m.angles) L.push(`- **${a.title}** — demand question: ${a.demandQuestion}${a.story ? ` (story: ${a.story})` : ''}`, ...quotes(a.quotes))
  L.push('', '## Anchors (row ranges per story)')
  for (const a of m.anchors) {
    const audio = a.audio ? `; audio ${a.audio.start ?? '?'}–${a.audio.end ?? '?'}${a.audio.approximate ? ' (approx.)' : ''}` : ''
    L.push(`- ${a.story}: rows #${a.from}–#${a.to} (${a.rows} conversation rows, ${a.fromTs} → ${a.toTs}${audio})`)
  }
  L.push('', `## Quote verification`, `- Verified quotes kept: ${m.quotesKept}; quotes dropped: ${m.drops.length}; items dropped: ${m.itemsDropped.length}`)
  for (const d of m.drops) L.push(`- DROP [${d.section}] ${d.item} — row ${d.row || '?'}: "${d.text}" → ${d.reason}`)
  for (const it of m.itemsDropped) L.push(`- ITEM DROPPED ${it}`)
  return L.join('\n') + '\n'
}
