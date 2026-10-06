/**
 * content-ingest.ts — sends a CHECKED script draft (no flags) to the cloud
 * library through the same content_ingest RPC as library pages
 * (lens-ingest.ts postContentIngest: sync-token auth, anon key, the
 * Content-Profile: public header, size cap, never throws, never sends status).
 *
 * Mapping (no new content type):
 *   type          text_post (Stage B later attaches media to the SAME row → short / audio_video)
 *   source_kind   script_highlight | script_howto
 *   content_hash  sha256(session, period start row, piece id) — stable per piece, so a
 *                 re-ingest upserts and a later media attach hits the same row
 *   source_anchors  project_slug (basename(projectDir), as lens-library), period, brief,
 *                 research citations, check result, dev-voice row ids, auto_generated: true
 * Every string in the payload goes through scrubDeep() (content-redact.ts) first.
 * Blocked pieces never reach this module (content-run).
 */

import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { postContentIngest, resolveIngestConfig, type IngestOptions, type IngestState } from './lens-ingest.js'
import { CHECK_MODEL, CHECK_PROVIDER } from './content-llm.js'
import type { CheckSummary } from './content-manifest.js'
import type { Brief } from './content-brief.js'
import { FORMAT_CATALOG, TIER_TEMPLATES } from './content-script-rules.js'
import { scriptTranscript, type Script } from './content-script.js'

export const AUTO_LABEL = 'Auto-generated draft'
const SESSION_ID_RE = /^[a-zA-Z0-9._-]{1,128}$/

export interface ScriptDraft {
  sessionId: string
  projectDir: string | null
  period: { index: number; startRowId: number; endRowId: number; page: string }
  brief: Brief
  script: Script
  checks: CheckSummary
  citations: { url: string; title: string; source: string }[]
  model: string
}

export const pieceContentHash = (sessionId: string, startRowId: number, pieceId: string): string =>
  createHash('sha256').update(`content-script\n${sessionId}\n${startRowId}\n${pieceId}`).digest('hex')

export const projectSlugFor = (projectDir: string | null): string | null => (projectDir ? basename(projectDir) : null)

const LABEL = { narrator: 'NARRATOR', dev: 'DEVELOPER (verbatim)', agent: 'AGENT' } as const

/** The draft as markdown (the `body` field), labelled as auto-generated. */
export function scriptMarkdown(d: ScriptDraft): string {
  const b = d.brief
  const s = d.script
  const fmt = FORMAT_CATALOG.find(f => f.id === b.format)
  const devRow = new Map(d.checks.prepass.rows.map(r => [r.line, r.row]))
  return [
    `> **${AUTO_LABEL}** — written by the content pipeline from this session; review before publishing.`,
    `# ${s.title || '(untitled)'}`,
    s.hook ? `*${s.hook}*` : '',
    '## Brief',
    `- **Viewer:** ${b.viewer}`,
    `- **Living through:** ${b.situation}`,
    `- **Tier:** ${TIER_TEMPLATES[b.tier].label} · ~${s.estSeconds}s (${s.words} words)`,
    `- **Format:** ${fmt?.name ?? b.format}`,
    b.stake ? `- **Stake:** ${b.stake.quantity}: ${b.stake.before} → ${b.stake.after}` : '',
    `- **Angle:** ${b.angle}`,
    b.problems.length ? `- **Speaks to:** ${b.problems.join('; ')}` : '',
    '## Script',
    ...s.lines.map((l, i) => `${i + 1}. **${LABEL[l.speaker]}:** ${l.text}${l.speaker === 'dev' && devRow.has(i + 1) ? ` _(row #${devRow.get(i + 1)})_` : ''}`),
    d.citations.length ? '## Research threads' : '',
    ...d.citations.map(c => `- [${c.title}](${c.url}) (${c.source})`),
    '## Checks',
    `- Dev-voice pre-pass: ${d.checks.prepass.ok ? 'pass' : 'FAIL'} · length ~${d.checks.length.seconds}s (${d.checks.length.min}-${d.checks.length.max}s)`,
    d.checks.truth ? `- Truth-check (${d.checks.truth.model} via ${d.checks.truth.provider}): ${d.checks.truth.flags.length} flag(s)` : '',
    d.checks.audience ? `- Audience check: ${d.checks.audience.flags.length} flag(s)` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

export function buildScriptPayload(d: ScriptDraft, scrubDeep: <T>(v: T) => T = v => v): Record<string, unknown> {
  const s = d.script
  const b = d.brief
  const payload = {
    type: 'text_post',
    title: `${AUTO_LABEL}: ${s.title || b.subtopic}`.slice(0, 200),
    hook: s.hook || null,
    body: scriptMarkdown(d),
    transcript: scriptTranscript(s),
    transcript_segments: s.lines.map((l, i) => ({ i: i + 1, speaker: l.speaker, text: l.text, ...(l.row ? { row: l.row } : {}) })),
    source_session_id: SESSION_ID_RE.test(d.sessionId) ? d.sessionId : null,
    source_kind: b.tier === 'highlight' ? 'script_highlight' : 'script_howto',
    source_anchors: {
      auto_generated: true,
      label: AUTO_LABEL,
      project_slug: projectSlugFor(d.projectDir),
      piece_id: b.id,
      period: { index: d.period.index, start_row_id: d.period.startRowId, end_row_id: d.period.endRowId, page: d.period.page },
      brief: {
        viewer: b.viewer, situation: b.situation, tier: b.tier, format: b.format, angle: b.angle, problems: b.problems,
        stake: b.stake, subtopic: b.subtopic, story: b.story, from_row: b.fromRow, to_row: b.toRow, owner: b.owner,
      },
      research: { key: b.researchKey, citations: d.citations },
      checks: { ...d.checks, flags: 0 },
      dev_rows: d.checks.prepass.rows,
      est_seconds: s.estSeconds,
      generator: { model: d.model, check_model: CHECK_MODEL, check_provider: CHECK_PROVIDER },
    },
    content_hash: pieceContentHash(d.sessionId, d.period.startRowId, b.id),
  }
  // Redact every string, then restore the hash (hex, untouched by design but never trust a scrubber with it).
  return { ...scrubDeep(payload), content_hash: payload.content_hash }
}

export const isIngestConfigured = (): boolean => resolveIngestConfig().ok

/** Ingest one checked script draft. Never throws. */
export async function ingestScript(d: ScriptDraft, scrubDeep: <T>(v: T) => T, o: IngestOptions = {}): Promise<IngestState> {
  const hash = pieceContentHash(d.sessionId, d.period.startRowId, d.brief.id)
  let payload: Record<string, unknown> | null = null
  try {
    payload = buildScriptPayload(d, scrubDeep)
  } catch {
    return { status: 'error', reason: 'payload', contentHash: hash, at: new Date().toISOString() }
  }
  return postContentIngest(payload, hash, `content: ingest ${d.brief.id} (period ${d.period.index})`, o)
}
