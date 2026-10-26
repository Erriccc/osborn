/**
 * pushover.ts — Track 1 watch bridge (yes/no on the wrist via Pushover).
 *
 * When the agent hits a blocking permission request and nobody answers in the
 * web UI, this module fires an emergency (priority-2) Pushover notification.
 * Pushover mirrors notifications to the Apple Watch, so a single tap on the
 * wrist acknowledges it; Pushover then requests our callback URL (the
 * frontend's /api/watch/ack/<token> route), which verifies the HMAC and POSTs
 * back to this machine's /watch/ack endpoint — resolving the pending
 * permission as ALLOW. If the push goes unacknowledged for the full expiry
 * window, a receipts-API poll settles it as DENY and cancels further retries.
 *
 * Settled semantics (mobile plan, 2026-10-24): ack = yes · expiry = no.
 *
 * Env (all optional — the bridge is dormant unless a provider is configured):
 *   PUSHOVER_TOKEN      app token from pushover.net ($5 one-time)
 *   PUSHOVER_USER_KEY   user (or group) key to push to
 *   NTFY_URL            ntfy server base (https://ntfy.sh or self-hosted)
 *   NTFY_TOPIC          topic to publish permission asks to (Approve/Deny buttons)
 *   NTFY_TOKEN          optional access token for protected ntfy topics
 *   WATCH_ACK_SECRET    HMAC secret, shared with the frontend ack route
 *   OSBORN_PUBLIC_URL   this machine's public base URL — embedded in the signed
 *                       token so the frontend route knows where to forward
 *   OSBORN_FRONTEND_URL (existing) callback host, default www.voice-native.com
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const PUSH_API = 'https://api.pushover.net/1'
const ACK_PATH = '/api/watch/ack'

// Emergency-push tuning (seconds): re-buzz every 30s for up to 10 minutes.
const RETRY_S = 30
const EXPIRE_S = 600
// Grace past expiry before the receipts poll decides (clock skew + delivery).
const EXPIRY_GRACE_MS = 5_000

interface PushoverConfig {
  token: string
  userKey: string
  secret: string
  publicUrl: string
  frontendUrl: string
}

/** Signed-token payload. `a` (agent base URL) lets the stateless frontend
 *  callback route know where to forward the ack — no DB lookup needed. */
interface AckPayload {
  n: string // nonce
  a: string // agent public base URL
  t: number // issued-at ms
  e: number // expires-at ms
}

interface PendingPush {
  qid: string
  receipt: string
  toolName: string
  description: string
  expiresAt: number
  settled: boolean
  expiryTimer?: NodeJS.Timeout
}

/** Pending pushes by qid. The permission system is single-slot, so in practice
 *  this holds at most one live record — a Map keeps ack matching O(1) anyway. */
const pending = new Map<string, PendingPush>()

/** Registered by index.ts: resolves the currently-pending permission. */
let resultHandler: ((allow: boolean, toolName: string) => void) | null = null

export function setWatchResultHandler(fn: (allow: boolean, toolName: string) => void): void {
  resultHandler = fn
}

export function pushoverConfig(): PushoverConfig | null {
  const token = process.env.PUSHOVER_TOKEN
  const userKey = process.env.PUSHOVER_USER_KEY
  const secret = process.env.WATCH_ACK_SECRET
  const publicUrl = (process.env.OSBORN_PUBLIC_URL || '').replace(/\/+$/, '')
  const frontendUrl = (process.env.OSBORN_FRONTEND_URL || 'https://www.voice-native.com').replace(/\/+$/, '')
  if (!token || !userKey || !secret || !publicUrl) return null
  return { token, userKey, secret, publicUrl, frontendUrl }
}

export function isWatchBridgeEnabled(): boolean {
  return pushoverConfig() !== null || ntfyConfig() !== null
}

// --- token helpers ---------------------------------------------------------

const b64url = (buf: Buffer | string): string =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const b64urlParse = (s: string): Buffer =>
  Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')

function hmac(secret: string, data: string): string {
  return b64url(createHmac('sha256', secret).update(data).digest())
}

export function signAckToken(payload: AckPayload, secret: string): string {
  const body = b64url(JSON.stringify(payload))
  return `${body}.${hmac(secret, body)}`
}

