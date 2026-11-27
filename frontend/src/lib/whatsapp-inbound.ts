/**
 * whatsapp-inbound.ts — pure helpers for WhatsApp messages in (#679): the Meta
 * webhook signature, the verify handshake and the text messages in a delivery.
 * Server-only (node:crypto).
 */
import { createHmac } from 'node:crypto'
import { sameBytes } from '@/lib/standard-webhook'

/** Meta signs the raw body with the app secret: `X-Hub-Signature-256: sha256=<hex>`. */
export function verifyMetaSignature(rawBody: string, header: string | null | undefined, appSecret: string | undefined): boolean {
  if (!appSecret || !header?.startsWith('sha256=')) return false
  return sameBytes(Buffer.from(header.slice('sha256='.length), 'hex'), createHmac('sha256', appSecret).update(rawBody).digest())
}

/** The GET handshake: the challenge to echo when the token matches, else null. */
export function verifyChallenge(params: URLSearchParams, verifyToken: string | undefined): string | null {
  if (!verifyToken || params.get('hub.mode') !== 'subscribe') return null
  if (!sameBytes(Buffer.from(params.get('hub.verify_token') ?? ''), Buffer.from(verifyToken))) return null
  return params.get('hub.challenge')
}

/**
 * The plain-text messages in a webhook delivery (`entry[].changes[].value.messages[]`).
 * Other types (media, reactions, status updates) are skipped. `from` is as Meta
 * sends it (digits, no '+').
 */
export function textMessages(body: unknown): { from: string; text: string }[] {
  const out: { from: string; text: string }[] = []
  const entries = (body as { entry?: unknown[] } | null)?.entry
  if (!Array.isArray(entries)) return out
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] } | null)?.changes
    if (!Array.isArray(changes)) continue
    for (const change of changes) {
      const messages = (change as { value?: { messages?: unknown[] } } | null)?.value?.messages
      if (!Array.isArray(messages)) continue
      for (const m of messages as Record<string, any>[]) {
        const text = m?.type === 'text' ? m.text?.body : undefined
        const from = m?.from
        if (typeof text !== 'string' || !text.trim() || typeof from !== 'string' || !from) continue
        out.push({ from, text })
      }
    }
  }
  return out
}
