import { NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies, headers } from 'next/headers'

/**
 * Resolve the public origin (scheme + host) the browser used to reach this handler.
 *
 * Why this exists: on Railway / any reverse-proxy host, `new URL(request.url).origin`
 * returns the INTERNAL container URL (e.g. `http://localhost:8080`) instead of the
 * public one (`https://www.voice-native.com`). Redirecting to the internal URL drops
 * the user on a broken `localhost:8080/` page. We trust the `x-forwarded-host` header
 * (set by Railway's edge proxy) and fall back to the standard `host` header, then to
 * the request URL as a last resort for local dev.
 */
function getPublicOrigin(request: Request, h: Headers): string {
  const forwardedHost = h.get('x-forwarded-host') || h.get('host')
  const forwardedProto = h.get('x-forwarded-proto') || (forwardedHost?.startsWith('localhost') ? 'http' : 'https')
  if (forwardedHost) return `${forwardedProto}://${forwardedHost}`
  return new URL(request.url).origin
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  const next = searchParams.get('next') ?? '/'
  const h = await headers()
  const origin = getPublicOrigin(request, h)

  if (code) {
    const cookieStore = await cookies()
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll()
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          },
        },
      }
    )

    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`)
    }
  }

  // Auth error — redirect to login with error
  return NextResponse.redirect(`${origin}/?error=auth`)
}
