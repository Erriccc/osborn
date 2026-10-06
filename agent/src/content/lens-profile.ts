/**
 * lens-profile.ts — format + APPEND (never rewrite) the per-project
 * content-profile.md entry, and the worker's small redacted error log.
 */

import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { redactSecrets } from './transcript-sanitizer.js'
import type { Evidence, Quote } from './lens-quotes.js'
import type { GapEvidence } from './lens-hn.js'
import { clipOffset, type RecordingAlignment } from './lens-audio.js'
import { LOG_FILE, PROFILE_FILE } from './lens-paths.js'

export interface FinalAngle {
  title: string
  why: string
  quotes: Quote[]
  gap: GapEvidence
}
export interface FinalCapability {
  name: string
  did: string
  evidence: Evidence
  proof: string
  quotes: Quote[]
}
export interface EntryMeta {
  sessionId: string
  source: 'recall-db'
  mode: 'incremental' | 'backfill'
  model: string
  records: number
  rowRange: [number, number]
  windows: number
  windowsTotal: number
  modelCalls: number
  costUsd: number
  dropped: { angles: number; capabilities: number }
  notDone: number
  billingDropped?: number
  /** True when no client denylist was loaded: header carries a review warning. */
  noDenylist?: boolean
  recording: RecordingAlignment | null
}

const PROFILE_HEADER =
  '# Content Profile\n\nAppend-only. Postable angles + demonstrated capabilities auto-extracted at each compaction ' +
  '(disable with OSBORN_CONTENT_LENS=0). Every quote below was verified verbatim against the sanitized session ' +
  'recall store (session.db row #, timestamp); capabilities are tagged shipped | root-caused. Review before posting.\n'

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

function quoteLines(quotes: Quote[], rec: RecordingAlignment | null, indent = '  '): string[] {
  return quotes.map(q => {
    const clip = rec ? clipOffset(q.timestamp, rec.startIso) : null
    const clipTxt = clip ? ` · clip @${clip}${rec!.approximate ? ' (approx)' : ''}` : ''
    return `${indent}- > "${oneLine(q.text)}" — *${q.speaker}*, \`${q.timestamp}\` (row #${q.row})${clipTxt}`
  })
}

export function formatEntry(angles: FinalAngle[], caps: FinalCapability[], meta: EntryMeta): string {
  const L: string[] = []
  L.push(`\n## ${new Date().toISOString()} — session ${meta.sessionId.substring(0, 8)}`)
  L.push(
    `_source: ${meta.source} (${meta.mode}) · rows #${meta.rowRange[0]}–#${meta.rowRange[1]} · ${meta.records} conversation rows · ` +
      `${meta.windows}/${meta.windowsTotal} window(s) · ${meta.model} · ${meta.modelCalls} call(s) · $${meta.costUsd.toFixed(4)} · ` +
      `dropped by grounding check: ${meta.dropped.angles} angle(s), ${meta.dropped.capabilities} capability(ies) · ` +
      `dropped as not-done (plan/speculation): ${meta.notDone}` +
      `${meta.billingDropped !== undefined ? ` · dropped by finance-topic filter: ${meta.billingDropped}` : ''}_`,
  )
  if (meta.noDenylist) {
    L.push('_WARNING: no client denylist was loaded — only shape-based redaction (emails, ids, amounts, legal-suffix company names) was applied. Check for client names before posting._')
  }
  if (meta.recording) {
    const r = meta.recording
    L.push(
      `_recording: \`${r.path}\` · clip offsets relative to ${r.startIso} (${r.basis}` +
        `${r.approximate ? '; alignment APPROXIMATE' : ''})_`,
    )
  }
  L.push('')
  if (angles.length) {
    L.push('### Angles', '')
    for (const a of angles) {
      L.push(`#### ${oneLine(a.title)}`)
      if (a.why) L.push(`- **Why postable:** ${oneLine(a.why)}`)
      L.push('- **Verified quotes:**', ...quoteLines(a.quotes, meta.recording))
      L.push(`- **Gap evidence** (HN: ${a.gap.queries.map(q => `\`${q}\``).join(', ') || 'none'}):`)
      for (const s of a.gap.stories) {
        L.push(`  - [${oneLine(s.title)}](${s.url}) — ${s.points} pts, ${s.num_comments} comments`)
      }
      L.push(`  - ${a.gap.note}`, '')
    }
  }
  if (caps.length) {
    L.push('### Capabilities', '')
    for (const c of caps) {
      L.push(`- **${oneLine(c.name)}** \`[${c.evidence}]\` — ${oneLine(c.did)}`)
      if (c.proof) L.push(`    - _proof:_ ${oneLine(c.proof)}`)
      L.push(...quoteLines(c.quotes, meta.recording, '    '))
    }
    L.push('')
  }
  // Defense in depth: everything is redacted (incl. high-entropy) before disk.
  return redactSecrets(L.join('\n'), { assistant: true })
}

export function appendProfile(projectDir: string, entry: string): string {
  const path = join(projectDir, PROFILE_FILE)
  mkdirSync(projectDir, { recursive: true })
  if (!existsSync(path)) appendFileSync(path, PROFILE_HEADER, 'utf-8')
  appendFileSync(path, entry, 'utf-8')
  return path
}

/** Scratch output (sample runs): overwrite a single file, never the profile. */
export function writeScratch(path: string, entry: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, PROFILE_HEADER.replace('# Content Profile', '# Content Lens — scratch sample') + entry, 'utf-8')
  return path
}

const LOG_MAX_BYTES = 256 * 1024

/** Small redacted log line in the project dir; truncated when it grows past 256 KB. */
export function logLine(projectDir: string | null, msg: string): void {
  if (!projectDir) return
  try {
    const p = join(projectDir, LOG_FILE)
    const line = `${new Date().toISOString()} ${redactSecrets(oneLine(msg), { assistant: true }).slice(0, 2000)}\n`
    if (existsSync(p) && statSync(p).size > LOG_MAX_BYTES) writeFileSync(p, line, 'utf-8')
    else appendFileSync(p, line, 'utf-8')
  } catch {
    /* never throw from logging */
  }
}
