import { NextRequest, NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * GET/POST /api/watch/ack/[qid] — Pushover emergency-ack callback (mobile
 * Track 1, the watchOS wrist bridge).
 *
 * When the agent hits a blocking permission request, agent/src/pushover.ts
 * fires a priority-2 Pushover notification (mirrored to the Apple Watch) with
 * this route as the callback. Tapping the notification on the wrist makes
 * Pushover's servers request this URL with `receipt=<id>&acknowledged=1`.
 *
 * The `qid` path segment is an HMAC-signed token minted by the agent
 * (payload: nonce, the AGENT's public base URL, issued/expiry ms — signed
 * with WATCH_ACK_SECRET, which this deployment also holds). Verification here
 * is stateless: check the signature + expiry, then POST the ack to the agent
 * base URL embedded in the payload (/watch/ack), where it is matched against
 * the pending push and resolved as approve. Settled semantics: ack = yes,
 * expiry (never tapped) = no.
 *
 * Returns 200 on "handled" (including deliberately ignored replays) so
 * Pushover doesn't retry forever; non-200 only for malformed requests.
 */

const GRACE_MS = 60_000 // past payload expiry, for clock skew

function verify(qid: string): { agentUrl: string } | null {
  const secret = process.env.WATCH_ACK_SECRET
  if (!secret) return null
  const dot = qid.lastIndexOf('.')
  if (dot <= 0) return null
  const body = qid.slice(0, dot)
  const sig = qid.slice(dot + 1)
  const expected = createHmac('sha256', secret).update(body).digest()
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')) as {
      a?: string
      t?: number
      e?: number
    }
    if (typeof payload.a !== 'string' || !/^https?:\/\//.test(payload.a)) return null
    // Reject stale links: expired more than GRACE ago can't settle anything.
    if (typeof payload.e === 'number' && Date.now() > payload.e + GRACE_MS) return null
    return { agentUrl: payload.a.replace(/\/+$/, '') }
  } catch {
    return null
  }
}

async function handle(qid: string, receipt: string | null): Promise<NextResponse> {
  const verified = qid ? verify(qid) : null
  if (!verified) {
    // Bad signature / stale / not configured — 200 so Pushover stops retrying,
    // but nothing is settled (the agent's expiry poll will deny).
    return NextResponse.json({ ok: false, reason: 'invalid-token' })
  }

  try {
    const res = await fetch(`${verified.agentUrl}/watch/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ qid, receipt: receipt ?? undefined }),
      signal: AbortSignal.timeout(10_000),
    })
    return NextResponse.json({ ok: res.ok, forwarded: res.ok }, { status: res.ok ? 200 : 200 })
  } catch {
    // Agent unreachable — the receipts-poll recovery in pushover.ts settles it
    // (late-ack recovery approves at expiry if Pushover says acknowledged=1).
    return NextResponse.json({ ok: false, reason: 'agent-unreachable' })
  }
}

export async function GET(req: NextRequest, { params }: { params: { qid: string } }): Promise<NextResponse> {
  // Pushover delivers callbacks with parameters in the query string.
  const receipt = req.nextUrl.searchParams.get('receipt')
  return handle(params.qid, receipt)
}

export async function POST(req: NextRequest, { params }: { params: { qid: string } }): Promise<NextResponse> {
  // Also accept form-encoded POST bodies (Pushover's documented fallback).
  let receipt = req.nextUrl.searchParams.get('receipt')
  if (!receipt) {
    try {
      const form = await req.formData()
      receipt = form.get('receipt') as string | null
    } catch {
      // not form data — treat as no receipt (agent matches on qid alone)
    }
  }
  return handle(params.qid, receipt)
}
