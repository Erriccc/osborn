import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseAnon } from '@/lib/supabase-anon'
import { isMissingFunction, serviceClient } from '@/lib/sandbox-claims'
import { createRateLimiter } from '@/lib/demo-rate-limit'

/**
 * POST /api/demo-access — email gate for free/demo ("Connect without account")
 * usage. The login page collects the visitor's email before starting a guest
 * session; this route validates + upserts it into public.demo_leads.
 *
 * A guest has no Supabase session, so this prefers record_demo_lead() — a
 * SECURITY DEFINER upsert granted to anon (migration 017) — because
 * SUPABASE_SERVICE_ROLE_KEY is not set on Railway; service-role is the fallback.
 *
 * Recording a lead must never cost the visitor the session, so a missing or
 * failing store logs and answers ok. Only a bad email (400) or the rate limit
 * (429) refuses — the login page still blocks the visitor on those.
 *
 * The limiter is not the lead store's protection: anyone can call record_demo_lead()
 * directly with the public anon key, and the leftmost x-forwarded-for is client-set (#296).
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

/** Best-effort per-IP rate limit: 10 valid requests per minute, at most 10k addresses held. */
const limiter = createRateLimiter({ limit: 10, windowMs: 60_000, maxKeys: 10_000 })

/** Record the lead. Never throws, so a store outage cannot reach the visitor. */
async function recordLead(email: string): Promise<void> {
  try {
    // 1) SECURITY DEFINER RPC as anon: the only write path a guest's role has.
    //    createSupabaseAnon pins db.schema = public, which the RPC needs.
    const anon = createSupabaseAnon()
    if (anon) {
      const { error } = await anon.rpc('record_demo_lead', { p_email: email })
      if (!error) return
      console.error(isMissingFunction(error)
        ? '[demo-access] migration 017 is not applied; every lead is being dropped'
        : `[demo-access] record_demo_lead failed: ${error.message}`)
    }

    // 2) Service-role upsert, keeping the earliest created_at. The key is unset
    //    on Railway, so this is the local / self-hosted path.
    const sb = serviceClient()
    if (!sb) {
      console.error('[demo-access] lead not stored: no RPC and no service-role key')
      return
    }
    const { data: existing } = await sb.from('demo_leads').select('email').eq('email', email).maybeSingle()
    const { error } = existing
      ? await sb.from('demo_leads').update({ last_seen_at: new Date().toISOString() }).eq('email', email)
      : await sb.from('demo_leads').insert({ email, source: 'login' })
    if (error) console.error('[demo-access] write failed:', error.message)
  } catch (err) {
    console.error('[demo-access] lead not stored:', err)
  }
}

export async function POST(req: NextRequest) {
  // The key is client-influenced, so keep only something IP-shaped and short (bounds memory per key).
  const raw = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || ''
  const ip = /^[0-9a-fA-F:.]{2,45}$/.test(raw) ? raw : 'unknown'

  let email: string
  try {
    const body = await req.json()
    email = String(body?.email ?? '').trim().toLowerCase()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request.' }, { status: 400 })
  }

  if (email.length > 320 || !EMAIL_RE.test(email)) {
    return NextResponse.json({ ok: false, error: 'Enter a valid email address.' }, { status: 400 })
  }
  // Only a valid email counts toward the limit.
  if (limiter.limited(ip)) {
    return NextResponse.json({ ok: false, error: 'Too many attempts. Try again shortly.' }, { status: 429 })
  }

  await recordLead(email)
  return NextResponse.json({ ok: true })
}
