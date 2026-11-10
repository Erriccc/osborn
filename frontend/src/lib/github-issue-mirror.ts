// Mirror in-app "Report an issue" reports to GitHub Issues (issue #44).
//
// This project is open source, so user-filed bug/feature reports — which today
// land only in the private `bug_reports` table — are mirrored to GitHub Issues
// where outside developers and external agents can pick them up. The scheduled
// UI-test automation already posts its traced findings here; end-user reports
// now arrive in the same place and shape.
//
// SERVER ONLY. Holds `GITHUB_TOKEN`; never import from a client component.
//
// Privacy (issue #44, project-owner note): the input type `MirrorReport` is the
// allowlist. It carries only the report text + reproduction + product context —
// deliberately NOT reporter_email, reporter_user_id, session_id, sandbox_id,
// log_url, or free-form metadata. Because the mirror functions accept only this
// shape, account/session internals cannot reach GitHub by construction.
//
// Dedup (issue #44): each issue body carries a stable, searchable fingerprint
// token derived from type + normalized title. Before opening a new issue we
// search the repo for an OPEN issue with the same token; if one exists we add a
// comment to it instead of filing a duplicate. (A recurrence after the issue was
// closed opens a fresh issue, which is the intended "it's back" signal.)

import { createHash } from 'crypto'

export type MirrorReportType = 'bug' | 'feature'
export type MirrorReportSeverity = 'low' | 'medium' | 'high' | 'critical'

// The privacy allowlist — the ONLY fields that may travel to GitHub.
export interface MirrorReport {
  type: MirrorReportType
  severity: MirrorReportSeverity
  title: string
  description: string
  reproduction_notes?: string | null
  tags?: string[] | null
  // Product context (safe to publish — about the software, not the person):
  osborn_version?: string | null
  voice_mode?: string | null
}

export type MirrorResult =
  | { ok: true; action: 'created' | 'commented'; issueNumber: number; url: string }
  | { ok: true; action: 'skipped'; reason: string }
  | { ok: false; error: string }

const GITHUB_API = 'https://api.github.com'
// Default to this repo; overridable so forks/staging can retarget without code edits.
const REPO = (process.env.GITHUB_REPO || 'Erriccc/osborn').trim()
const USER_REPORT_LABEL = 'user-report'

function token(): string | null {
  const t = (process.env.GITHUB_TOKEN || process.env.GITHUB_PERSONAL_ACCESS_TOKEN || '').trim()
  return t || null
}

