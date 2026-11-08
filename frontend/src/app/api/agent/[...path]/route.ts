/**
 * Authenticated proxy for the agent's public HTTP routes the browser needs.
 *
 * The agent listens on 0.0.0.0:8741 (public via fly.toml) and now fail-closes
 * its sensitive routes. Rather than hand the per-user agent token to the
 * browser, the browser calls THIS route; we resolve the signed-in user's own
 * machine + sync token server-side (RLS-scoped) and forward with the Bearer the
 * agent requires. A direct hit to the fly.dev address without the token is
 * rejected by the agent.
 *
 * Deliberately TIGHT — only the exact paths in the allowlists are forwarded;
 * everything else 404s here. Dangerous/stateful routes (restart, editor, canvas)
 * keep their own gates and are never proxied.
 *   GET:  sessions, session-messages, sessions/export-one (binary tar.gz)
 *   POST: sessions/import  (session-sharing import leg; binary body)
 */
import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServer } from '@/lib/supabase-server'

const PROXYABLE_GET = new Set(['sessions', 'session-messages', 'sessions/export-one'])
const PROXYABLE_POST = new Set(['sessions/import'])

// Resolve the signed-in user's own machine base URL + sync token. Returns an
// error NextResponse when unavailable, else { base, token }.
async function resolveMachine(): Promise<
  { base: string; token: string | null } | { error: NextResponse }
> {
  const supabase = await createSupabaseServer()
  const { data: auth } = await supabase.auth.getUser()
  const user = auth?.user
  if (!user) return { error: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  const { data: inst } = await supabase
    .from('instances')
    .select('sandbox_url, sync_token')
    .eq('user_id', user.id)
    .single()
  const base = (inst?.sandbox_url as string | null | undefined)?.replace(/\/$/, '')
  if (!base) return { error: NextResponse.json({ error: 'No machine for this account' }, { status: 503 }) }
  return { base, token: (inst?.sync_token as string | null | undefined) ?? null }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const joined = ((await params).path ?? []).join('/')
  if (!PROXYABLE_GET.has(joined)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const m = await resolveMachine()
  if ('error' in m) return m.error
  try {
    const upstream = await fetch(`${m.base}/${joined}${req.nextUrl.search}`, {
      headers: m.token ? { Authorization: `Bearer ${m.token}` } : {},
      signal: AbortSignal.timeout(20000),
      cache: 'no-store',
    })
    // Forward the raw body (JSON, or the binary tar.gz from export-one) as-is.
    return new NextResponse(await upstream.arrayBuffer(), {
      status: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' },
    })
  } catch {
    return NextResponse.json({ error: 'Agent unreachable' }, { status: 502 })
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const joined = ((await params).path ?? []).join('/')
  if (!PROXYABLE_POST.has(joined)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const m = await resolveMachine()
  if ('error' in m) return m.error
  const body = await req.arrayBuffer()
  try {
    const upstream = await fetch(`${m.base}/${joined}${req.nextUrl.search}`, {
      method: 'POST',
      headers: {
        ...(m.token ? { Authorization: `Bearer ${m.token}` } : {}),
        'Content-Type': req.headers.get('content-type') ?? 'application/octet-stream',
      },
      body,
      signal: AbortSignal.timeout(30000),
      cache: 'no-store',
    })
    return new NextResponse(await upstream.arrayBuffer(), {
      status: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' },
    })
  } catch {
    return NextResponse.json({ error: 'Agent unreachable' }, { status: 502 })
  }
}