export function verifyAckToken(qid: string, secret: string): AckPayload | null {
  const dot = qid.lastIndexOf('.')
  if (dot <= 0) return null
  const body = qid.slice(0, dot)
  const sig = qid.slice(dot + 1)
  const expected = hmac(secret, body)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const payload = JSON.parse(b64urlParse(body).toString('utf-8')) as AckPayload
    if (typeof payload.a !== 'string' || typeof payload.n !== 'string') return null
    return payload
  } catch {
    return null
  }
}

// --- bridge ----------------------------------------------------------------

/**
 * ntfy (self-hostable, free) — second Track 1 provider. Where Pushover offers
 * one tap (ack = approve, expiry = deny), ntfy notifications carry REAL
 * Approve/Deny action buttons (http actions hitting the same ack route with
 * ?ans=1|0). Configure NTFY_URL (server base — ntfy.sh or your own), NTFY_TOPIC,
 * optional NTFY_TOKEN (access token for protected topics). Phone notifications
 * only — the watch still gets it via phone mirroring (same as Pushover).
 */
interface NtfyConfig {
  url: string
  topic: string
  token?: string
}

export function ntfyConfig(): NtfyConfig | null {
  const url = (process.env.NTFY_URL || '').replace(/\/+$/, '')
  const topic = process.env.NTFY_TOPIC
  if (!url || !topic) return null
  return { url, topic, token: process.env.NTFY_TOKEN || undefined }
}

export function isNtfyEnabled(): boolean {
  return ntfyConfig() !== null
}

/**
 * Mirror a blocking permission request to the wrist. Fire-and-forget: any
 * failure (network, Pushover 4xx, missing env) just logs — the web UI remains
 * the source of truth and the request still waits for it.
 */
export async function armPermissionPush(opts: { toolName: string; description: string }): Promise<void> {
  const cfg = pushoverConfig()
  const ntfy = ntfyConfig()
  if (!cfg && !ntfy) return

  // Single-slot guard: never stack pushes (the SDK won't fire a second
  // permission until the first resolves, but be defensive).
  for (const p of pending.values()) {
    if (!p.settled) {
      console.log(`⌚️ Watch bridge: push already pending (${p.toolName}), not arming another`)
      return
    }
  }

  const secret = process.env.WATCH_ACK_SECRET || ''
  const publicUrl = (process.env.OSBORN_PUBLIC_URL || '').replace(/\/+$/, '')
  const frontendUrl = (process.env.OSBORN_FRONTEND_URL || 'https://www.voice-native.com').replace(/\/+$/, '')
  if (!secret || !publicUrl) return

  const now = Date.now()
  const qid = signAckToken(
    { n: randomBytes(12).toString('hex'), a: publicUrl, t: now, e: now + EXPIRE_S * 1000 },
    secret,
  )

  // One record serves both providers: whichever ack lands first settles it.
  const record: PendingPush = {
    qid,
    receipt: '',
    toolName: opts.toolName,
    description: opts.description,
    expiresAt: now + EXPIRE_S * 1000,
    settled: false,
  }

  if (cfg) {
    try {
      const res = await fetch(`${PUSH_API}/messages.json`, {
        method: 'POST',
        body: new URLSearchParams({
          token: cfg.token,
          user: cfg.userKey,
          title: 'Voice Native',
          message: `${opts.description}\n\nTap to approve · ignore to deny`.slice(0, 1000),
          priority: '2',
          retry: String(RETRY_S),
          expire: String(EXPIRE_S),
          callback: `${frontendUrl}${ACK_PATH}/${qid}`,
        }),
      })
      const body = (await res.json().catch(() => ({}))) as { receipt?: string; errors?: string[] }
      if (!res.ok || !body.receipt) {
        console.log(`⌚️ Watch bridge: pushover rejected (${res.status})`, body.errors || '')
      } else {
        record.receipt = body.receipt
      }
    } catch (e) {
      console.log('⌚️ Watch bridge: pushover send failed:', e instanceof Error ? e.message : e)
    }
  }

  if (ntfy) {
    // Approve/Deny buttons hit the SAME signed ack route with ?ans=1|0.
    try {
      const res = await fetch(ntfy.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(ntfy.token ? { Authorization: `Bearer ${ntfy.token}` } : {}),
        },
        body: JSON.stringify({
          topic: ntfy.topic,
          title: 'Voice Native',
          message: opts.description.slice(0, 1000),
          priority: 4,
          tags: ['computer'],
          click: `${frontendUrl}/dashboard`,
          actions: [
            {
              action: 'http',
              label: 'Approve',
              method: 'GET',
              url: `${frontendUrl}${ACK_PATH}/${qid}?ans=1`,
            },
            {
              action: 'http',
              label: 'Deny',
              method: 'GET',
              url: `${frontendUrl}${ACK_PATH}/${qid}?ans=0`,
            },
          ],
        }),
      })
      if (!res.ok) console.log(`⌚️ Watch bridge: ntfy rejected (${res.status})`)
    } catch (e) {
      console.log('⌚️ Watch bridge: ntfy send failed:', e instanceof Error ? e.message : e)
    }
  }

  if (!record.receipt && !ntfy) return // nothing actually sent
  record.expiryTimer = setTimeout(() => void settleExpired(record), EXPIRE_S * 1000 + EXPIRY_GRACE_MS)
  pending.set(qid, record)
  console.log(`⌚️ Watch bridge: armed for ${opts.toolName} (pushover=${cfg ? 'on' : 'off'} ntfy=${ntfy ? 'on' : 'off'}, expires in ${EXPIRE_S}s)`)
}

