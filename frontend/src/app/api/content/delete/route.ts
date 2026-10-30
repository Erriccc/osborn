import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServer } from '@/lib/supabase-server'

/**
 * POST /api/content/delete — permanently delete one of the caller's content
 * items (a draft page or a rendition).
 *
 * Body: { itemId: string }
 *
 * Auth: the cookie-based server client carries the user's JWT, and the
 * content_items_owner_delete RLS policy (migration 007) scopes the delete to
 * auth.uid() = owner_user_id — a caller can only ever delete their own rows.
 * The explicit owner_user_id filter below is belt-and-braces on top of RLS.
 *
 * Deleting a SOURCE sets its renditions' parent_source_id to NULL
 * (ON DELETE SET NULL, migration 009) — renditions are kept, never cascaded.
 */
export async function POST(req: NextRequest) {
  let supabase: Awaited<ReturnType<typeof createSupabaseServer>>
  let userId: string
  try {
    supabase = await createSupabaseServer()
    const { data: u } = await supabase.auth.getUser()
    if (!u.user) return NextResponse.json({ success: false, error: 'Not authenticated' }, { status: 401 })
    userId = u.user.id
  } catch {
    return NextResponse.json({ success: false, error: 'Supabase not configured' }, { status: 503 })
  }

  let itemId: string
  try {
    const b = await req.json()
    itemId = b?.itemId
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 })
  }

  if (!itemId || typeof itemId !== 'string') {
    return NextResponse.json({ success: false, error: '`itemId` is required' }, { status: 400 })
  }

  const { error, count } = await supabase
    .from('content_items')
    .delete({ count: 'exact' })
    .eq('id', itemId)
    .eq('owner_user_id', userId)

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }
  if (!count) {
    return NextResponse.json({ success: false, error: 'Item not found' }, { status: 404 })
  }

  return NextResponse.json({ success: true })
}
