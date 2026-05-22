import { NextRequest, NextResponse } from 'next/server'
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk'

/**
 * Mint a short-lived LiveKit token for a Recall.ai meeting bot.
 *
 * Called server-to-server from the Fly agent's recall-client.ts when joining a
 * meeting. The agent then constructs the meeting-bot page URL with the token
 * embedded (`/meeting-bot?token=...&room=...&botId=...`) and hands that URL to
 * Recall as the `output_media.camera.config.url`. Recall's headless browser
 * opens that URL, connects to LiveKit using the embedded token, and joins the
 * same room as the osborn agent.
 *
 * Auth: ROOM-PRESENCE CHECK (no shared secret).
 *   We use LiveKit's RoomServiceClient.listParticipants() to verify the
 *   requested room is actually a live LiveKit room with active participants.
 *   The agent must already be connected to the room (which it is by the time
 *   it requests this token), so an empty room rejects.
 *
 *   This eliminates the need for a long-lived MEETING_BOT_TOKEN_SECRET shared
 *   between the agent and this endpoint. Blast radius of a leak is limited:
 *   even if someone discovers a room name, they'd need that room to currently
 *   be live, AND any minted bot token only joins that specific room (visible
 *   to the legitimate user as an extra participant).
 *
 * Identity scheme: `recall-bot-<botId>` so the agent can distinguish bot
 * participants from human users via metadata.
 */

const TOKEN_TTL_SEC = 600 // 10 min — long enough for Recall to dial in + connect

/**
 * RoomServiceClient needs an HTTPS URL (the server API endpoint), but
 * LIVEKIT_URL is the wss:// endpoint clients use. Convert scheme.
 */
function toHttpUrl(wssUrl: string): string {
  if (wssUrl.startsWith('wss://')) return 'https://' + wssUrl.slice('wss://'.length)
  if (wssUrl.startsWith('ws://')) return 'http://' + wssUrl.slice('ws://'.length)
  return wssUrl
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.LIVEKIT_API_KEY
  const apiSecret = process.env.LIVEKIT_API_SECRET
  const livekitUrl = process.env.LIVEKIT_URL

  if (!apiKey || !apiSecret || !livekitUrl) {
    return NextResponse.json({ error: 'LiveKit credentials not configured' }, { status: 500 })
  }

  let body: { botId?: string; roomName?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  const botId = body.botId
  const roomName = body.roomName
  if (!botId || !roomName) {
    return NextResponse.json({ error: 'botId and roomName required' }, { status: 400 })
  }

  // Auth: verify the room actually exists with active participants.
  // An attacker would have to (a) guess the random 6-char room code AND (b)
  // happen to do so while the room is live with the user + agent present.
  // Any minted bot token only authorizes joining THAT specific room — which
  // the legitimate user can see (extra participant appears in their session).
  try {
    const roomService = new RoomServiceClient(toHttpUrl(livekitUrl), apiKey, apiSecret)
    const participants = await roomService.listParticipants(roomName)
    if (!participants || participants.length === 0) {
      return NextResponse.json({ error: 'room has no active participants' }, { status: 401 })
    }
  } catch (err) {
    // LiveKit returns 404 / error for rooms that don't exist — treat as auth failure
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `room not found or unreachable: ${msg}` }, { status: 401 })
  }

  const identity = `recall-bot-${botId}`
  const at = new AccessToken(apiKey, apiSecret, {
    identity,
    ttl: TOKEN_TTL_SEC,
    // Metadata lets the agent recognize this participant as the meeting bot
    // (vs a human user) on ParticipantConnected, so it can route audio +
    // transcripts appropriately.
    metadata: JSON.stringify({ role: 'meeting-bot', botId }),
  })

  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
  })

  const token = await at.toJwt()
  return NextResponse.json({ token, url: livekitUrl, identity, ttlSec: TOKEN_TTL_SEC })
}
