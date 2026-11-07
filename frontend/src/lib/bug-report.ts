// Bug report / feature request submission (frontend-owned Supabase write).
//
// The bug_reports table (migration 003) is written two ways, both landing here:
//   1. Agent/voice path: the bug-reporter skill POSTs the agent's /report-bug,
//      which forwards a {type:'bug_report', payload, context} data-channel
//      message to VoiceRoom — the frontend owns the actual insert (it holds the
//      Supabase session; no service key shipped to the Fly machine).
//   2. Direct path: the "Report a bug" button in the account menu.
//
// RLS: an authenticated user may insert only rows where reporter_user_id =
// auth.uid() (migration 003), so we always stamp the signed-in user. The agent
// path reuses the SAME signed-in session here, so it is RLS-compliant too.
import type { SupabaseClient } from '@supabase/supabase-js'

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

// Insert a bug report as the signed-in user. Returns a friendly error (never
// throws) so both the modal and the silent agent-path handler can surface it.
export async function submitBugReport(
  supabase: SupabaseClient,
  input: BugReportInput,
): Promise<BugReportResult> {
  let user: { id: string; email?: string | null } | null = null
  try {
    const { data } = await supabase.auth.getUser()
    user = data?.user ? { id: data.user.id, email: data.user.email } : null
  } catch {
    return { ok: false, error: 'Could not verify your session. Try again.' }
  }
  if (!user) return { ok: false, error: 'Sign in to file a report.' }

  const built = buildBugReportRow(input, user)
  if (!built.ok) return built

  try {
    const { data, error } = await supabase.from('bug_reports').insert(built.row).select('id').single()
    if (error) return { ok: false, error: error.message }
    return { ok: true, id: (data?.id as string | undefined) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Submit failed.' }
  }
}
