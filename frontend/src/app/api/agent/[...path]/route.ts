/**
 * Authenticated proxy for the agent's public HTTP reads.
 *
 * The agent listens on 0.0.0.0:8741 (public via fly.toml). Several read routes
 * (`/sessions`, `/session-messages`) returned real session content to anyone who
 * knew a machine's fly.dev address. Rather than hand the per-user agent token to
 * the browser, the browser now calls THIS route; we resolve the signed-in user's
 * own machine + sync token server-side (RLS-scoped) and forward with the Bearer
 * the agent requires. The agent fail-closes these routes, so a direct hit to the
 * fly.dev address without the token is now rejected.
 *
 * Deliberately tight: only the paths in PROXYABLE_GET are forwarded; everything
 * else 404s here. Dangerous/stateful routes (restart, editor, canvas, export)
 * are NOT proxied — they keep their own gates.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServer } from '@/lib/supabase-server'

// Single-segment GET reads the browser needs. Keep TIGHT.
const PROXYABLE_GET = new Set(['sessions', 'session-messages'])

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params
  const sub = path?.[0] ?? ''
  if (path.length !== 1 || !PROXYABLE_GET.has(sub)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const supabase = await createSupabaseServer()
  const { data: auth } = await supabase.auth.getUser()
  const user = auth?.user
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  // The user's own machine + token (RLS: a user can read only their own row).
  const { data: inst } = await supabase
    .from('instances')
    .select('sandbox_url, sync_token')
    .eq('user_id', user.id)
    .single()
  const base = (inst?.sandbox_url as string | null | undefined)?.replace(/\/$/, '')
  const token = inst?.sync_token as string | null | undefined
  if (!base) return NextResponse.json({ error: 'No machine for this account' }, { status: 503 })

  const target = `${base}/${sub}${req.nextUrl.search}`
  try {
    const upstream = await fetch(target, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(15000),
      cache: 'no-store',
    })
    const body = await upstream.text()
    return new NextResponse(body, {
      status: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' },
    })
  } catch {
    return NextResponse.json({ error: 'Agent unreachable' }, { status: 502 })
  }
}