/**
 * Landing for the frontend ack route. Returns true when a pending push was
 * settled. `allow` defaults to true (Pushover ack semantics = approve); the
 * ntfy Deny button passes false explicitly. Idempotent: a replayed callback
 * or a late ack after another path answered just returns false.
 */
export function handleWatchAck(qid: string, receipt?: string, allow = true): boolean {
  const secret = process.env.WATCH_ACK_SECRET
  if (!secret) return false
  if (!verifyAckToken(qid, secret)) {
    console.log('⌚️ Watch bridge: ack token failed HMAC verification')
    return false
  }
  const record = pending.get(qid)
  if (!record || record.settled) return false
  if (receipt && record.receipt && receipt !== record.receipt) {
    console.log('⌚️ Watch bridge: receipt mismatch — ignoring ack')
    return false
  }

  record.settled = true
  if (record.expiryTimer) clearTimeout(record.expiryTimer)
  pending.delete(qid)
  console.log(`⌚️ Watch bridge: ACKED → ${allow ? 'approve' : 'deny'} ${record.toolName}`)
  resultHandler?.(allow, record.toolName)
  return true
}

/**
 * Expiry path: if Pushover says the notification was never acknowledged,
 * settle as deny and cancel further retries (stops the watch buzzing). If it
 * WAS acknowledged but our callback never landed (delivery hiccup), recover
 * by treating it as approve. ntfy-only records (no receipt) just settle deny.
 */
async function settleExpired(record: PendingPush): Promise<void> {
  if (record.settled) return
  const cfg = pushoverConfig()

  // ntfy-only, or pushover send failed earlier: no receipts API — deny.
  if (!cfg || !record.receipt) {
    record.settled = true
    pending.delete(record.qid)
    console.log(`⌚️ Watch bridge: unacknowledged at expiry → deny ${record.toolName}`)
    resultHandler?.(false, record.toolName)
    return
  }

  try {
    const res = await fetch(`${PUSH_API}/receipts/${record.receipt}.json?token=${encodeURIComponent(cfg.token)}`)
    const body = (await res.json().catch(() => ({}))) as { acknowledged?: number }
    record.settled = true
    pending.delete(record.qid)

    if (body.acknowledged === 1) {
      // Acked but the callback never reached us — recover as approve.
      console.log(`⌚️ Watch bridge: expiry poll found late ack → approve ${record.toolName}`)
      resultHandler?.(true, record.toolName)
    } else {
      console.log(`⌚️ Watch bridge: unacknowledged at expiry → deny ${record.toolName}`)
      resultHandler?.(false, record.toolName)
      // Cancel remaining emergency retries so the wrist stops buzzing.
      void fetch(`${PUSH_API}/receipts/${record.receipt}/cancel.json`, {
        method: 'POST',
        body: new URLSearchParams({ token: cfg.token }),
      }).catch(() => {})
    }
  } catch (e) {
    // Poll failed — settle deny; the record is dropped either way.
    console.log('⌚️ Watch bridge: receipts poll failed:', e instanceof Error ? e.message : e)
    record.settled = true
    pending.delete(record.qid)
    resultHandler?.(false, record.toolName)
  }
}
