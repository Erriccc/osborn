/**
 * lens-library-index.ts — rebuild a session library's INDEX.md from the period
 * pages on disk. The pages are the source of truth (renderPeriodMd format), so
 * pages written by the manual backfill are listed alongside auto-written ones,
 * and a rebuild is idempotent: same pages in → same INDEX out.
 */

import { readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const INDEX_FILE = 'INDEX.md'
export const PAGE_RE = /^(\d{4}-\d{2}-\d{2}|undated)-period-(\d+)\.md$/

export interface PageStory {
  title: string
  rows: string
  anchor: string | null
}

export interface PageSummary {
  file: string
  index: number
  rows: string
  from: string
  to: string
  goal: string
  topItem: string | null
  stories: PageStory[]
  costUsd: number
}

function section(md: string, heading: string): string {
  const at = md.indexOf(`\n## ${heading}\n`)
  if (at < 0) return ''
  const rest = md.slice(at + heading.length + 5)
  const end = rest.search(/\n## /)
  return end < 0 ? rest : rest.slice(0, end)
}

/** Parse one period page (renderPeriodMd output). Pure. */
export function parsePage(file: string, md: string): PageSummary {
  const m = file.match(PAGE_RE)
  const rows = md.match(/^- Rows in block: #(\d+)–#(\d+)/m)
  const time = md.match(/^- Time: (\S+) → (\S+)/m)
  const goalLines = section(md, 'Period goal').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('- >'))
  const goal = goalLines[0] && goalLines[0] !== '- (none verified)' ? goalLines[0] : '(no verified goal)'
  const top = section(md, 'High-leverage work (ranked)').match(/^1\. \*\*(.+?)\*\* \[([^\]]+)\]/m)
  const stories: PageStory[] = []
  for (const block of section(md, 'Stories').split(/(?:^|\n)### /).slice(1)) {
    const title = block.split('\n')[0].trim()
    const r = block.match(/^Rows: (#\d+–#\d+)/m)
    const a = block.match(/^\s*- > "(.+)" — user, row #(\d+)/m)
    stories.push({ title, rows: r?.[1] ?? '', anchor: a ? `“${a[1]}” (row #${a[2]})` : null })
  }
  const cost = md.match(/^- Calls: .*?\$(\d+(?:\.\d+)?) \(cap/m)
  return {
    file, index: m ? Number(m[2]) : 0, rows: rows ? `#${rows[1]}–#${rows[2]}` : '-',
    from: time?.[1] ?? '', to: time?.[2] ?? '', goal,
    topItem: top ? `${top[1]} [${top[2]}]` : null, stories, costUsd: cost ? Number(cost[1]) : 0,
  }
}

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n+/g, ' ')
const when = (iso: string): string => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso) ? iso.slice(0, 16).replace('T', ' ') : iso || '?')

/** Render INDEX.md. Pure. */
export function renderIndex(sessionLabel: string, pages: PageSummary[]): string {
  const ps = [...pages].sort((a, b) => a.index - b.index || a.file.localeCompare(b.file))
  const L: string[] = [`# Content library — session ${sessionLabel}`, '']
  L.push(
    'Period pages from the period map (review mode). New pages are written automatically by the content-lens worker on each ' +
      'compaction, one per period, keyed on the period\'s opening boundary row. content-profile.md and the HWM are not touched.',
    '',
  )
  L.push('## Periods (chronological)', '', '| # | Date range (UTC) | Rows | Period goal | Top high-leverage item | File |', '|---|---|---|---|---|---|')
  for (const p of ps) {
    L.push(`| ${String(p.index).padStart(2, '0')} | ${when(p.from)} → ${when(p.to)} | ${p.rows} | ${cell(p.goal)} | ${cell(p.topItem ?? '(none verified)')} | [${p.file}](${p.file}) |`)
  }
  L.push('', '## Stories', '', '| Date | Story | User anchor line (verbatim) | Rows | File |', '|---|---|---|---|---|')
  for (const p of ps) {
    for (const s of p.stories) L.push(`| ${p.from.slice(0, 10) || '?'} | ${cell(s.title)} | ${cell(s.anchor ?? '-')} | ${s.rows || '-'} | [${p.file}](${p.file}) |`)
  }
  const tops = ps.filter(p => p.topItem)
  L.push('', '## Top high-leverage item per period', '')
  if (!tops.length) L.push('- (none verified)')
  for (const p of tops) L.push(`- ${String(p.index).padStart(2, '0')}: ${p.topItem} — [${p.file}](${p.file})`)
  const stories = ps.reduce((n, p) => n + p.stories.length, 0)
  const cost = ps.reduce((n, p) => n + p.costUsd, 0)
  L.push('', '## Totals', '', `- Periods: ${ps.length}`, `- Stories: ${stories}`, `- Model spend across pages: $${cost.toFixed(4)}`)
  return L.join('\n') + '\n'
}

/** Rebuild <dir>/INDEX.md from every period page in <dir>. `scrub` = final redaction pass. Returns the path. */
export function rebuildIndex(dir: string, sessionLabel: string, scrub: (s: string) => string = s => s): string {
  const pages = readdirSync(dir)
    .filter(f => PAGE_RE.test(f))
    .map(f => parsePage(f, readFileSync(join(dir, f), 'utf-8')))
  const path = join(dir, INDEX_FILE)
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, scrub(renderIndex(sessionLabel, pages)), 'utf-8')
  renameSync(tmp, path)
  return path
}
