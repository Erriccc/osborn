// Authenticated proxy for the browser-screen-recorder engine (issue #51).
//
// The engine is a Fly app with a public MJPEG live view and a token-protected
// control API on :8781. Rather than hand the raw Fly URL + engine/stream tokens
// to the browser, the in-app Browser panel calls THIS route; we inject the tokens
// server-side and forward only allowlisted endpoints.
//
// Streaming endpoints (`stream` MJPEG, `events` SSE) are piped through as live
// bodies; everything else is buffered. `engine-state` is special: it asks the Fly
// Machines API for awake/asleep WITHOUT waking the engine. Auth-gated: any request
// to the engine itself wakes a stopped Fly machine (compute cost), so only
// signed-in users may drive it.
import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServer } from '@/lib/supabase-server'
import {
  GET_ALLOW,
  POST_ALLOW,
  buildControlTarget,
  buildStreamTarget,
  engineToken,
  engineMachineState,
} from '@/lib/browser-engine'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function requireUser(): Promise<NextResponse | null> {
  const supabase = await createSupabaseServer()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return user ? null : NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
}

function engineHeaders(extra?: Record<string, string>): Record<string, string> {
  const tok = engineToken()
  return { ...(tok ? { 'x-engine-token': tok } : {}), ...(extra ?? {}) }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ action: string }> }) {
  const unauth = await requireUser()
  if (unauth) return unauth
  const { action } = await params
  const search = req.nextUrl.search

  // Awake/asleep without waking the engine (Fly Machines API).
  if (action === 'engine-state') {
    return NextResponse.json(await engineMachineState(), { headers: { 'Cache-Control': 'no-store' } })
  }

  // Live MJPEG — pipe the body through so it streams. Visiting this WAKES the engine.
  if (action === 'stream') {
    try {
      const upstream = await fetch(buildStreamTarget(search), { cache: 'no-store' })
      if (!upstream.ok || !upstream.body) {
        return NextResponse.json({ error: `stream ${upstream.status}` }, { status: 502 })
      }
      return new NextResponse(upstream.body, {
        status: 200,
        headers: {
          'Content-Type': upstream.headers.get('content-type') ?? 'multipart/x-mixed-replace',
          'Cache-Control': 'no-store, no-transform',
        },
      })
    } catch {
      return NextResponse.json({ error: 'Engine unreachable' }, { status: 502 })
    }
  }

  const target = buildControlTarget('GET', action, search)
  if (!target) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // SSE event stream — pipe through live.
  if (action === 'events') {
    try {
      const upstream = await fetch(target, { headers: engineHeaders(), cache: 'no-store' })
      if (!upstream.ok || !upstream.body) {
        return NextResponse.json({ error: `events ${upstream.status}` }, { status: 502 })
      }
      return new NextResponse(upstream.body, {
        status: 200,
        headers: {
          'Content-Type': upstream.headers.get('content-type') ?? 'text/event-stream',
          'Cache-Control': 'no-store, no-transform',
          Connection: 'keep-alive',
        },
      })
    } catch {
      return NextResponse.json({ error: 'Engine unreachable' }, { status: 502 })
    }
  }

  // Buffered JSON / binary (status, tasks, logs, clip, artifact, audio).
  try {
    const upstream = await fetch(target, {
      headers: engineHeaders(),
      cache: 'no-store',
      signal: AbortSignal.timeout(30000),
    })
    const headers: Record<string, string> = {
      'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
      'Cache-Control': 'no-store',
    }
    const cd = upstream.headers.get('content-disposition')
    if (cd) headers['Content-Disposition'] = cd
    return new NextResponse(await upstream.arrayBuffer(), { status: upstream.status, headers })
  } catch {
    return NextResponse.json({ error: 'Engine unreachable' }, { status: 502 })
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ action: string }> }) {
  const unauth = await requireUser()
  if (unauth) return unauth
  const { action } = await params
  const target = buildControlTarget('POST', action, req.nextUrl.search)
  if (!target) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await req.arrayBuffer()
  // `act`/`say` drive the browser + record a clip — they can take a while.
  const timeoutMs = action === 'act' || action === 'say' ? 90000 : 30000
  try {
    const upstream = await fetch(target, {
      method: 'POST',
      headers: engineHeaders({ 'Content-Type': req.headers.get('content-type') ?? 'application/json' }),
      body,
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    })
    return new NextResponse(await upstream.arrayBuffer(), {
      status: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' },
    })
  } catch {
    return NextResponse.json({ error: 'Engine unreachable' }, { status: 502 })
  }
}
