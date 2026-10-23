import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServer } from '@/lib/supabase-server'

/**
 * GET /api/content/renditions?sourceId=... — list the caller's renditions for a
 * given source item, newest first.
 *
 * A rendition is a content_items row with parent_source_id = sourceId. Plain
 * RLS select is sufficient here: content_items_owner_select already scopes to
 * auth.uid() = owner_user_id, so the caller can only ever see their own rows.
 */
export async function GET(req: NextRequest) {
  let supabase: Awaited<ReturnType<typeof createSupabaseServer>>
  try {
    supabase = await createSupabaseServer()
    const { data: u } = await supabase.auth.getUser()
    if (!u.user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  } catch {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 })
  }

  const sourceId = req.nextUrl.searchParams.get('sourceId')
  if (!sourceId) {
    return NextResponse.json({ error: '`sourceId` query param is required' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('content_items')
    .select('id, type, status, title, hook, body, source_session_id, source_kind, slug, published_at, created_at, updated_at, parent_source_id')
    .eq('parent_source_id', sourceId)
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 400 })

  return NextResponse.json({ renditions: data ?? [] })
}
