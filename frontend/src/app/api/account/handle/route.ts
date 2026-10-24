import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServer } from '@/lib/supabase-server'

/**
 * PUT /api/account/handle — set the signed-in user's PUBLIC HANDLE
 * (profiles.username). This drives every public URL: /p/{handle}/{slug},
 * the author index /p/{handle}, the blog, and the sitemap (public_content
 * joins profiles.username at read time, so renames propagate instantly).
 *
 * Validation: 3-30 chars, lowercase a-z 0-9 and hyphens (matches the DB
 * check constraint profiles_username_shape). Uniqueness is enforced by
 * profiles_username_key — a duplicate returns 409 so the UI can suggest one.
 */

const HANDLE_RE = /^[a-z0-9-]{3,30}$/

export async function PUT(req: NextRequest) {
  let supabase
  try {
    supabase = await createSupabaseServer()
    const { data: u } = await supabase.auth.getUser()
    if (!u.user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    var userId: string = u.user.id
  } catch {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 })
  }

  let handle: unknown
  try {
    handle = (await req.json())?.handle
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (typeof handle !== 'string') return NextResponse.json({ error: '`handle` is required' }, { status: 400 })
  const clean = handle.trim().toLowerCase().replace(/[^a-z0-9-]/g, '')
  if (clean !== handle.trim()) {
    return NextResponse.json({ error: 'Only lowercase letters, numbers, and hyphens (no spaces or @)' }, { status: 400 })
  }
  if (!HANDLE_RE.test(clean)) {
    return NextResponse.json({ error: '3-30 characters: lowercase letters, numbers, hyphens' }, { status: 400 })
  }

  const { error } = await supabase
    .from('profiles')
    .update({ username: clean })
    .eq('id', userId)

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: `"${clean}" is taken — try another` }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 400 })
  }

  return NextResponse.json({ handle: clean })
}
