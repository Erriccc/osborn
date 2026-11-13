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
import { knownSandboxClaim } from '@/lib/sandbox-claims'
import { execInSprite } from '@/lib/machines'
import { randomUUID } from 'node:crypto'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  try {
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

    // A report filed by a cloud agent (its context carries a machine id) gets the log
    // tail of the reporter's own machine (best-effort; the report files without it).
    // The exec target is always the caller's recorded, undisputed sandbox, never an
    // id from the body, which would let a caller exec into any machine.
    const id = randomUUID()
    let logUrl: string | null = null
    try {
      const known = body.sandbox_id ? await knownSandboxClaim(supabase, user.id) : null
      if (known?.id && known.claim === 'mine') {
        const logResult = await execInSprite(known.id, 'sh', ['-c', 'tail -500 /workspace/osborn.log 2>/dev/null || echo "log unavailable"'], 15)
        if (logResult.output) {
          const storagePath = `bug-logs/${id}.log`
          const { error: upErr } = await supabase.storage
            .from('osborn-storage')
            .upload(storagePath, logResult.output, { contentType: 'text/plain', upsert: false })
          if (!upErr) logUrl = storagePath
          else console.error('[report] log upload failed', upErr)
        }
      }
    } catch (e) {
      console.error('[report] log tail failed:', e)
    }

    const { data: inserted, error } = await supabase
      .from('bug_reports')
      .insert({ id, ...built.row, log_url: logUrl })
      .select('id')
      .single()
    if (error) {
      console.error('[report] insert failed', error)
      // Surface the REAL Postgres/PostgREST error (code + message [+ hint]) so the
      // client can show WHY instead of a generic "Submit failed." — the common
      // production case is a missing table (code 42P01, or PGRST205 "Could not find
      // the table 'public.bug_reports' in the schema cache"). See migration 014.
      const parts = [error.code, error.message].filter(Boolean)
      const detail = parts.length ? parts.join(': ') : 'Database insert failed.'
      const full = error.hint ? `${detail} (hint: ${error.hint})` : detail
      return NextResponse.json(
        { ok: false, error: full, code: error.code ?? null, details: error.details ?? null },
        { status: 500 },
      )
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
  } catch (e) {
    // Any unexpected throw (e.g. Supabase client/cookie setup) must still return
    // JSON — otherwise the route emits an HTML error page and the client only sees
    // a bare "Submit failed." with no detail.
    console.error('[report] unexpected error', e)
    const msg = e instanceof Error ? e.message : 'Unexpected server error.'
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
