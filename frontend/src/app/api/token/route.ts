import { NextRequest, NextResponse } from 'next/server'
import { AccessToken } from 'livekit-server-sdk'
import { createSupabaseServer } from '@/lib/supabase-server'
import { deterministicAppName, isValidRoomCode, roomBelongsToSandbox } from '@/lib/room-ownership'
import { sandboxClaimedByAnotherUser } from '@/lib/sandbox-claims'

function supabaseConfigured(): boolean {
  return !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
}

let warnedSingleTenant = false
function warnSingleTenantOnce() {
  if (warnedSingleTenant) return
  warnedSingleTenant = true
  console.warn('[token] Supabase not configured: single-tenant mode, /api/token is not auth-gated')
}

/**
 * Local-dev escape hatch for an agent on your own machine (its room prefix is a
 * random persisted code the server cannot tie to a user). Never active in a
 * production build.
 */
function devAllowAnyRoom(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.OSBORN_DEV_ALLOW_ANY_ROOM === '1'
}

/**
 * Same ownership source as /api/sandbox (the caller's own instances row), plus
 * the user-id-derived app name for legacy users with no sandbox_id recorded.
 * A recorded sandbox_id only counts when no other user also claims it; that
 * check FAILS CLOSED (lookup error / no RPC and no service key -> refused),
 * see lib/sandbox-claims.ts.
 */
async function userOwnsRoom(
  supabase: Awaited<ReturnType<typeof createSupabaseServer>>,
  userId: string,
  roomName: string,
): Promise<boolean> {
  if (roomBelongsToSandbox(roomName, deterministicAppName(userId))) return true
  const { data: instance } = await supabase
    .from('instances')
    .select('sandbox_id')
    .eq('user_id', userId)
    .maybeSingle()
  const ownedId = (instance as { sandbox_id?: string | null } | null)?.sandbox_id ?? null
  if (ownedId && roomBelongsToSandbox(roomName, ownedId)) {
    if (await sandboxClaimedByAnotherUser(supabase, ownedId, userId)) {
      console.warn(`[token] sandbox ${ownedId} is disputed or unverifiable; refusing token for ${userId}`)
      return false
    }
    return true
  }
  if (devAllowAnyRoom()) {
    console.warn(`[token] OSBORN_DEV_ALLOW_ANY_ROOM=1: minting unverified room ${roomName} (dev only)`)
    return true
  }
  return false
}

// Generate a short, user-friendly room code
function generateRoomCode(): string {
  // 6 alphanumeric characters, easy to read and type
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789' // Removed confusing chars: i,l,o,0,1
  let code = ''
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)]
  }
  return code
}

export async function GET(request: NextRequest) {
  const apiKey = process.env.LIVEKIT_API_KEY
  const apiSecret = process.env.LIVEKIT_API_SECRET

  if (!apiKey || !apiSecret) {
    return NextResponse.json(
      { error: 'LiveKit credentials not configured' },
      { status: 500 }
    )
  }

  // Get provider, voice architecture, coding agent, optional sessionId, and working directory from query params
  const provider = request.nextUrl.searchParams.get('provider') || 'openai'
  const voiceArch = request.nextUrl.searchParams.get('voiceArch') || 'realtime'
  const codingAgent = request.nextUrl.searchParams.get('codingAgent') || 'claude'
  const sessionId = request.nextUrl.searchParams.get('sessionId') || ''
  const workingDirectory = request.nextUrl.searchParams.get('workingDirectory') || ''
  // CONNECT TIMING: the dashboard button-click epoch (ms). Forwarded into the
  // agent so it can report the true end-to-end click→first-answer with no
  // cross-log clock skew. Empty for flows that don't stamp it.
  const clickTs = request.nextUrl.searchParams.get('clickTs') || ''

  // AUTH + ROOM OWNERSHIP (UI review item 22). This route mints a
  // publish-capable token (data included), so it must only do that for the
  // signed-in owner of the room's machine. Middleware skips /api/, so the
  // check lives here.
  const requestedRoomCode = request.nextUrl.searchParams.get('roomCode') || ''
  let userId = ''
  if (supabaseConfigured()) {
    let supabase: Awaited<ReturnType<typeof createSupabaseServer>> | null = null
    let user: { id: string } | null = null
    try {
      supabase = await createSupabaseServer()
      const { data } = await supabase.auth.getUser()
      user = data.user ?? null
    } catch {
      user = null
    }
    if (!supabase || !user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }
    userId = user.id

    if (requestedRoomCode) {
      if (!isValidRoomCode(requestedRoomCode)) {
        return NextResponse.json({ error: 'Invalid room code' }, { status: 400 })
      }
      const owned = await userOwnsRoom(supabase, user.id, `osborn-${requestedRoomCode}`)
      if (!owned) {
        console.warn(`[token] room ownership mismatch: user=${user.id} room=osborn-${requestedRoomCode}`)
        return NextResponse.json({ error: 'Room not found' }, { status: 404 })
      }
    }
  } else {
    // Self-hosted single-tenant deployment with no Supabase configured: there
    // is no user system to scope rooms to, so keep the legacy behavior.
    warnSingleTenantOnce()
  }

  // No roomCode → a fresh random room. Random codes contain no "-", so they
  // can never collide with an agent room (osborn-<prefix>-<ts>).
  const roomCode = requestedRoomCode || generateRoomCode()
  const roomName = `osborn-${roomCode}`

  // STABLE per-session identity (reconnect-survival Phase 0): key the participant
  // to the logical session, not a per-mint timestamp. This turns LiveKit's native
  // duplicate-identity eviction into the single-client + device-handoff primitive —
  // opening the same session link on a second device cleanly evicts the first,
  // and a reconnecting client reclaims its own seat. sessionId (from the dashboard
  // link) is the stable key; roomCode (reused across reconnects) backs a brand-new
  // session until an id is assigned. The agent treats the identity as opaque
  // (only 'meeting-canvas' is special-cased), so this is safe server-side.
  const sessionKey = sessionId || roomCode
  const participantName = `user-${sessionKey}`

  // userId (resolved above) lets the agent scope workspace artifact uploads
  // to the right owner. It is empty only in single-tenant (no Supabase) mode.
  const at = new AccessToken(apiKey, apiSecret, {
    identity: participantName,
    // Include provider, voice architecture, coding agent, sessionId,
    // workingDirectory, and userId in participant metadata. The agent reads
    // this metadata on participant join (see ParticipantConnected handler
    // in agent/src/index.ts) and uses userId when uploading workspace
    // artifacts to Supabase Storage so files are scoped by owner.
    metadata: JSON.stringify({ provider, voiceArch, codingAgent, sessionId, workingDirectory, userId, clickTs }),
  })

  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    // The agent binds control to metadata.userId (== machine owner, agent
    // data-sender-auth.ts), so the participant must not be able to rewrite it.
    canUpdateOwnMetadata: false,
  })

  const token = await at.toJwt()

  return NextResponse.json({
    token,
    url: process.env.LIVEKIT_URL,
    roomName,
    roomCode, // Return for display to user
    provider,
    voiceArch,
    codingAgent,
  })
}
