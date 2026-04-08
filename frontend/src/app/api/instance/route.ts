import { NextResponse } from 'next/server'
import { createSupabaseServer } from '@/lib/supabase-server'

// GET /api/instance — get current user's instance (or null)
export async function GET() {
  const supabase = await createSupabaseServer()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const { data: instance } = await supabase
    .from('instances')
    .select('*')
    .eq('user_id', user.id)
    .single()

  return NextResponse.json({ instance })
}

// POST /api/instance — create or update user's instance
export async function POST(request: Request) {
  const supabase = await createSupabaseServer()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const body = await request.json()
  const { serverUrl, instanceType = 'local', sandboxId, sandboxUrl, sandboxStatus } = body

  if (!serverUrl) {
    return NextResponse.json({ error: 'serverUrl is required' }, { status: 400 })
  }

  // Generate a unique LiveKit room name for this user
  const livekitRoom = `osborn-${user.id.substring(0, 8)}`

  // Upsert — create if not exists, update if exists
  const upsertData: Record<string, any> = {
    user_id: user.id,
    server_url: serverUrl,
    instance_type: instanceType,
    status: 'running',
    livekit_room: livekitRoom,
    last_seen: new Date().toISOString(),
  }
  // Include sandbox fields if provided (cloud provisioning)
  if (sandboxId !== undefined) upsertData.sandbox_id = sandboxId
  if (sandboxUrl !== undefined) upsertData.sandbox_url = sandboxUrl
  if (sandboxStatus !== undefined) upsertData.sandbox_status = sandboxStatus

  const { data: instance, error } = await supabase
    .from('instances')
    .upsert(upsertData, {
      onConflict: 'user_id',
    })
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ instance })
}
