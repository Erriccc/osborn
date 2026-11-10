// Bug report / feature request submission (frontend-owned Supabase write).
//
// The bug_reports table (migration 003) is written two ways, both funneling
// through `submitBugReport` → POST /api/report:
//   1. Agent/voice path: the bug-reporter skill POSTs the agent's /report-bug,
//      which forwards a {type:'bug_report', payload, context} data-channel
//      message to VoiceRoom, which calls submitBugReport.
//   2. Direct path: the "Report a bug" button in the account menu (the modal).
//
// The actual insert is done server-side in /api/report, as the signed-in user
// (their cookies → RLS: reporter_user_id = auth.uid(), migration 003). That route
// ALSO mirrors the report to GitHub Issues (issue #44); mirroring must run on the
// server so the GITHUB_TOKEN never reaches the client. buildBugReportRow stays
// pure + shared so the route validates/shapes exactly as before.

export type BugReportType = 'bug' | 'feature'
export type BugReportSeverity = 'low' | 'medium' | 'high' | 'critical'

export interface BugReportInput {
  type: BugReportType
  severity: BugReportSeverity
  title: string
  description: string
  reproduction_notes?: string
  tags?: string[]
  // Context — present when filed during a live voice session (from the agent).
  osborn_version?: string
  voice_mode?: string
  session_id?: string
  sandbox_id?: string
  metadata?: Record<string, unknown>
}

export interface BugReportRow {
  type: BugReportType
  severity: BugReportSeverity
  title: string
  description: string
  reproduction_notes: string | null
  tags: string[]
  reporter_user_id: string
  reporter_email: string | null
  osborn_version: string
  voice_mode: string | null
  session_id: string | null
  sandbox_id: string | null
  metadata: Record<string, unknown>
}

export type BuildResult = { ok: true; row: BugReportRow } | { ok: false; error: string }
export type BugReportResult = { ok: true; id?: string } | { ok: false; error: string }

const SEVERITIES: BugReportSeverity[] = ['low', 'medium', 'high', 'critical']

// Pure: validate + shape a row for the bug_reports table. Mirrors the server-side
// validation in the agent's /report-bug handler (title >= 3, description required,
// severity in enum) and the column limits, so both entry paths behave identically.
// osborn_version is NOT NULL in the schema; when filing straight from the web with
// no live agent we stamp 'web' so the insert never fails on it.
export function buildBugReportRow(
  input: BugReportInput,
  user: { id: string; email?: string | null },
): BuildResult {
  if (input.type !== 'bug' && input.type !== 'feature') return { ok: false, error: 'Pick bug or feature.' }
  const title = (input.title ?? '').trim()
  const description = (input.description ?? '').trim()
  if (title.length < 3) return { ok: false, error: 'Title must be at least 3 characters.' }
  if (!description) return { ok: false, error: 'Description is required.' }
  const severity: BugReportSeverity = SEVERITIES.includes(input.severity) ? input.severity : 'medium'

  return {
    ok: true,
    row: {
      type: input.type,
      severity,
      title: title.slice(0, 200),
      description: description.slice(0, 8000),
      reproduction_notes: input.reproduction_notes?.trim().slice(0, 4000) || null,
      tags: Array.isArray(input.tags) ? input.tags.filter((t) => typeof t === 'string' && t.trim()).slice(0, 20) : [],
      reporter_user_id: user.id,
      reporter_email: user.email ?? null,
      osborn_version: (input.osborn_version || '').trim().slice(0, 64) || 'web',
      voice_mode: input.voice_mode ?? null,
      session_id: input.session_id ?? null,
      sandbox_id: input.sandbox_id ?? null,
      metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
    },
  }
}

// Submit a bug report via the server (/api/report), which inserts it as the
// signed-in user and mirrors it to GitHub Issues. Returns a friendly error
// (never throws) so both the modal and the silent voice-path handler can surface
// it. Client-only (relative fetch); the server route holds the GITHUB_TOKEN.
export async function submitBugReport(input: BugReportInput): Promise<BugReportResult> {
  try {
    const resp = await fetch('/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    const data = (await resp.json().catch(() => ({}))) as { ok?: boolean; id?: string; error?: string }
    if (!resp.ok || !data.ok) return { ok: false, error: data.error || 'Submit failed.' }
    return { ok: true, id: data.id }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Network error — please try again.' }
  }
}
