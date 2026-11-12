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
  engineTokenConfigured,
  engineMachineState,
  startEngineMachine,
  classifyFetchError,
  type EngineErrorKind,
} from '@/lib/browser-engine'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function signedInUser() {
  const supabase = await createSupabaseServer()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return user
}

// The engine's driver identity for a person using the panel. Set here on the
// server so a browser cannot claim to be another driver (or an agent).
const personDriver = (u: { email?: string | null; id: string }) => `person:${u.email ?? u.id}`

function engineHeaders(extra?: Record<string, string>): Record<string, string> {
  const tok = engineToken()
  return { ...(tok ? { 'x-engine-token': tok } : {}), ...(extra ?? {}) }
}

// A control/output action (anything that attaches x-engine-token) will be rejected
// by the engine with a bare 401 "unauthorized — x-engine-token required" when the
// server has no engine token. Make that misconfiguration visible in the logs — the
// fix is operational (set OSBORN_ENGINE_TOKEN on the frontend to match the engine),
// not a code change.
function warnIfEngineTokenMissing(action: string): void {
  if (!engineTokenConfigured()) {
    console.warn(
      `[browser-proxy] control action "${action}" attempted but OSBORN_ENGINE_TOKEN is not set ` +
        `server-side — the engine will reject it with 401 (x-engine-token required). ` +
        `Set OSBORN_ENGINE_TOKEN on the frontend to match the engine's Fly secret.`,
    )
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Cold-start-aware failure for a control request that never reached the engine.
// Instead of a bare opaque 502 (#102/#104), inspect the Fly machine state and
// return a clear, actionable, retriable error — and wake a stopped engine so the
// user's retry lands on a booting one rather than another connection-refused.
async function engineUnreachableResponse(kind: EngineErrorKind): Promise<NextResponse> {
  const machine = await engineMachineState()
  const asleep = machine.state != null && machine.state !== 'started'

  // Known-stopped/asleep: the fetch to the control port already nudges Fly's
  // auto-start, but issue the start explicitly too so the wake is reliable.
  if (asleep) {
    await startEngineMachine(machine.machineId)
    return NextResponse.json(
      {
        error: 'The browser engine was asleep and is now booting (~1–2 min). Retry in a moment.',
        code: 'engine_booting',
        retriable: true,
        engineState: machine.state,
      },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    )
  }

  // Can't even read the machine state (Fly API unreachable, or no token) AND the
  // control request failed → genuinely unreachable; still likely transient.
  if (machine.state == null) {
    const booting = kind === 'refused'
    return NextResponse.json(
      {
        error: booting
          ? 'The browser engine is still booting (~1–2 min) — retry shortly.'
          : "The browser engine can't be reached right now — it may be booting. Retry in a moment.",
        code: booting ? 'engine_booting' : 'engine_unreachable',
        retriable: true,
        engineState: null,
      },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    )
  }

  // Machine reports 'started' but the control API refused/timed out → the engine
  // process is mid-boot (listening not ready) or wedged.
  const booting = kind === 'refused'
  return NextResponse.json(
    {
      error: booting
        ? 'The browser engine is still booting (~1–2 min) — retry shortly.'
        : `The browser engine isn't responding (${kind}). Retry in a few seconds, or press Stop engine and Wake again.`,
      code: booting ? 'engine_booting' : 'engine_unreachable',
      retriable: true,
      engineState: machine.state,
    },
    { status: 503, headers: { 'Cache-Control': 'no-store' } },
  )
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ action: string }> }) {
  const user = await signedInUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const { action } = await params
  const search = req.nextUrl.search

  // Awake/asleep without waking the engine (Fly Machines API). We also report
  // whether the server-side engine token is configured — only the boolean, never
  // the value — so the panel can flag the misconfig instead of letting every
  // control/output action fail with a cryptic 401.
  if (action === 'engine-state') {
    const machine = await engineMachineState()
    return NextResponse.json(
      { ...machine, engineTokenConfigured: engineTokenConfigured(), driver: personDriver(user) },
      { headers: { 'Cache-Control': 'no-store' } },
    )
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
  warnIfEngineTokenMissing(action)

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
  const user = await signedInUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const driver = personDriver(user)
  const { action } = await params
  const target = buildControlTarget('POST', action, req.nextUrl.search)
  if (!target) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  warnIfEngineTokenMissing(action)

  let body = await req.arrayBuffer()
  // Tab ownership (takeover / handback / claim) is by driver: the owner is the
  // signed-in person, whatever the browser sent.
  if (action === 'tab') {
    try {
      const j = JSON.parse(new TextDecoder().decode(body))
      if (j && typeof j === 'object') body = new TextEncoder().encode(JSON.stringify({ ...j, owner: driver })).buffer as ArrayBuffer
    } catch { /* not JSON: pass through, the engine rejects it */ }
  }
  // `act`/`say` drive the browser + record a clip — they can take a while.
  const timeoutMs = action === 'act' || action === 'say' ? 90000 : 30000
  const headers = engineHeaders({ 'Content-Type': req.headers.get('content-type') ?? 'application/json', 'x-driver-id': driver })

  // Cold-start handling (#102/#104): when the engine is stopped or mid-boot the
  // control port refuses the connection. `say` (and every drive action) used to
  // collapse that into a bare opaque 502. Instead: one quick retry across the
  // brief mid-boot refuse window, then a clear, actionable, retriable error.
  let lastKind: EngineErrorKind = 'network'
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const upstream = await fetch(target, {
        method: 'POST',
        headers,
        body,
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      })
      return new NextResponse(await upstream.arrayBuffer(), {
        status: upstream.status,
        headers: { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' },
      })
    } catch (e) {
      lastKind = classifyFetchError(e)
      // Only a connection-refused is worth a fast in-request retry (the engine
      // process is seconds from listening). A timeout already burned the budget,
      // and DNS/other won't fix themselves in 1.5s.
      if (attempt === 0 && lastKind === 'refused') {
        await sleep(1500)
        continue
      }
      break
    }
  }
  return engineUnreachableResponse(lastKind)
}
