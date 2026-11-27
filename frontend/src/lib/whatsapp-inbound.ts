/**
 * whatsapp-inbound.ts — pure helpers for WhatsApp messages in (#679): the Meta
 * webhook signature, the verify handshake, the text messages in a delivery and
 * Meta's 24-hour customer-service window. Server-only (node:crypto).
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

/** Meta signs the raw body with the app secret: `X-Hub-Signature-256: sha256=<hex>`. */
export function verifyMetaSignature(rawBody: string, header: string | null | undefined, appSecret: string | undefined): boolean {
  if (!appSecret || !header?.startsWith('sha256=')) return false
  const want = createHmac('sha256', appSecret).update(rawBody).digest()
  const got = Buffer.from(header.slice('sha256='.length), 'hex')
  return got.length === want.length && timingSafeEqual(got, want)
}

/** The GET handshake: the challenge to echo when the token matches, else null. */
export function verifyChallenge(params: URLSearchParams, verifyToken: string | undefined): string | null {
  if (!verifyToken || params.get('hub.mode') !== 'subscribe') return null
  const sent = params.get('hub.verify_token') ?? ''
  const a = Buffer.from(sent)
  const b = Buffer.from(verifyToken)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  return params.get('hub.challenge')
}

export interface InboundText { from: string; id: string; text: string; at: number }

/**
 * The plain-text messages in a webhook delivery (`entry[].changes[].value.messages[]`).
 * Other types (media, reactions, status updates) are skipped. `from` is digits
 * only, as Meta sends it; `at` is epoch milliseconds.
 */
export function textMessages(body: unknown): InboundText[] {
  const out: InboundText[] = []
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
        const from = String(m?.from ?? '').replace(/[^0-9]/g, '')
        const secs = Number(m?.timestamp)
        if (typeof text !== 'string' || !text.trim() || !from || typeof m.id !== 'string' || !Number.isFinite(secs)) continue
        out.push({ from, id: m.id, text, at: secs * 1000 })
      }
    }
  }
  return out
}

/** Meta's customer-service window: free-form replies only within 24 h of the user's last message. */
export const WA_WINDOW_MS = 24 * 60 * 60 * 1000
export const whatsappWindowOpen = (lastUserMessageAt: number, now = Date.now()) =>
  now >= lastUserMessageAt && now - lastUserMessageAt < WA_WINDOW_MS
