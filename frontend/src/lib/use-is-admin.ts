'use client'

// ── Admin discoverability (#73 / #124) ────────────────────────────────────
// /admin is a standalone route; the dashboard account menu and the settings
// page each surface a link to it only when the SERVER confirms this user is in
// ADMIN_EMAILS. This is the ONE probe both of them use — they used to carry
// their own copies, which drifted (the dashboard gained a retry, settings kept
// the old one-shot version).
//
// Notes that matter:
//   • /api/admin/users is the real enforcement point. This flag only decides
//     whether the entry point is shown.
//   • A transient network/5xx failure is retried once and never silently
//     committed to "not admin", so a blip can't drop the entry on one visit and
//     restore it on the next.
//   • #140: never probe for a signed-out visitor — it just 401s and the entry
//     is irrelevant to a guest. Pass the resolved user (null while unknown).

import { useEffect, useState } from 'react'

/** True once the server has confirmed this user is an admin. `user` is the
 * resolved auth user (null for a guest / before auth resolves). */
export function useIsAdmin(user: { id?: string } | null | undefined): boolean {
  const [isAdmin, setIsAdmin] = useState(false)
  useEffect(() => {
    if (!user) { setIsAdmin(false); return }
    let cancelled = false
    const probe = async (retry: boolean): Promise<void> => {
      try {
        const r = await fetch('/api/admin/users')
        if (cancelled) return
        if (r.ok) { setIsAdmin(true); return }
        // 401/403 is a definitive "not an admin" — settle on it.
        if (r.status === 401 || r.status === 403) return
        if (retry) return probe(false) // transient server error — retry once
      } catch {
        if (cancelled) return
        if (retry) return probe(false) // transient network blip — retry once
      }
    }
    probe(true)
    return () => { cancelled = true }
  }, [user])
  return isAdmin
}
