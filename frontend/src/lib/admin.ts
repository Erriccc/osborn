import type { User } from '@supabase/supabase-js'
import { createSupabaseServer } from './supabase-server'

/**
 * admin.ts — server-side admin gate.
 *
 * Access is an email allowlist: the ADMIN_EMAILS env var holds a comma-
 * separated list (e.g. "founder@gmail.com,ops@example.com"). It is read
 * SERVER-SIDE on every request — the /admin page's own gate is cosmetic;
 * the /api/admin/* routes are the enforcement point.
 */

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false
  const allowed = (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
  return allowed.includes(email.trim().toLowerCase())
}

/** Thrown by requireAdmin — `status` is the HTTP code to answer with. */
export class AdminAuthError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'AdminAuthError'
    this.status = status
  }
}

/**
 * Authenticate with the cookie client and enforce the admin allowlist.
 * Returns the signed-in admin user, or throws an AdminAuthError (401 if not
 * signed in, 403 if signed in but not an admin) shaped for
 * NextResponse.json({ error }, { status }).
 */
export async function requireAdmin(): Promise<User> {
  const supabase = await createSupabaseServer()
  const { data, error } = await supabase.auth.getUser()
  const user = data?.user
  if (error || !user) throw new AdminAuthError('Not authenticated', 401)
  if (!isAdminEmail(user.email)) throw new AdminAuthError('Admin access required', 403)
  return user
}
