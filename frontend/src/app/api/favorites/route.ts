import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServer } from '@/lib/supabase-server'

/**
 * GET/POST /api/favorites — user-level favorite files, stored server-side so
 * they sync across devices and persist across sessions.
 *
 * Storage: one JSON blob per user at `{userId}/_favorites.json` in the
 * `osborn-storage` bucket. User-scoped (not session-scoped) so stars survive
 * session changes. Guests (no auth cookie) rely on localStorage only.
 */

const BUCKET = 'osborn-storage'

/** User-level favorites key — one blob per user, survives across sessions. */
const keyFor = (userId: string): string => `${userId}/_favorites.json`

export async function GET(req: NextRequest) {
  let supabase
  try {
    supabase = await createSupabaseServer()
  } catch {
    return NextResponse.json({ favorites: [], exists: false })
  }
  const { data: u } = await supabase.auth.getUser()
  if (!u.user) return NextResponse.json({ favorites: [] })

  const key = keyFor(u.user.id)

  const { data, error } = await supabase.storage.from(BUCKET).download(key)
  if (error || !data) return NextResponse.json({ favorites: [] })
  try {
    const parsed = JSON.parse(await data.text())
    return NextResponse.json({ favorites: Array.isArray(parsed) ? parsed : [], exists: true })
  } catch {
    return NextResponse.json({ favorites: [], exists: false })
  }
}

export async function POST(req: NextRequest) {
  let supabase
  try {
    supabase = await createSupabaseServer()
  } catch {
    return NextResponse.json({ success: false, error: 'Supabase not configured' }, { status: 503 })
  }
  const { data: u } = await supabase.auth.getUser()
  if (!u.user) return NextResponse.json({ success: false, error: 'Not authenticated' }, { status: 401 })

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

  const key = keyFor(u.user.id)

  const blob = new Blob([JSON.stringify(favorites)], { type: 'application/json' })
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(key, blob, { upsert: true, contentType: 'application/json', cacheControl: '0' })

  if (error) {
    console.error('[favorites] upload failed:', error.message)
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
  return NextResponse.json({ success: true, count: favorites.length })
}
