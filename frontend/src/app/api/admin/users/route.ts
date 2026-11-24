import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { requireAdmin, AdminAuthError } from '@/lib/admin'
import { isMachinesConfigured, readMachineActivity } from '@/lib/machines'

/**
 * GET /api/admin/users — the data behind the /admin users view.
 *
 * Auth is enforced SERVER-SIDE on every request: the caller must be signed
 * in (cookie session via createSupabaseServer) AND their email must be in
 * the ADMIN_EMAILS allowlist (lib/admin.ts). The /admin page's own gate is
 * cosmetic — this route is the enforcement point.
 *
 * Reads users (auth admin API) + public.instances with the SERVICE ROLE key (both are
 * closed to the anon/authed clients; RLS nowhere helps across users). The
 * response carries names, dates, and machine bookkeeping only — never keys,
 * secrets, or tokens.
 */

export async function GET() {
  try {
    await requireAdmin()
  } catch (err) {
    const status = err instanceof AdminAuthError ? err.status : 403
    const message = err instanceof Error ? err.message : 'Admin access required'
    return NextResponse.json({ error: message }, { status })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    console.error('[admin/users] NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured')
    return NextResponse.json({ error: 'Server not configured' }, { status: 500 })
  }

  const sb = createClient(url, serviceKey, { auth: { persistSession: false } })

  // auth.users is not exposed to the REST API; the admin API reads it with the service role.
  const { data: listed, error: usersError } = await sb.auth.admin.listUsers({ page: 1, perPage: 200 })
  if (usersError) {
    console.error('[admin/users] auth.admin.listUsers failed:', usersError.message)
    return NextResponse.json({ error: 'Could not read users' }, { status: 500 })
  }
  const authUsers = [...(listed?.users ?? [])].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))

  const { data: instances, error: instancesError } = await sb
    .from('instances')
    .select('user_id, sandbox_id, sandbox_status, status, last_seen')
  if (instancesError) {
    console.error('[admin/users] instances read failed:', instancesError.message)
    return NextResponse.json({ error: 'Could not read machines' }, { status: 500 })
  }

  // Join in JS: instances has one row per user (sandbox upserts target
  // onConflict: 'user_id'), so a Map is a faithful join.
  const instanceByUser = new Map(
    (instances ?? []).map((row) => [row.user_id as string, row]),
  )

  // The stored status is only as fresh as the last write (a machine stopped by Fly's idle exit never updates
  // it), so ask Fly for the live state. A read that fails, times out (6 s) or has no Fly to ask returns no
  // `machine_state`, and the page then marks the stored value as stored.
  const flyConfigured = isMachinesConfigured()
  const live = new Map(await Promise.all(
    (instances ?? []).map(async (row) => {
      const id = row.sandbox_id as string | null
      if (!id || !flyConfigured) return [row.user_id as string, null] as const
      return [row.user_id as string, await Promise.race([readMachineActivity(id), new Promise<null>((r) => setTimeout(() => r(null), 6000))])] as const
    }),
  ))

  const users = (authUsers ?? []).map((u) => {
    const instance = instanceByUser.get(u.id as string)
    const machine = live.get(u.id as string)
    // Supabase records last_sign_in_at only when someone signs in again, so a saved session never moves it.
    // "Last active" is the newest of when the app last provisioned, started, synced or connected to the machine, in the app or by phone (last_seen) and the
    // machine's last start or exit (Fly).
    const activeAt = Math.max(Date.parse(instance?.last_seen as string) || 0, machine?.lastEventAt ?? 0)
    return {
      id: u.id,
      email: u.email ?? null,
      created_at: u.created_at ?? null,
      last_sign_in_at: u.last_sign_in_at ?? null,
      sandbox_id: instance?.sandbox_id ?? null,
      sandbox_status: instance?.sandbox_status ?? null,
      instance_status: instance?.status ?? null,
      machine_state: machine?.status ?? null,
      // The configured image version (read off the machine object Fly already returned — no extra probe).
      osborn_version: machine?.version ?? null,
      last_active: activeAt ? new Date(activeAt).toISOString() : null,
    }
  })

  return NextResponse.json({ users })
}
