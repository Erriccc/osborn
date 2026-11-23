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

// Best-effort: make sure a label exists so these are filterable apart from the
// automation's traced findings. Cached per repo per process; failures are
// non-fatal (the issue still files, the label is just dropped by GitHub).
const labelsEnsured = new Map<string, Set<string>>()
async function ensureLabel(tok: string, repo: string, label: { name: string; color: string; description: string }, timeoutMs?: number): Promise<void> {
  const done = labelsEnsured.get(repo) ?? new Set<string>()
  labelsEnsured.set(repo, done)
  if (done.has(label.name)) return
  done.add(label.name) // optimistic — don't retry every call even on failure
  try {
    await fetch(`${GITHUB_API}/repos/${repo}/labels`, {
      method: 'POST',
      headers: ghHeaders(tok),
      body: JSON.stringify(label),
      ...withTimeout(timeoutMs),
    }) // 201 created or 422 already-exists — either is fine
  } catch {
    // ignore
  }
}

type IssueHit = { number: number; url: string }
type IssueRow = { number: number; html_url?: string; body?: string; pull_request?: unknown; state?: string; state_reason?: string | null }
const withTimeout = (ms?: number): { signal?: AbortSignal } => (ms ? { signal: AbortSignal.timeout(ms) } : {})
const hitOf = (repo: string, it: IssueRow): IssueHit => ({ number: it.number, url: it.html_url || `https://github.com/${repo}/issues/${it.number}` })

// Find an issue already tracking `tokenStr`: OPEN only ('open'), or open or closed as not planned
// ('open-or-dismissed': a follow-up the user dismissed is never filed again; one closed as done
// may be filed again if the item comes back open).
async function findDuplicate(tok: string, repo: string, tokenStr: string, mode: 'open' | 'open-or-dismissed', timeoutMs?: number): Promise<IssueHit | null> {
  const q = `repo:${repo} is:issue${mode === 'open' ? ' is:open' : ''} in:body "${tokenStr}"`
  const url = `${GITHUB_API}/search/issues?per_page=5&q=${encodeURIComponent(q)}`
  try {
    const res = await fetch(url, { headers: ghHeaders(tok), ...withTimeout(timeoutMs) })
    if (!res.ok) return null
    const data = (await res.json()) as { items?: IssueRow[] }
    const items = Array.isArray(data.items) ? data.items : []
    // Confirm the marker is really in the body (search is fuzzy) and it's an issue.
    const hit = items.find((it) => !it.pull_request && typeof it.body === 'string' && it.body.includes(tokenStr) && (mode === 'open' || blocksRefiling(it)))
    return hit ? hitOf(repo, hit) : null
  } catch {
    return null
  }
}

