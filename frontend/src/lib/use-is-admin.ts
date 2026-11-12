'use client'

// The ONE client probe for admin discoverability (#73 / #124), shared by the
// dashboard account menu and the settings page — they used to carry their own
// copies, which drifted. `lib/admin.ts` owns the real gate but is server-only
// (it reads ADMIN_EMAILS and builds a cookie client), so a client surface can
// only ask the route, which stays the enforcement point.

import { useEffect, useState } from 'react'

/** True once the server has confirmed this user is an admin. A guest, and the
 * window before auth resolves, is never probed (#140: it would just 401). A
 * transient network/5xx failure is retried once and never committed to "not
 * admin", so a blip can't drop the entry on one visit and restore it the next.
 * Keyed on the user id, so an auth-object swap for the same person does not
 * re-fetch the route. */
export function useIsAdmin(user: { id?: string } | null | undefined): boolean {
  const [isAdmin, setIsAdmin] = useState(false)
  const userId = user?.id ?? null
  useEffect(() => {
    if (!userId) { setIsAdmin(false); return }
    let cancelled = false
    const probe = async (retry: boolean): Promise<void> => {
      try {
        const r = await fetch('/api/admin/users', { cache: 'no-store' })
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
  }, [userId])
  return isAdmin
}
