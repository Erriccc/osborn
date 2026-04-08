import { NextResponse } from 'next/server'
import { createSupabaseServer } from '@/lib/supabase-server'
import {
  isDaytonaConfigured,
  createSandbox,
  findUserSandbox,
  startSandbox,
  stopSandbox,
  keepAliveSandbox,
} from '@/lib/daytona'

/**
 * GET /api/sandbox — get current user's sandbox status
 *
 * Returns:
 *   { available: false } — Daytona not configured, local-only mode
 *   { available: true, sandbox: null } — no sandbox yet, can provision
 *   { available: true, sandbox: { id, status, previewUrl, ... } } — has sandbox
 */
export async function GET() {
  if (!isDaytonaConfigured()) {
    return NextResponse.json({ available: false })
  }

  const supabase = await createSupabaseServer()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  // Check DB first (faster than Daytona API)
  const { data: instance } = await supabase
    .from('instances')
    .select('sandbox_id, sandbox_url, sandbox_status')
    .eq('user_id', user.id)
    .single()

  // Always check Daytona by label — source of truth
  const sandbox = await findUserSandbox(user.id)

  if (sandbox) {
    // Sync DB if it differs (handles label-found-but-DB-stale case)
    if (instance?.sandbox_id !== sandbox.id) {
      await supabase.from('instances').upsert({
        user_id: user.id,
        server_url: sandbox.previewUrl || 'http://localhost:8741',
        instance_type: 'cloud',
        status: sandbox.status,
        sandbox_id: sandbox.id,
        sandbox_url: sandbox.previewUrl,
        sandbox_status: sandbox.status,
        livekit_room: `osborn-${user.id.substring(0, 8)}`,
        last_seen: new Date().toISOString(),
      }, { onConflict: 'user_id' })
    }
    return NextResponse.json({ available: true, sandbox })
  }

  // No sandbox in Daytona — clear stale DB record if any
  if (instance?.sandbox_id) {
    console.log(`🧹 Clearing stale sandbox reference for user ${user.id}`)
    await supabase.from('instances').update({
      sandbox_id: null,
      sandbox_url: null,
      sandbox_status: 'none',
      server_url: 'http://localhost:8741',
      instance_type: 'local',
    }).eq('user_id', user.id)
  }

  return NextResponse.json({ available: true, sandbox: null })
}

/**
 * POST /api/sandbox — create, start, stop, or keepalive a sandbox
 *
 * Body: { action: 'create' | 'start' | 'stop' | 'keepalive', sandboxId?: string }
 */
export async function POST(request: Request) {
  if (!isDaytonaConfigured()) {
    return NextResponse.json({ error: 'Daytona not configured' }, { status: 503 })
  }

  const supabase = await createSupabaseServer()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const body = await request.json()
  const { action, sandboxId } = body

  switch (action) {
    case 'create': {
      const info = await createSandbox(user.id)

      if (info.status === 'running' && info.previewUrl) {
        // Save to DB — this becomes the user's agent URL
        await supabase.from('instances').upsert({
          user_id: user.id,
          server_url: info.previewUrl,
          instance_type: 'cloud',
          status: 'running',
          sandbox_id: info.id,
          sandbox_url: info.previewUrl,
          sandbox_status: 'running',
          livekit_room: `osborn-${user.id.substring(0, 8)}`,
          last_seen: new Date().toISOString(),
        }, { onConflict: 'user_id' })
      }

      return NextResponse.json(info, {
        status: info.status === 'error' ? 500 : 200,
      })
    }

    case 'start': {
      if (!sandboxId) {
        return NextResponse.json({ error: 'sandboxId required' }, { status: 400 })
      }
      const info = await startSandbox(sandboxId)
      if (info?.previewUrl) {
        await supabase.from('instances').update({
          server_url: info.previewUrl,
          sandbox_url: info.previewUrl,
          sandbox_status: 'running',
          status: 'running',
          last_seen: new Date().toISOString(),
        }).eq('user_id', user.id)
      }
      return NextResponse.json(info || { error: 'Failed to start' }, {
        status: info ? 200 : 500,
      })
    }

    case 'stop': {
      if (!sandboxId) {
        return NextResponse.json({ error: 'sandboxId required' }, { status: 400 })
      }
      const ok = await stopSandbox(sandboxId)
      if (ok) {
        await supabase.from('instances').update({
          sandbox_status: 'stopped',
          status: 'stopped',
        }).eq('user_id', user.id)
      }
      return NextResponse.json({ success: ok })
    }

    case 'keepalive': {
      if (!sandboxId) {
        return NextResponse.json({ error: 'sandboxId required' }, { status: 400 })
      }
      const ok = await keepAliveSandbox(sandboxId)
      return NextResponse.json({ success: ok })
    }

    case 'delete': {
      if (!sandboxId) {
        return NextResponse.json({ error: 'sandboxId required' }, { status: 400 })
      }
      // Stop first, then clear DB record
      await stopSandbox(sandboxId).catch(() => {})
      await supabase.from('instances').update({
        sandbox_id: null,
        sandbox_url: null,
        sandbox_status: 'none',
        server_url: 'http://localhost:8741',
        instance_type: 'local',
      }).eq('user_id', user.id)
      return NextResponse.json({ success: true })
    }

    default:
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  }
}

/**
 * DELETE /api/sandbox — delete user's sandbox and reset to local
 */
export async function DELETE() {
  if (!isDaytonaConfigured()) {
    return NextResponse.json({ error: 'Daytona not configured' }, { status: 503 })
  }

  const supabase = await createSupabaseServer()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  // Get sandbox ID from DB
  const { data: instance } = await supabase
    .from('instances')
    .select('sandbox_id')
    .eq('user_id', user.id)
    .single()

  if (instance?.sandbox_id) {
    await stopSandbox(instance.sandbox_id).catch(() => {})
  }

  // Clear sandbox fields in DB
  await supabase.from('instances').update({
    sandbox_id: null,
    sandbox_url: null,
    sandbox_status: 'none',
    server_url: 'http://localhost:8741',
    instance_type: 'local',
  }).eq('user_id', user.id)

  return NextResponse.json({ success: true })
}
