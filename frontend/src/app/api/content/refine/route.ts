import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServer } from '@/lib/supabase-server'
import {
  isPlatform,
  parseModelOutput,
  systemPrompt,
  userPrompt,
  type RefineResult,
} from '@/lib/content-refine'

/**
 * POST /api/content/refine — turn a raw library item into a polished,
 * platform-specific rendition via Fireworks (fast LLM), with a chat-to-refine
 * loop.
 *
 * Body: { sourceItemId: string, platform: Platform, instruction?: string, renditionId?: string }
 *
 * Auth: the cookie-based server Supabase client carries the signed-in user's
 * JWT. We load the source (or the existing rendition when renditionId is given)
 * under the caller's RLS, so a user can only refine their own items.
 *
 * Fireworks: OpenAI-compatible chat/completions, model gpt-oss-120b, keyed by
 * FIREWORKS_API_KEY (set on Railway). A platform-specific system prompt + the
 * source body (+ optional instruction) yields STRICT JSON which we parse into
 * {title, hook, body, seo:{metaTitle, metaDescription}}.
 *
 * Persist: renditionId -> content_update_rendition; else -> content_create_rendition.
 * Both are SECURITY DEFINER (migration 009) and owner-checked. We then return
 * the fresh rendition row (plain RLS select).
 */

const FIREWORKS_URL = 'https://api.fireworks.ai/inference/v1/chat/completions'
const FIREWORKS_MODEL = 'accounts/fireworks/models/gpt-oss-120b'
const REFINE_TIMEOUT_MS = 30_000
const MAX_TOKENS = 2048

const RENDITION_COLUMNS =
  'id, type, status, title, hook, body, source_session_id, source_kind, slug, published_at, created_at, updated_at, parent_source_id'

export async function POST(req: NextRequest) {
  let supabase: Awaited<ReturnType<typeof createSupabaseServer>>
  try {
    supabase = await createSupabaseServer()
    const { data: u } = await supabase.auth.getUser()
    if (!u.user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  } catch {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 })
  }

  // ---- Parse + validate the body ------------------------------------------
  let sourceItemId: string
  let platform: string
  let instruction: string | undefined
  let renditionId: string | undefined
  try {
    const body = await req.json()
    sourceItemId = body?.sourceItemId
    platform = body?.platform
    instruction = typeof body?.instruction === 'string' && body.instruction.trim() ? body.instruction : undefined
    renditionId = typeof body?.renditionId === 'string' && body.renditionId.trim() ? body.renditionId : undefined
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!sourceItemId || typeof sourceItemId !== 'string') {
    return NextResponse.json({ error: '`sourceItemId` is required' }, { status: 400 })
  }
  if (!isPlatform(platform)) {
    return NextResponse.json({ error: '`platform` must be one of blog, x_thread, linkedin, short, newsletter' }, { status: 400 })
  }

  const apiKey = process.env.FIREWORKS_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'Refine is not configured (missing FIREWORKS_API_KEY)' }, { status: 503 })
  }

  // ---- Load the content to rewrite -----------------------------------------
  // When refining in place we rewrite from the existing rendition's body (so
  // successive instructions compound); otherwise we rewrite from the source.
  // RLS scopes both selects to the caller's own rows.
  const loadId = renditionId ?? sourceItemId
  const { data: srcRow, error: loadErr } = await supabase
    .from('content_items')
    .select('id, title, body')
    .eq('id', loadId)
    .maybeSingle()

  if (loadErr) return NextResponse.json({ error: loadErr.message }, { status: 400 })
  if (!srcRow) return NextResponse.json({ error: 'Source item not found' }, { status: 404 })

  const sourceTitle = (srcRow as { title: string | null }).title
  const sourceBody = (srcRow as { body: string | null }).body ?? ''

  // ---- Call Fireworks -------------------------------------------------------
  let result: RefineResult
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REFINE_TIMEOUT_MS)
  try {
    const resp = await fetch(FIREWORKS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: FIREWORKS_MODEL,
        max_tokens: MAX_TOKENS,
        temperature: 0.6,
        messages: [
          { role: 'system', content: systemPrompt(platform) },
          { role: 'user', content: userPrompt(sourceBody, instruction, sourceTitle) },
        ],
      }),
      signal: controller.signal,
    })

    if (!resp.ok) {
      const detail = await resp.text().catch(() => '')
      return NextResponse.json(
        { error: `Fireworks error (${resp.status})`, detail: detail.slice(0, 500) },
        { status: 502 },
      )
    }

    const json = await resp.json()
    const content: unknown = json?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) {
      return NextResponse.json({ error: 'Fireworks returned no content' }, { status: 502 })
    }
    result = parseModelOutput(content)
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      return NextResponse.json({ error: 'Refine timed out' }, { status: 504 })
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Refine failed' },
      { status: 500 },
    )
  } finally {
    clearTimeout(timer)
  }

  // ---- Persist as a rendition (create or update in place) ------------------
  let itemId: string
  if (renditionId) {
    const { error } = await supabase.rpc('content_update_rendition', {
      p_item_id: renditionId,
      p_title: result.title,
      p_body: result.body,
      p_hook: result.hook,
    })
    if (error) return NextResponse.json({ error: error.message }, { status: 400 })
    itemId = renditionId
  } else {
    const { data, error } = await supabase.rpc('content_create_rendition', {
      p_source_id: sourceItemId,
      p_type: platform,
      p_title: result.title,
      p_body: result.body,
      p_hook: result.hook,
    })
    if (error) return NextResponse.json({ error: error.message }, { status: 400 })
    itemId = (typeof data === 'string' ? data : Array.isArray(data) ? data[0] : data) as string
  }

  // Return the fresh rendition row for the client to render.
  const { data: rendition, error: fetchErr } = await supabase
    .from('content_items')
    .select(RENDITION_COLUMNS)
    .eq('id', itemId)
    .maybeSingle()

  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 400 })

  return NextResponse.json({ rendition, seo: result.seo })
}
