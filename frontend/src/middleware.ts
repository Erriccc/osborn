import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'

export async function middleware(request: NextRequest) {
  // Skip middleware for public/static paths. `/p/` = public article pages,
  // `/sitemap.xml` + `/robots.txt` = crawler files — all fully public, so they
  // never pay the Supabase getUser() cost and stay statically cacheable.
  const { pathname } = request.nextUrl
  if (
    pathname.startsWith('/auth/') ||
    pathname.startsWith('/api/') ||
    pathname.startsWith('/p/') ||
    pathname === '/sitemap.xml' ||
    pathname === '/robots.txt'
  ) {
    return NextResponse.next()
  }

  // ── Landing A/B: split homepage traffic between the current landing (v1) and
  // the cinematic /v2. A persistent cookie keeps each visitor in one bucket so
  // the experience is stable across visits; `?lp=v1|v2` forces + pins a variant
  // (shareable preview link). Crawlers always get v1 so the canonical homepage
  // stays stable for indexing. Variant 'b' is served by REWRITING / → /v2 (the
  // URL stays `/`), so conversion is comparable on the same address.
  if (pathname === '/') {
    const LP_COOKIE = 'vn-lp'
    const ua = request.headers.get('user-agent')?.toLowerCase() || ''
    const isBot = /bot|crawler|spider|crawling|slurp|bingpreview|facebookexternalhit|embed/.test(ua)

    const override = request.nextUrl.searchParams.get('lp') // 'v1' | 'v2'
    let variant = request.cookies.get(LP_COOKIE)?.value // 'v1' | 'v2' | undefined
    let assigned = false

    if (override === 'v1' || override === 'v2') {
      variant = override
      assigned = true
    } else if (isBot) {
      variant = 'v1' // never bucket crawlers; keep indexing deterministic
    } else if (variant !== 'v1' && variant !== 'v2') {
      variant = Math.random() < 0.5 ? 'v2' : 'v1'
      assigned = true
    }

    const res =
      variant === 'v2'
        ? NextResponse.rewrite(new URL('/v2', request.url))
        : NextResponse.next()
    // Persist the bucket (90 days) when newly assigned or explicitly overridden.
    if (assigned && !isBot) {
      res.cookies.set(LP_COOKIE, variant, {
        path: '/',
        maxAge: 60 * 60 * 24 * 90,
        sameSite: 'lax',
      })
    }
    return res
  }

  let supabaseResponse = NextResponse.next({ request })

  try {
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll()
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value }) =>
              request.cookies.set(name, value)
            )
            supabaseResponse = NextResponse.next({ request })
            cookiesToSet.forEach(({ name, value, options }) =>
              supabaseResponse.cookies.set(name, value, options)
            )
          },
        },
      }
    )

    // Refresh session token if present — with timeout to avoid blocking.
    // Capture the user so we can bounce authed visitors off the public
    // marketing/login routes straight into the app (Googlebot has no session
    // cookie, so it always gets the full landing HTML — SEO-safe).
    const result = (await Promise.race([
      supabase.auth.getUser(),
      new Promise(resolve => setTimeout(() => resolve(null), 2000)),
    ])) as { data?: { user?: unknown } } | null
    const user = result?.data?.user ?? null
    // Only bounce authed visitors off /login (no point showing a login screen
    // to someone already signed in). The marketing landing at / stays viewable
    // when logged in — the nav shows "Open dashboard" instead of "Sign in".
    if (user && pathname === '/login') {
      return NextResponse.redirect(new URL('/dashboard', request.url))
    }
  } catch {
    // Supabase unreachable — let page handle auth state client-side
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
