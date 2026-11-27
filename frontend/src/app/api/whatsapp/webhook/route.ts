import { NextResponse } from 'next/server'
import { machineForPhone, serviceClient } from '@/lib/sandbox-claims'
import { wakeUserAgent } from '@/lib/connect-agent'
import { touchLastSeen } from '@/lib/last-seen'
import { toUsE164 } from '@/lib/phone'
import { textMessages, verifyChallenge, verifyMetaSignature } from '@/lib/whatsapp-inbound'

/**
 * /api/whatsapp/webhook — Meta WhatsApp Cloud API webhook (#679, messages in).
 *
 * GET answers Meta's verify handshake (META_WA_WEBHOOK_VERIFY_TOKEN). POST is
 * signed with the app secret (META_WA_APP_SECRET). A text from a number verified
 * on an account (auth.users.phone, the same lookup as phone calls) wakes that
 * account's machine through wakeUserAgent, the path the browser and phone calls
 * use. Any other number is ignored: no reply, nothing woken.
 *
 * Not built yet: handing the text to the agent and sending its reply.
 */

export async function GET(request: Request) {
  const challenge = verifyChallenge(new URL(request.url).searchParams, process.env.META_WA_WEBHOOK_VERIFY_TOKEN)
  return challenge === null ? new NextResponse('forbidden', { status: 403 }) : new NextResponse(challenge)
}

// One wake per number at a time: a burst of texts or a Meta retry joins the one in flight.
const waking = new Set<string>()

async function wakeFor(e164: string): Promise<void> {
  if (waking.has(e164)) return
  waking.add(e164)
  try { await wakeOnce(e164) } finally { waking.delete(e164) }
}

async function wakeOnce(e164: string): Promise<void> {
  const admin = serviceClient()
  if (!admin) return
  const owner = await machineForPhone(admin, e164)
  if (!owner) return
  const { userId, sandboxId, syncToken } = owner
  const r = await wakeUserAgent(userId, sandboxId, async () => syncToken, undefined, false)
  if (r.ok) touchLastSeen(admin, userId)
  else console.warn(`[whatsapp] could not wake the machine: ${r.reason}`)
}

export async function POST(request: Request) {
  const body = await request.text()
  if (!verifyMetaSignature(body, request.headers.get('x-hub-signature-256'), process.env.META_WA_APP_SECRET)) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 })
  }
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch { return NextResponse.json({ error: 'invalid payload' }, { status: 400 }) }
  // Meta retries anything but a fast 200, so wake in the background.
  // Verified numbers are US-only (toUsE164, as phone calls and Settings).
  // Meta's `from` carries the country code: only 1 + 10 digits is a US number (a bare 10-digit foreign number must not read as one).
  const senders = Array.from(new Set(textMessages(parsed).filter((m) => /^1\d{10}$/.test(m.from)).map((m) => toUsE164(m.from)).filter((n): n is string => !!n)))
  for (const from of senders) {
    void wakeFor(from).catch((e) => console.error(`[whatsapp] wake failed: ${(e as Error).message}`))
  }
  return NextResponse.json({ ok: true })
}
