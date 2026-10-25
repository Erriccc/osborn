import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServer } from '@/lib/supabase-server'

/**
 * /api/notes — the signed-in user's quick-capture NOTES (voice-memo → text).
 * GET    → latest 50 notes (desc)
 * POST   → save { text } (trimmed, 1..10_000 chars)
 * DELETE → ?id=<uuid> (owner-scoped by RLS + explicit user_id filter)
 */

const MAX_NOTES = 50
const MAX_TEXT = 10_000

export async function GET() {
  try {
    const supabase = await createSupabaseServer()
    const { data: u } = await supabase.auth.getUser()
    if (!u.user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    const { data, error } = await supabase
      .from('notes')
      .select('id, text, created_at')
      .eq('user_id', u.user.id)
      .order('created_at', { ascending: false })
      .limit(MAX_NOTES)
    if (error) return NextResponse.json({ error: error.message }, { status: 400 })
    return NextResponse.json({ notes: data })
  } catch {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const supabase = await createSupabaseServer()
    const { data: u } = await supabase.auth.getUser()
    if (!u.user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    const body = await req.json().catch(() => null)
    const text = typeof body?.text === 'string' ? body.text.trim().slice(0, MAX_TEXT) : ''
    if (!text) return NextResponse.json({ error: '`text` is required' }, { status: 400 })
    const { data, error } = await supabase
      .from('notes')
      .insert({ user_id: u.user.id, text })
      .select('id, text, created_at')
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 400 })
    return NextResponse.json({ note: data })
  } catch {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const supabase = await createSupabaseServer()
    const { data: u } = await supabase.auth.getUser()
    if (!u.user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    const id = req.nextUrl.searchParams.get('id')
    if (!id) return NextResponse.json({ error: '`id` is required' }, { status: 400 })
    const { error } = await supabase
      .from('notes')
      .delete()
      .eq('id', id)
      .eq('user_id', u.user.id) // belt-and-braces with RLS
    if (error) return NextResponse.json({ error: error.message }, { status: 400 })
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 })
  }
}
