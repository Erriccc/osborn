import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServer } from '@/lib/supabase-server'

/**
 * GET/POST /api/favorites — per-user favorite session files, stored server-side
 * so they SYNC ACROSS DEVICES (localStorage is per-device; a user favoriting on
 * their phone should see the same stars on their laptop).
 *
 * Storage: a single JSON blob per user at `{userId}/_favorites.json` in the
 * existing `osborn-storage` bucket — no new table/migration. It lives directly
 * under the userId prefix (not under a session), so it never shows up in the
 * session-file listing (`/api/session-files` walks `{userId}/{sessionId}/`).
 *
 * Guests (no auth cookie) get an empty list and rely on localStorage only.
 */

const BUCKET = 'osborn-storage'
const keyFor = (userId: string) => `${userId}/_favorites.json`

export async function GET() {
  let supabase
  try {
    supabase = await createSupabaseServer()
  } catch {
    return NextResponse.json({ favorites: [], exists: false })
  }
  const { data: u } = await supabase.auth.getUser()
  if (!u.user) return NextResponse.json({ favorites: [] })

  const { data, error } = await supabase.storage.from(BUCKET).download(keyFor(u.user.id))
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
    favorites = (await req.json())?.favorites
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 })
  }
  if (!Array.isArray(favorites)) {
    return NextResponse.json({ success: false, error: '`favorites` must be an array' }, { status: 400 })
  }

  const blob = new Blob([JSON.stringify(favorites)], { type: 'application/json' })
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(keyFor(u.user.id), blob, { upsert: true, contentType: 'application/json', cacheControl: '0' })

  if (error) {
    console.error('[favorites] upload failed:', error.message)
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
  return NextResponse.json({ success: true, count: favorites.length })
}
