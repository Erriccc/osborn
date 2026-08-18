import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServer } from '@/lib/supabase-server'

/**
 * GET/POST /api/favorites — per-session favorite files, stored server-side so
 * they sync across devices (localStorage is per-device).
 *
 * Storage: one JSON blob per session at `{userId}/{sessionId}/_favorites.json`
 * in the existing `osborn-storage` bucket — no new table/migration. The path
 * lives inside the session prefix so it is naturally isolated from other
 * sessions; it will NOT appear in the session-file listing because
 * `/api/session-files` only returns objects with known file extensions (plans,
 * artifacts, etc.) and skips `_favorites.json`.
 *
 * Backward-compat: if sessionId is absent (old callers / guests), the route
 * returns an empty list rather than falling back to the old global blob. This
 * is the safe choice — surfacing a different session's favorites would be the
 * original bug.
 *
 * Guests (no auth cookie) get an empty list and rely on localStorage only.
 */

const BUCKET = 'osborn-storage'

/**
 * Returns the per-session storage key when sessionId is provided, or null when
 * it is absent so the caller can decide to return an empty response rather than
 * touching unscoped data.
 */
const keyFor = (userId: string, sessionId: string | null): string | null => {
  if (!sessionId) return null
  return `${userId}/${sessionId}/_favorites.json`
}

export async function GET(req: NextRequest) {
  let supabase
  try {
    supabase = await createSupabaseServer()
  } catch {
    return NextResponse.json({ favorites: [], exists: false })
  }
  const { data: u } = await supabase.auth.getUser()
  if (!u.user) return NextResponse.json({ favorites: [] })

  const sessionId = req.nextUrl.searchParams.get('sessionId') || null
  const key = keyFor(u.user.id, sessionId)
  // No sessionId → return empty rather than leaking a different session's data.
  if (!key) return NextResponse.json({ favorites: [], exists: false })

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
  let sessionId: string | null = null
  try {
    const body = await req.json()
    favorites = body?.favorites
    sessionId = typeof body?.sessionId === 'string' ? body.sessionId : null
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 })
  }
  if (!Array.isArray(favorites)) {
    return NextResponse.json({ success: false, error: '`favorites` must be an array' }, { status: 400 })
  }

  const key = keyFor(u.user.id, sessionId)
  // No sessionId → refuse to write to an unscoped path.
  if (!key) {
    return NextResponse.json({ success: false, error: 'sessionId is required' }, { status: 400 })
  }

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
