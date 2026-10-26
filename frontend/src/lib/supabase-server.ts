import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { cookies, headers } from 'next/headers'

/**
 * Server-side Supabase client for route handlers.
 *
 * Web clients authenticate via cookies (the SSR client). Native clients have no
 * cookies — they send `Authorization: Bearer <access_token>`. When that header
 * is present we build a plain client scoped to that token so `auth.getUser()`
 * and RLS queries resolve the native caller. Cookie behavior is unchanged.
 */
export async function createSupabaseServer() {
  const hdrs = await headers()
  const authHeader = hdrs.get('authorization')

  if (authHeader?.startsWith('Bearer ')) {
    return createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        global: { headers: { Authorization: authHeader } },
        auth: { persistSession: false, autoRefreshToken: false },
      }
    )
  }

  const cookieStore = await cookies()
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // Server component — can't set cookies, ignore
          }
        },
      },
    }
  )
}
