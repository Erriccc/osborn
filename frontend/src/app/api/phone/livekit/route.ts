import { NextResponse } from 'next/server'
import { WebhookReceiver } from 'livekit-server-sdk'
import { phoneCallFromEvent } from '@/lib/phone'
import { routeCall } from '@/lib/phone-calls'

/**
 * POST /api/phone/livekit — LiveKit Cloud webhook (#361, phone calls in).
 *
 * The shared number's `individual` dispatch rule puts each caller in a fresh
 * `call-…` room and LiveKit sends `participant_joined` (kind SIP) here. A caller
 * whose number is verified on an account (auth.users.phone, confirmed) brings
 * that account's agent into the room through connectUserAgent, the same wake +
 * connect path the browser uses. Anyone else is hung up on. When the agent is
 * already in a browser session the caller hears a short busy line first.
 *
 * Replies 200 straight away (after the signature check) and handles the call
 * in the background: waking a stopped machine takes longer than a webhook
 * should wait.
 */

export async function POST(request: Request) {
  const key = process.env.LIVEKIT_API_KEY
  const secret = process.env.LIVEKIT_API_SECRET
  if (!key || !secret) return NextResponse.json({ error: 'not configured' }, { status: 503 })
  const body = await request.text()
  let event
  try {
    event = await new WebhookReceiver(key, secret).receive(body, request.headers.get('authorization') ?? undefined)
  } catch {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 })
  }
  const call = phoneCallFromEvent(event)
  if (!call) return NextResponse.json({ ok: true, ignored: true })
  console.log(`[phone] call into ${call.roomName}`)
  void routeCall(call).catch((e) => console.error(`[phone] routing ${call.roomName} failed: ${(e as Error).message}`))
  return NextResponse.json({ ok: true })
}
