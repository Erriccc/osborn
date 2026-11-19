import { NextResponse } from 'next/server'
import {
  graphVersion, metaSendError, META_SEND_FAILED, smsDelivery, whatsappAuthMessage, whatsappMessageId,
  type SendSmsHookPayload,
} from '@/lib/phone'
import { verifyStandardWebhook } from '@/lib/standard-webhook'

/**
 * POST /api/phone/verify-hook — Supabase Auth "Send SMS" hook (#361).
 *
 * Supabase generates, expires and rate-limits the phone-change code
 * (updateUser({ phone }) → verifyOtp type 'phone_change'); this route only
 * delivers it, as a WhatsApp authentication template through the Meta Cloud
 * API instead of an SMS. The request is signed with the hook secret (Standard
 * Webhooks). Errors use the auth-hook error shape so Supabase shows the user
 * a failure instead of a code that never arrives.
 */

// Supabase gives an auth hook 5s; give up on Meta first so the user sees our message.
const META_TIMEOUT_MS = 4_000

function hookError(status: number, message: string) {
  return NextResponse.json({ error: { http_code: status, message } }, { status })
}

export async function POST(request: Request) {
  const body = await request.text()
  const signed = verifyStandardWebhook(body, {
    id: request.headers.get('webhook-id'),
    timestamp: request.headers.get('webhook-timestamp'),
    signature: request.headers.get('webhook-signature'),
  }, process.env.SUPABASE_SEND_SMS_HOOK_SECRET)
  if (!signed) return hookError(401, 'invalid signature')

  let payload: SendSmsHookPayload
  try { payload = JSON.parse(body) } catch { return hookError(400, 'invalid payload') }
  const delivery = smsDelivery(payload)
  if (!delivery) return hookError(400, 'no phone number or code in the hook payload')

  const token = process.env.META_WA_TOKEN
  const phoneId = process.env.META_WA_PHONE_ID
  const template = process.env.META_WA_AUTH_TEMPLATE
  if (!token || !phoneId || !template) return hookError(503, 'WhatsApp delivery is not configured')

  try {
    const r = await fetch(`https://graph.facebook.com/${graphVersion()}/${encodeURIComponent(phoneId)}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(whatsappAuthMessage(delivery.to, delivery.otp, template, process.env.META_WA_TEMPLATE_LANG || 'en_US')),
      signal: AbortSignal.timeout(META_TIMEOUT_MS),
    })
    const reply = await r.json().catch(() => null)
    if (!r.ok) {
      const { code, message } = metaSendError(reply)
      console.warn(`[phone] WhatsApp send failed: ${r.status} code=${code ?? '?'} ${JSON.stringify(reply ?? '').slice(0, 300)}`)
      return hookError(502, message)
    }
    // The id ties this send to Meta's delivery-status webhooks.
    console.log(`[phone] WhatsApp code sent, message id ${whatsappMessageId(reply) ?? 'missing'}`)
  } catch (e) {
    const name = (e as Error).name
    const timedOut = name === 'TimeoutError' || name === 'AbortError'
    console.warn(`[phone] WhatsApp send ${timedOut ? 'timed out' : 'threw'}: ${(e as Error).message}`)
    return hookError(timedOut ? 504 : 502, timedOut ? 'WhatsApp took too long to accept the code. Try again in a minute.' : META_SEND_FAILED)
  }
  return NextResponse.json({})
}
