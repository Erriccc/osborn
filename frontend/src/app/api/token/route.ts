import { NextRequest, NextResponse } from 'next/server'
import { AccessToken } from 'livekit-server-sdk'
import { createSupabaseServer } from '@/lib/supabase-server'

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

  // Get or generate room code
  // If provided, use it (for reconnection); otherwise generate new
  const roomCode = request.nextUrl.searchParams.get('roomCode') || generateRoomCode()
  const roomName = `osborn-${roomCode}`

  const participantName = `user-${Date.now()}`

  // Resolve the authenticated Supabase user so the agent can scope workspace
  // artifact uploads (and any future per-user data) to the right owner. This
  // is optional — guest/unauthenticated users still get a token but userId
  // will be empty, and the agent will fall back to session-scoped paths only.
  let userId = ''
  try {
    const supabase = await createSupabaseServer()
    const { data } = await supabase.auth.getUser()
    if (data.user) userId = data.user.id
  } catch {
    // Not authenticated / no Supabase session cookie — proceed without userId
  }

  const at = new AccessToken(apiKey, apiSecret, {
    identity: participantName,
    // Include provider, voice architecture, coding agent, sessionId,
    // workingDirectory, and userId in participant metadata. The agent reads
    // this metadata on participant join (see ParticipantConnected handler
    // in agent/src/index.ts) and uses userId when uploading workspace
    // artifacts to Supabase Storage so files are scoped by owner.
    metadata: JSON.stringify({ provider, voiceArch, codingAgent, sessionId, workingDirectory, userId }),
  })

  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
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
