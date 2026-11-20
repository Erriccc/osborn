'use client'

// The ONE client probe for admin discoverability (#73 / #124), shared by the
// dashboard account menu and the settings page — they used to carry their own
// copies, which drifted. `lib/admin.ts` owns the real gate but is server-only
// (it reads ADMIN_EMAILS and builds a cookie client), so a client surface can
// only ask the server. It asks /api/admin/me, which answers `{ admin }` with a
// 200 for everyone; the /api/admin/* data routes stay the enforcement point.

import { useEffect, useState } from 'react'

/** True once the server has confirmed this user is an admin. A guest, and the
 * window before auth resolves, is never probed (#140: it would just 401). A
 * transient network/5xx failure is retried once and never committed to "not
 * admin", so a blip can't drop the entry on one visit and restore it the next.
 * Keyed on the user id, so an auth-object swap for the same person does not
 * re-fetch. */
export function useIsAdmin(user: { id?: string } | null | undefined): boolean {
  const [isAdmin, setIsAdmin] = useState(false)
  const userId = user?.id ?? null
  useEffect(() => {
    if (!userId) { setIsAdmin(false); return }
    let cancelled = false
    const probe = async (retry: boolean): Promise<void> => {
      try {
        const r = await fetch('/api/admin/me', { cache: 'no-store' })
        if (cancelled) return
        // A 200 is definitive either way — settle on it. Writing false matters: an
        // admin replaced by a non-admin inside the same mount would otherwise keep
        // the stale Admin entry.
        if (r.ok) {
          const d = await r.json().catch(() => null)
          if (cancelled) return
          if (d && typeof d.admin === 'boolean') { setIsAdmin(d.admin); return }
        }
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
