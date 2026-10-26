import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

/**
 * POST /api/demo-access — email gate for free/demo ("Connect without account")
 * usage. The login page collects the visitor's email before starting a guest
 * session; this route validates + upserts it into public.demo_leads.
 *
 * Guests have NO Supabase session, so the write must use the SERVICE ROLE key.
 * RLS is enabled on demo_leads with NO policies — this route is the only write
 * path. Never expose SUPABASE_SERVICE_ROLE_KEY to the client.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

/** Best-effort per-IP rate limit: 10 requests per minute (module-scoped Map). */
const RATE_LIMIT = 10
const RATE_WINDOW_MS = 60_000
const hits = new Map<string, number[]>()

function rateLimited(ip: string): boolean {
  const now = Date.now()
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS)
  if (recent.length >= RATE_LIMIT) {
    hits.set(ip, recent)
    return true
  }
  recent.push(now)
  hits.set(ip, recent)
  return false
}

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

export async function POST(req: NextRequest) {
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  if (rateLimited(ip)) {
    return NextResponse.json({ ok: false, error: 'Too many attempts. Try again shortly.' }, { status: 429 })
  }

  let email: string
  try {
    const body = await req.json()
    email = String(body?.email ?? '').trim().toLowerCase()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request.' }, { status: 400 })
  }

  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ ok: false, error: 'Enter a valid email address.' }, { status: 400 })
  }

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[demo-access] SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_URL not configured')
    return NextResponse.json({ ok: false, error: 'Server not configured.' }, { status: 500 })
  }

  // Upsert keeping earliest created_at: on conflict, only bump last_seen_at.
  const sb = serviceClient()
  const { data: existing } = await sb
    .from('demo_leads')
    .select('email')
    .eq('email', email)
    .maybeSingle()

  const { error } = existing
    ? await sb.from('demo_leads').update({ last_seen_at: new Date().toISOString() }).eq('email', email)
    : await sb.from('demo_leads').insert({ email, source: 'login' })

  if (error) {
    console.error('[demo-access] write failed:', error.message)
    return NextResponse.json({ ok: false, error: 'Could not save email.' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