function ghHeaders(tok: string): Record<string, string> {
  return {
    Authorization: `Bearer ${tok}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'voice-native-report-mirror',
    'Content-Type': 'application/json',
  }
}

// Stable dedup key: same report type + semantically-equal title collapse together.
// Short hash keeps the body marker compact while staying collision-safe enough for
// human-filed titles. Exported for tests.
export function reportFingerprint(type: string, title: string): string {
  const norm = `${type}:${(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`
  return createHash('sha256').update(norm).digest('hex').slice(0, 12)
}

// Plain, searchable token embedded in the issue body (GitHub search tokenizes on
// punctuation, so we keep this alphanumeric + dashes and search it quoted).
function fingerprintToken(fp: string): string {
  return `osborn-fp-${fp}`
}

function trim(s: string | null | undefined, max: number): string {
  return (s ?? '').toString().trim().slice(0, max)
}

// Pure: shape the privacy-safe GitHub issue from a report. Exported for tests so
// the "no private fields leak" guarantee is checked directly.
export function buildIssueContent(report: MirrorReport): { title: string; body: string; labels: string[] } {
  const fp = reportFingerprint(report.type, report.title)
  const kind = report.type === 'feature' ? 'feature' : 'bug'
  const cleanTitle = trim(report.title, 160) || 'Untitled report'
  const title = `[${kind}] ${cleanTitle}`

  const repro = trim(report.reproduction_notes, 4000)
  const tags = Array.isArray(report.tags)
    ? report.tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim()).slice(0, 20)
    : []
  const version = trim(report.osborn_version, 64)
  const voiceMode = trim(report.voice_mode, 32)

  const lines: string[] = []
  lines.push(`**Type:** ${kind}  •  **Severity:** ${report.severity}`)
  lines.push('')
  lines.push('### What happened')
  lines.push(trim(report.description, 8000) || '_No description provided._')
  lines.push('')
  lines.push('### Steps to reproduce')
  lines.push(repro || '_Not provided._')

  const ctx: string[] = []
  if (version && version !== 'unknown' && version !== 'web') ctx.push(`Osborn version: \`${version}\``)
  if (voiceMode) ctx.push(`Voice mode: \`${voiceMode}\``)
  if (tags.length) ctx.push(`Tags: ${tags.map((t) => `\`${t}\``).join(', ')}`)
  if (ctx.length) {
    lines.push('')
    lines.push('---')
    lines.push(ctx.join('  •  '))
  }

  lines.push('')
  lines.push('<sub>Filed from an in-app report in Voice Native and mirrored here automatically. No reporter identity, session, or machine details are included.</sub>')
  // Dedup marker — keep last; `fingerprintToken` is what the search query matches.
  lines.push(`<!-- ${fingerprintToken(fp)} do-not-remove -->`)

  const labels = [kind === 'feature' ? 'enhancement' : 'bug', USER_REPORT_LABEL]
  return { title, body: lines.join('\n'), labels }
}

// Pure: the follow-up comment added when a duplicate is detected.
export function buildDuplicateComment(report: MirrorReport): string {
  const fp = reportFingerprint(report.type, report.title)
  const repro = trim(report.reproduction_notes, 4000)
  const lines: string[] = []
  lines.push('🔁 **Another in-app report matched this issue.**')
  lines.push('')
  lines.push(`**Severity:** ${report.severity}`)
  lines.push('')
  lines.push('### What happened')
  lines.push(trim(report.description, 8000) || '_No description provided._')
  if (repro) {
    lines.push('')
    lines.push('### Steps to reproduce')
    lines.push(repro)
  }
  lines.push('')
  lines.push(`<!-- ${fingerprintToken(fp)} do-not-remove -->`)
  return lines.join('\n')
}

// Best-effort: make sure the `user-report` label exists so these are filterable
// apart from the automation's traced findings. Cached per process; failures are
// non-fatal (the issue still files, the label is just dropped by GitHub).
let labelEnsured = false
async function ensureUserReportLabel(tok: string): Promise<void> {
  if (labelEnsured) return
  labelEnsured = true // optimistic — don't retry every call even on failure
  try {
    await fetch(`${GITHUB_API}/repos/${REPO}/labels`, {
      method: 'POST',
      headers: ghHeaders(tok),
      body: JSON.stringify({
        name: USER_REPORT_LABEL,
        color: '0e8a16',
        description: 'Filed by a user via the in-app report form',
      }),
    }) // 201 created or 422 already-exists — either is fine
  } catch {
    // ignore
  }
}

// Find an OPEN issue already tracking this fingerprint. Returns its number, or null.
async function findOpenDuplicate(tok: string, fp: string): Promise<number | null> {
  const tokenStr = fingerprintToken(fp)
  const q = `repo:${REPO} is:issue is:open in:body "${tokenStr}"`
  const url = `${GITHUB_API}/search/issues?per_page=5&q=${encodeURIComponent(q)}`
  try {
    const res = await fetch(url, { headers: ghHeaders(tok) })
    if (!res.ok) return null
    const data = (await res.json()) as { items?: Array<{ number: number; body?: string; pull_request?: unknown }> }
    const items = Array.isArray(data.items) ? data.items : []
    // Confirm the marker is really in the body (search is fuzzy) and it's an issue.
    const hit = items.find((it) => !it.pull_request && typeof it.body === 'string' && it.body.includes(tokenStr))
    return hit ? hit.number : null
  } catch {
    return null
  }
}

// Mirror a single report to GitHub. Never throws — the caller's DB write already
// succeeded; mirroring is a best-effort downstream sync. No-ops (returns skipped)
// when no token is configured, so dev/un-configured deploys behave normally.
export async function mirrorReportToGitHub(report: MirrorReport): Promise<MirrorResult> {
  const tok = token()
  if (!tok) return { ok: true, action: 'skipped', reason: 'GITHUB_TOKEN not configured' }
  if (!report?.title || !report?.description) {
    return { ok: true, action: 'skipped', reason: 'missing title/description' }
  }

  const fp = reportFingerprint(report.type, report.title)

  try {
    // Dedup: comment on the existing open issue instead of opening a duplicate.
    const dup = await findOpenDuplicate(tok, fp)
    if (dup != null) {
      const res = await fetch(`${GITHUB_API}/repos/${REPO}/issues/${dup}/comments`, {
        method: 'POST',
        headers: ghHeaders(tok),
        body: JSON.stringify({ body: buildDuplicateComment(report) }),
      })
      if (!res.ok) return { ok: false, error: `comment failed: ${res.status} ${await safeText(res)}` }
      return { ok: true, action: 'commented', issueNumber: dup, url: `https://github.com/${REPO}/issues/${dup}` }
    }

    await ensureUserReportLabel(tok)
    const { title, body, labels } = buildIssueContent(report)
    const res = await fetch(`${GITHUB_API}/repos/${REPO}/issues`, {
      method: 'POST',
      headers: ghHeaders(tok),
      body: JSON.stringify({ title, body, labels }),
    })
    if (!res.ok) return { ok: false, error: `create failed: ${res.status} ${await safeText(res)}` }
    const created = (await res.json()) as { number: number; html_url: string }
    return { ok: true, action: 'created', issueNumber: created.number, url: created.html_url }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'mirror failed' }
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200)
  } catch {
    return ''
  }
}
