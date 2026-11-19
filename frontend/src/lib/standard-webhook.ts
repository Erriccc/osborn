/**
 * standard-webhook.ts — signature check for Standard Webhooks senders
 * (Supabase auth hooks: /api/phone/verify-hook). Server-only.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Standard Webhooks signature check (what Supabase auth hooks send):
 * `webhook-signature` holds space-separated `v1,<base64 HMAC-SHA256>` entries
 * over `${id}.${timestamp}.${body}`, keyed with the base64 part of the
 * `v1,whsec_<base64>` secret. Timestamps more than 5 minutes off are refused.
 */
export function verifyStandardWebhook(
  body: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  secret: string | undefined,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!secret || !headers.id || !headers.timestamp || !headers.signature) return false
  const ts = Number(headers.timestamp)
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > 300) return false
  const key = Buffer.from(secret.replace(/^v1,/, '').replace(/^whsec_/, ''), 'base64')
  if (!key.length) return false
  const expected = Buffer.from(createHmac('sha256', key).update(`${headers.id}.${headers.timestamp}.${body}`).digest('base64'))
  return headers.signature.split(' ').some((entry) => {
    const [version, sig] = entry.split(',')
    if (version !== 'v1' || !sig) return false
    const got = Buffer.from(sig)
    return got.length === expected.length && timingSafeEqual(got, expected)
  })
}
