import { NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies, headers } from 'next/headers'
// Redirecting to the internal container URL would drop the user on a broken page.
import { getPublicOrigin } from '@/lib/public-origin'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  const h = await headers()
  const origin = getPublicOrigin(request, h)
  // Same-site paths only: a raw `next` glued onto the origin can leave the site.
  let next = '/'
  try { const u = new URL(searchParams.get('next') ?? '/', origin); if (u.origin === new URL(origin).origin) next = u.pathname + u.search + u.hash } catch { /* keep '/' */ }

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
