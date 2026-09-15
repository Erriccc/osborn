import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createSupabaseServer } from '@/lib/supabase-server'

/**
 * GET/POST /api/favorites — user-level favorite files, stored server-side so
 * they sync across devices and persist across sessions.
 *
 * Storage: one JSON blob per user at `{userId}/_favorites.json` in the
 * `osborn-storage` bucket. User-scoped (not session-scoped) so stars survive
 * session changes. Guests (no auth cookie) rely on localStorage only.
 *
 * Auth: user identity is verified via the cookie-based Supabase client.
 * Storage ops use a plain anon client (same pattern as /api/upload) because
 * osborn-storage permits anon writes and the cookie client's RLS context
 * was silently blocking upserts to the user-root path.
 */

const BUCKET = 'osborn-storage'

/** User-level favorites key — one blob per user, survives across sessions. */
const keyFor = (userId: string): string => `${userId}/_favorites.json`

/** Plain anon storage client — same as /api/upload which is proven to work. */
function storageClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )
}

export async function GET(req: NextRequest) {
  // Identify the user via auth cookie.
  let userId: string
  try {
    const supabase = await createSupabaseServer()
    const { data: u } = await supabase.auth.getUser()
    if (!u.user) return NextResponse.json({ favorites: [] })
    userId = u.user.id
  } catch {
    return NextResponse.json({ favorites: [], exists: false })
  }

  const key = keyFor(userId)
  const { data, error } = await storageClient().storage.from(BUCKET).download(key)
  if (error || !data) return NextResponse.json({ favorites: [] })
  try {
    const parsed = JSON.parse(await data.text())
    return NextResponse.json({ favorites: Array.isArray(parsed) ? parsed : [], exists: true })
  } catch {
    return NextResponse.json({ favorites: [], exists: false })
  }
}

export async function POST(req: NextRequest) {
  // Identify the user via auth cookie.
  let userId: string
  try {
    const supabase = await createSupabaseServer()
    const { data: u } = await supabase.auth.getUser()
    if (!u.user) return NextResponse.json({ success: false, error: 'Not authenticated' }, { status: 401 })
    userId = u.user.id
  } catch {
    return NextResponse.json({ success: false, error: 'Supabase not configured' }, { status: 503 })
  }

  let favorites: unknown
  try {
    const body = await req.json()
    favorites = body?.favorites
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 })
  }
  if (!Array.isArray(favorites)) {
    return NextResponse.json({ success: false, error: '`favorites` must be an array' }, { status: 400 })
  }

  const key = keyFor(userId)
  const blob = new Blob([JSON.stringify(favorites)], { type: 'application/json' })
  const { error } = await storageClient().storage
    .from(BUCKET)
    .upload(key, blob, { upsert: true, contentType: 'application/json', cacheControl: '0' })

  if (error) {
    console.error('[favorites] upload failed:', error.message)
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
  return NextResponse.json({ success: true, count: (favorites as unknown[]).length })
}
