import { NextRequest, NextResponse } from 'next/server'
import { AccessToken } from 'livekit-server-sdk'

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

  const at = new AccessToken(apiKey, apiSecret, {
    identity: participantName,
    // Include provider, voice architecture, coding agent, sessionId, and workingDirectory in participant metadata
    metadata: JSON.stringify({ provider, voiceArch, codingAgent, sessionId, workingDirectory }),
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
