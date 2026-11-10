// POST /api/report — the in-app "Report a bug / feature" submission endpoint.
//
// The modal used to insert into `bug_reports` directly from the browser. It now
// posts here so the GitHub mirror (issue #44) can run server-side where the
// GITHUB_TOKEN lives — the token must never reach the client. The DB insert is
// still done as the signed-in user (RLS via their cookies), exactly as before;
// the mirror is a best-effort downstream step that never blocks the report.
import { NextResponse } from 'next/server'
import { createSupabaseServer } from '@/lib/supabase-server'
import { buildBugReportRow, type BugReportInput } from '@/lib/bug-report'
import { mirrorReportToGitHub } from '@/lib/github-issue-mirror'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  const supabase = await createSupabaseServer()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Sign in to file a report.' }, { status: 401 })

  let body: Partial<BugReportInput>
  try {
    body = (await request.json()) as Partial<BugReportInput>
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON.' }, { status: 400 })
  }

  // Shape + validate server-side (same rules as the agent path). osborn_version
  // defaults to 'web' for web-direct reports so the NOT NULL column never trips.
  const built = buildBugReportRow(
    {
      type: body.type as BugReportInput['type'],
      severity: body.severity as BugReportInput['severity'],
      title: body.title ?? '',
      description: body.description ?? '',
      reproduction_notes: body.reproduction_notes,
      tags: body.tags,
      osborn_version: body.osborn_version || 'web',
      voice_mode: body.voice_mode,
      // Context stored on the row for triage; deliberately NOT passed to the mirror.
      session_id: body.session_id,
      sandbox_id: body.sandbox_id,
      metadata: body.metadata,
    },
    { id: user.id, email: user.email },
  )
  if (!built.ok) return NextResponse.json({ ok: false, error: built.error }, { status: 400 })

  const { data: inserted, error } = await supabase
    .from('bug_reports')
    .insert(built.row)
    .select('id')
    .single()
  if (error) {
    console.error('[report] insert failed', error)
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  }

  // Best-effort GitHub mirror — privacy-safe by the MirrorReport allowlist. A
  // failure here (token missing, GitHub down) never fails the user's report.
  const mirror = await mirrorReportToGitHub({
    type: built.row.type,
    severity: built.row.severity,
    title: built.row.title,
    description: built.row.description,
    reproduction_notes: built.row.reproduction_notes,
    tags: built.row.tags,
    osborn_version: built.row.osborn_version,
    voice_mode: built.row.voice_mode,
  })
  if (!mirror.ok) console.error('[report] github mirror failed:', mirror.error)

  return NextResponse.json({ ok: true, id: inserted?.id })
}
