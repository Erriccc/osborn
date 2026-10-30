import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServer } from '@/lib/supabase-server'

/**
 * POST /api/content/update — save hand-typed edits to one of the caller's DRAFT
 * renditions (title / hook / body).
 *
 * Body: { itemId: string, title?: string, body?: string, hook?: string }
 *
 * Auth: the cookie-based server Supabase client carries the signed-in user's
 * JWT, so the SECURITY DEFINER function content_update_rendition (migration 009)
 * enforces owner-only + draft-only + rendition-only access itself. We never
 * trust an owner id from the client.
 *
 * Why this route exists: the Library inline editor let you type into
 * title/hook/body, but there was no save path — the edits lived only in React
 * state and were silently dropped when you published (publish used the stored
 * row). This wires the existing update function to a real request.
 */
export async function POST(req: NextRequest) {
  let supabase: Awaited<ReturnType<typeof createSupabaseServer>>
  try {
    supabase = await createSupabaseServer()
    const { data: u } = await supabase.auth.getUser()
    if (!u.user) return NextResponse.json({ success: false, error: 'Not authenticated' }, { status: 401 })
  } catch {
    return NextResponse.json({ success: false, error: 'Supabase not configured' }, { status: 503 })
  }

  let itemId: string
  let title: string
  let body: string
  let hook: string | null
  try {
    const b = await req.json()
    itemId = b?.itemId
    title = typeof b?.title === 'string' ? b.title : ''
    body = typeof b?.body === 'string' ? b.body : ''
    hook = typeof b?.hook === 'string' ? b.hook : null
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 })
  }

  if (!itemId || typeof itemId !== 'string') {
    return NextResponse.json({ success: false, error: '`itemId` is required' }, { status: 400 })
  }

  const { error } = await supabase.rpc('content_update_rendition', {
    p_item_id: itemId,
    p_title: title,
    p_body: body,
    p_hook: hook,
  })
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  // Re-read the canonical row so the client reflects server truth (updated_at…).
  const { data: item } = await supabase
    .from('content_items')
    .select('id, type, status, title, hook, body, source_session_id, source_kind, slug, published_at, created_at, updated_at, parent_source_id')
    .eq('id', itemId)
    .maybeSingle()

  return NextResponse.json({ success: true, item: item ?? null })
}
