import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServer } from '@/lib/supabase-server'

/**
 * POST /api/content/publish — publish or unpublish one of the caller's items.
 *
 * Body: { action: 'publish' | 'unpublish', itemId: string, slug?: string }
 *
 * Auth: the cookie-based server Supabase client carries the signed-in user's
 * JWT, so the SECURITY DEFINER functions content_publish / content_unpublish
 * (migration 008) see a real auth.uid() and enforce owner-only access
 * themselves. We never trust an owner id from the client.
 *
 * On publish we resolve the owner handle (profiles.username — the email during
 * the alpha, per migration 007) and return the public URL path
 * /p/{handle}/{slug}.
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

  let action: string
  let itemId: string
  let slug: string | undefined
  try {
    const body = await req.json()
    action = body?.action
    itemId = body?.itemId
    slug = typeof body?.slug === 'string' && body.slug.trim() ? body.slug.trim() : undefined
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 })
  }

  if (!itemId || typeof itemId !== 'string') {
    return NextResponse.json({ success: false, error: '`itemId` is required' }, { status: 400 })
  }

  if (action === 'unpublish') {
    const { error } = await supabase.rpc('content_unpublish', { p_item_id: itemId })
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 })
    }
    return NextResponse.json({ success: true, status: 'draft' })
  }

  if (action === 'publish') {
    const { data, error } = await supabase.rpc('content_publish', {
      p_item_id: itemId,
      p_slug: slug ?? null,
    })
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 })
    }
    // content_publish RETURNS TABLE(slug, published_at) → an array of one row.
    const row = Array.isArray(data) ? data[0] : data
    const resolvedSlug: string | null = row?.slug ?? null
    const publishedAt: string | null = row?.published_at ?? null

    // Resolve the owner handle for the public URL (profiles.username).
    let handle: string | null = null
    const { data: profile } = await supabase
      .from('profiles')
      .select('username')
      .eq('id', userId)
      .maybeSingle()
    handle = (profile as { username?: string } | null)?.username ?? null

    const path = handle && resolvedSlug
      ? `/p/${encodeURIComponent(handle)}/${resolvedSlug}`
      : null

    return NextResponse.json({
      success: true,
      status: 'published',
      slug: resolvedSlug,
      publishedAt,
      handle,
      path,
      url: path ? `https://www.voice-native.com${path}` : null,
    })
  }

  return NextResponse.json({ success: false, error: 'Unknown action' }, { status: 400 })
}
