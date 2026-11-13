import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

/**
 * POST /api/demo-access — email gate for free/demo ("Connect without account")
 * usage. The login page collects the visitor's email before starting a guest
 * session; this route validates + upserts it into public.demo_leads.
 *
 * Guests have NO Supabase session, so the write cannot go through a caller's
 * own client. It prefers public.record_demo_lead() — a SECURITY DEFINER upsert
 * granted to anon (migration 014) — because SUPABASE_SERVICE_ROLE_KEY is not set
 * on Railway; the service-role client is the fallback. RLS is enabled on
 * demo_leads with NO policies, so these two are the only write paths. Never
 * expose SUPABASE_SERVICE_ROLE_KEY to the client.
 *
 * Recording the lead must never cost the visitor the session: the login page
 * already proceeds when this route is unreachable, so a store that is missing or
 * failing answers ok with stored:false (and logs) rather than turning a visitor
 * away. Only a bad email (400) or the rate limit (429) refuses.
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

/**
 * Record the lead. Returns false when it could not be stored — never throws, so
 * a store outage cannot reach the visitor.
 */
async function recordLead(email: string): Promise<boolean> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || (!anon && !service)) {
    console.error('[demo-access] no Supabase url/key configured; lead not stored')
    return false
  }

  // 1) SECURITY DEFINER RPC as anon (works without the service-role key).
  if (anon) {
    try {
      const { error } = await createClient(url, anon, { auth: { persistSession: false } })
        .rpc('record_demo_lead', { p_email: email })
      if (!error) return true
      // Migration 014 not applied yet -> fall through to the service client.
      if (error.code !== 'PGRST202' && error.code !== '42883') {
        console.error('[demo-access] record_demo_lead failed:', error.message)
      }
    } catch (err) {
      console.error('[demo-access] record_demo_lead threw:', err)
    }
  }

  if (!service) return false

  // 2) Service-role upsert, keeping the earliest created_at.
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

    if (error) {
      console.error('[demo-access] write failed:', error.message)
      return false
    }
    return true
  } catch (err) {
    console.error('[demo-access] write threw:', err)
    return false
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

  return NextResponse.json({ ok: true, stored: await recordLead(email) })
}