async function findOpenDuplicate(tok: string, fp: string): Promise<number | null> {
  return (await findDuplicate(tok, REPO, fingerprintToken(fp), 'open'))?.number ?? null
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

    await ensureLabel(tok, REPO, { name: USER_REPORT_LABEL, color: '0e8a16', description: 'Filed by a user via the in-app report form' })
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

// ── Follow-through (#378): open items from a voice session, filed inert ─────────
//
// Filed through /api/follow-through (sync-token auth, admin accounts only), into a repo
// the server's GitHub token can already push to. A follow-up is a record,
// never a work order: no assignees, only the labels below, @-mentions neutralized
// so no watching bot or person is pinged, and a body that says so.

export const FOLLOW_UP_SOURCES = ['explicit', 'inferred'] as const
export const FOLLOW_UP_ORIGINS = ['user_mic', 'meeting', 'phone', 'tool', 'system'] as const

export interface FollowUpItem {
  /** The agent's loopKey: 12 hex. */
  key: string
  kind: string
  /** Already redacted and path-scrubbed by the route; a short paraphrase. */
  text: string
  source: (typeof FOLLOW_UP_SOURCES)[number]
  origin: (typeof FOLLOW_UP_ORIGINS)[number]
  turn?: number
}

export const FOLLOW_THROUGH_LABEL = 'follow-through'
const PROPOSED_LABEL = 'osborn:proposed'
const NOTED_LABEL = 'osborn:noted'
/** The only labels a follow-up issue may carry. */
export const FOLLOW_UP_LABELS: readonly string[] = [FOLLOW_THROUGH_LABEL, PROPOSED_LABEL, NOTED_LABEL]
const LABEL_SPECS: Record<string, { color: string; description: string }> = {
  [FOLLOW_THROUGH_LABEL]: { color: 'c5def5', description: 'Open item kept by Osborn follow-through; a record, not a work order' },
  [PROPOSED_LABEL]: { color: 'fef2c0', description: 'The user asked for this in their own words; not yet agreed' },
  [NOTED_LABEL]: { color: 'ededed', description: 'Inferred by Osborn; not asked for or agreed' },
}

/** `@name` → `@\u200dname` so GitHub links no one and no bot reacts to a mention. */
function neutralizeMentions(s: string): string {
  return (s ?? '').replace(/@(?=[A-Za-z0-9_-])/g, '@\u200d')
}

/** `<` and `>` as entities so item text never renders as HTML in the issue body. */
const escapeHtml = (s: string): string => s.replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * No live markdown: links and images (`](`, `![`) are broken up, and `owner/repo#N`, `#N` and
 * `GH-N` cross-references get a zero-width joiner after `#` (or `-`), so an item never links
 * to, mentions in the timeline of, or closes another issue.
 */
function neutralizeMarkdown(s: string): string {
  return (s ?? '')
    .replace(/!\[/g, '!\u200d[')
    .replace(/\]\(/g, ']\u200d(')
    .replace(/#(?=\d)/g, '#\u200d')
    .replace(/\bGH-(?=\d)/gi, (m) => `${m}\u200d`)
}

/** A follow-up issue already on GitHub blocks a new one while open, or once closed as not planned. */
const blocksRefiling = (it: IssueRow): boolean => it.state !== 'closed' || it.state_reason === 'not_planned'

/** Per GitHub call: the agent's request gives up after 15s and the route files items one by one. */
const FOLLOW_UP_FETCH_MS = 5_000

/** Explicit only when the user said it into the mic in their own words. */
export const isUserExplicit = (item: Pick<FollowUpItem, 'source' | 'origin'>): boolean =>
  item.source === 'explicit' && item.origin === 'user_mic'

const KIND_LABEL: Record<string, string> = {
  ask: 'Something you asked for',
  todo: 'Unfinished todo', todo_status: 'Unfinished todo', task: 'Unfinished task', task_status: 'Unfinished task',
  dispatch_started: 'Unfinished agent run', dispatch_severed: 'Unfinished agent run',
  question: 'Unanswered question', permission_pending: 'Approval never given', permission_settled: 'Approval never given',
  slot_refused: 'Refused background session', queued: 'Queued, not started',
  budget_denied: 'Work cut off', steward_block: 'Blocked change', open_loop: 'Open item',
}

// Pure: shape the inert follow-up issue.
function buildFollowUpContent(item: FollowUpItem): { title: string; body: string; labels: string[]; assignees: string[] } {
  const explicit = isUserExplicit(item)
  const text = neutralizeMarkdown(neutralizeMentions(trim(item.text, 200))) || 'Open item'
  const title = `[follow-up] ${trim(text, 120)}`
  const lines: string[] = []
  lines.push(`**${KIND_LABEL[item.kind] ?? 'Open item'}**`)
  lines.push('')
  lines.push(escapeHtml(text))
  lines.push('')
  lines.push(explicit
    ? 'Source: the user asked for this in their own words. Proposed, not agreed.'
    : `Source: inferred by Osborn (${item.origin === 'user_mic' ? 'from the conversation' : `from ${item.origin}`}), not asked for or agreed.`)
  if (typeof item.turn === 'number' && item.turn > 0) lines.push(`Turn ${Math.floor(item.turn)} · ${new Date().toISOString().slice(0, 10)}`)
  lines.push('')
  lines.push('<sub>Follow-up record, not a work order. Filed automatically by Osborn follow-through; reply or close to dismiss.</sub>')
  lines.push(`<!-- ${fingerprintToken(item.key)} do-not-remove -->`)
  return { title, body: lines.join('\n'), labels: [FOLLOW_THROUGH_LABEL, explicit ? PROPOSED_LABEL : NOTED_LABEL], assignees: [] }
}

// Search can lag behind a just-created issue; the newest follow-through issues by label are listed directly too.
async function findFollowUpByLabel(tok: string, repo: string, tokenStr: string): Promise<IssueHit | null> {
  try {
    const url = `${GITHUB_API}/repos/${repo}/issues?labels=${encodeURIComponent(FOLLOW_THROUGH_LABEL)}&state=all&sort=created&direction=desc&per_page=50`
    const res = await fetch(url, { headers: ghHeaders(tok), ...withTimeout(FOLLOW_UP_FETCH_MS) })
    if (!res.ok) return null
    const rows = (await res.json()) as IssueRow[]
    const hit = Array.isArray(rows) ? rows.find((it) => !it.pull_request && typeof it.body === 'string' && it.body.includes(tokenStr) && blocksRefiling(it)) : undefined
    return hit ? hitOf(repo, hit) : null
  } catch {
    return null
  }
}

export type FollowUpResult = { ok: true; action: 'created' | 'skipped'; url: string } | { ok: false; error: string }

/**
 * What the server's GitHub token may do in `repo`: push access, and visibility. Unknown
 * (no token, error, not found) is no access and public, so callers fail closed.
 */
export async function repoAccess(repo: string): Promise<{ canPush: boolean; isPrivate: boolean }> {
  const none = { canPush: false, isPrivate: false }
  const tok = token()
  if (!tok) return none
  try {
    const res = await fetch(`${GITHUB_API}/repos/${repo}`, { headers: ghHeaders(tok), ...withTimeout(FOLLOW_UP_FETCH_MS) })
    if (!res.ok) return none
    const data = (await res.json()) as { private?: unknown; permissions?: { push?: unknown } }
    return { canPush: data?.permissions?.push === true, isPrivate: data?.private === true }
  } catch {
    return none
  }
}

export const githubConfigured = (): boolean => token() !== null

// One create per (repo, key) at a time in this server process.
const inFlight = new Map<string, Promise<FollowUpResult>>()

/**
 * File one follow-up into `repo`, skipping when an issue already carries its key and is open or
 * was closed as not planned (dismissed). A key closed as completed may be filed again. Never throws.
 */
export function fileFollowUp(repo: string, item: FollowUpItem): Promise<FollowUpResult> {
  const k = `${repo}#${item.key}`
  const running = inFlight.get(k)
  if (running) return running
  const p = fileFollowUpOnce(repo, item).finally(() => inFlight.delete(k))
  inFlight.set(k, p)
  return p
}

async function fileFollowUpOnce(repo: string, item: FollowUpItem): Promise<FollowUpResult> {
  const tok = token()
  if (!tok) return { ok: false, error: 'GITHUB_TOKEN not configured' }
  const tokenStr = fingerprintToken(item.key)
  try {
    const dup = (await findFollowUpByLabel(tok, repo, tokenStr)) ?? (await findDuplicate(tok, repo, tokenStr, 'open-or-dismissed', FOLLOW_UP_FETCH_MS))
    if (dup) return { ok: true, action: 'skipped', url: dup.url }
    const { title, body, labels } = buildFollowUpContent(item)
    for (const name of labels) await ensureLabel(tok, repo, { name, ...LABEL_SPECS[name] }, FOLLOW_UP_FETCH_MS)
    // No `assignees` field: a follow-up is never assigned to anyone.
    const res = await fetch(`${GITHUB_API}/repos/${repo}/issues`, {
      method: 'POST',
      headers: ghHeaders(tok),
      body: JSON.stringify({ title, body, labels }),
      ...withTimeout(FOLLOW_UP_FETCH_MS),
    })
    if (!res.ok) return { ok: false, error: `create failed: ${res.status} ${await safeText(res)}` }
    const created = (await res.json()) as { number: number; html_url: string }
    return { ok: true, action: 'created', url: created.html_url }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'follow-up failed' }
  }
}
