import { NextRequest, NextResponse } from 'next/server'
import { AccessToken } from 'livekit-server-sdk'

export async function GET(request: NextRequest) {
  const apiKey = process.env.LIVEKIT_API_KEY
  const apiSecret = process.env.LIVEKIT_API_SECRET

  if (!apiKey || !apiSecret) {
    return NextResponse.json(
      { error: 'LiveKit credentials not configured' },
      { status: 500 }
    )
  }

  // Get provider and coding agent from query params
  const provider = request.nextUrl.searchParams.get('provider') || 'openai'
  const codingAgent = request.nextUrl.searchParams.get('codingAgent') || 'claude'

  const roomName = 'osborn-room'
  const participantName = `user-${Date.now()}`

  const at = new AccessToken(apiKey, apiSecret, {
    identity: participantName,
    // Include provider and coding agent in participant metadata
    metadata: JSON.stringify({ provider, codingAgent }),
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
    provider,
  })
}
