import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createSupabaseAnon } from '@/lib/supabase-anon'

/**
 * POST /api/demo-access — email gate for free/demo ("Connect without account")
 * usage. The login page collects the visitor's email before starting a guest
 * session; this route validates + upserts it into public.demo_leads.
 *
 * Guests have NO Supabase session, so the write cannot go through a caller's
 * own client. It prefers public.record_demo_lead() — a SECURITY DEFINER upsert
 * granted to anon (migration 015) — because SUPABASE_SERVICE_ROLE_KEY is not set
 * on Railway; the service-role client is the fallback. RLS is enabled on
 * demo_leads with NO policies, so these two are the only write paths. Never
 * expose SUPABASE_SERVICE_ROLE_KEY to the client.
 *
 * Recording the lead must never cost the visitor the session: the login page
 * already proceeds when this route is unreachable, so a missing or failing store
 * logs and answers ok rather than turning a visitor away. Only a bad email (400)
 * or the rate limit (429) refuses. The anon RPC is also callable directly with
 * the public anon key, so the per-IP limit below shapes traffic, it does not
 * protect the table.
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

/** Record the lead. Never throws, so a store outage cannot reach the visitor;
 *  every failure is logged, because a dropped lead is invisible otherwise. */
async function recordLead(email: string): Promise<void> {
  // 1) SECURITY DEFINER RPC as anon (works without the service-role key).
  //    createSupabaseAnon pins db.schema = public, which an RPC needs here.
  const anon = createSupabaseAnon()
  if (anon) {
    try {
      const { error } = await anon.rpc('record_demo_lead', { p_email: email })
      if (!error) return
      // Includes PGRST202/42883 — migration 015 not applied, every lead dropped.
      console.error('[demo-access] record_demo_lead failed:', error.message)
    } catch (err) {
      console.error('[demo-access] record_demo_lead threw:', err)
    }
  }

  // 2) Service-role upsert, keeping the earliest created_at. Unset on Railway,
  //    so this is the path for local and self-hosted deployments.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !service) {
    console.error('[demo-access] lead not stored: no RPC and no service-role key')
    return
  }
  try {
    const sb = createClient(url, service, { auth: { persistSession: false } })
    const { data: existing } = await sb
      .from('demo_leads')
      .select('email')
      .eq('email', email)
      .maybeSingle()

    const { error } = existing
      ? await sb.from('demo_leads').update({ last_seen_at: new Date().toISOString() }).eq('email', email)
      : await sb.from('demo_leads').insert({ email, source: 'login' })

    if (error) console.error('[demo-access] write failed:', error.message)
  } catch (err) {
    console.error('[demo-access] write threw:', err)
  }
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

  await recordLead(email)
  return NextResponse.json({ ok: true })
}
