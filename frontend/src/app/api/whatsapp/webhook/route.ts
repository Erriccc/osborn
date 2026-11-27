import { NextResponse } from 'next/server'
import { checkSandboxClaim, serviceClient } from '@/lib/sandbox-claims'
import { wakeUserAgent } from '@/lib/connect-agent'
import { touchLastSeen } from '@/lib/last-seen'
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

async function wakeFor(from: string): Promise<void> {
  const admin = serviceClient()
  if (!admin) return
  const { data: userId, error } = await admin.rpc('user_id_for_phone', { p_phone: `+${from}` })
  if (error || typeof userId !== 'string' || !userId) return
  const { data: inst } = await admin.from('instances').select('sandbox_id, sync_token').eq('user_id', userId).single()
  const sandboxId = (inst?.sandbox_id as string | null | undefined) ?? undefined
  const syncToken = (inst?.sync_token as string | null | undefined) ?? undefined
  if (!sandboxId || !syncToken || (await checkSandboxClaim(null, sandboxId, userId)) !== 'mine') return
  const r = await wakeUserAgent(userId, sandboxId, async () => syncToken)
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
  const senders = [...new Set(textMessages(parsed).map((m) => m.from))]
  for (const from of senders) {
    void wakeFor(from).catch((e) => console.error(`[whatsapp] wake failed: ${(e as Error).message}`))
  }
  return NextResponse.json({ ok: true })
}
