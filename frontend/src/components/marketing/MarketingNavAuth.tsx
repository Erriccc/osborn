'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createSupabaseBrowser } from '@/lib/supabase-browser'

/**
 * Auth-aware CTA for the marketing shell. MarketingShell is a pure server
 * component, so the login/dashboard swap lives in this small client island: a
 * signed-in visitor on /blog, /compare, /use-cases, /industries now sees
 * "Dashboard" instead of "Log in" (the shell previously always said "Log in",
 * even when signed in — a wayfinding bug a stranger notices immediately).
 */
export default function MarketingNavAuth() {
  const [authed, setAuthed] = useState<boolean | null>(null)

  useEffect(() => {
    const supabase = createSupabaseBrowser()
    supabase.auth.getSession().then(({ data }) => setAuthed(!!data.session)).catch(() => setAuthed(false))
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => setAuthed(!!session))
    return () => sub.subscription.unsubscribe()
  }, [])

  // Until we know (SSR + first client paint), render the neutral "Log in" so the
  // server and client markup match (no hydration mismatch, no layout shift).
  const toDashboard = authed === true

  return (
    <Link
      href={toDashboard ? '/dashboard' : '/login'}
      className="rounded-full border border-[var(--border)] px-4 py-1.5 text-[var(--text-primary)] transition-colors hover:border-[var(--accent)]"
    >
      {toDashboard ? 'Dashboard' : 'Log in'}
    </Link>
  )
}
