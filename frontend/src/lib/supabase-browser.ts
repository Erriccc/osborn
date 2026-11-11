import { createBrowserClient } from '@supabase/ssr'
import type { User } from '@supabase/supabase-js'

export function createSupabaseBrowser() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}

/**
 * Current signed-in user, resilient to a stale access token.
 *
 * `auth.getUser()` sends the *current* access token to the Auth server to
 * validate it but does NOT refresh it. On a cold page load a valid session
 * whose access token has expired (normal after ~1h) makes getUser() resolve to
 * null — which surfaces as "No account connected" or a bogus bounce to /login
 * even though the refresh token is still good. `auth.getSession()` refreshes an
 * expired access token from the refresh token and returns the live user, so
 * client-side UI gating should prefer it; we fall back to getUser() only when
 * there is genuinely no local session. (Server-side code keeps using getUser(),
 * which the middleware refreshes per request — do not swap those.)
 */
export async function getBrowserUser(
  client: ReturnType<typeof createSupabaseBrowser>
): Promise<User | null> {
  try {
    const { data: { session } } = await client.auth.getSession()
    if (session?.user) return session.user
  } catch {
    /* fall through to getUser() */
  }
  try {
    const { data: { user } } = await client.auth.getUser()
    return user ?? null
  } catch {
    return null
  }
}
