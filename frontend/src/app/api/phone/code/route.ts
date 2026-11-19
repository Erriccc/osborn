import { NextResponse } from 'next/server'
import { serviceClient } from '@/lib/sandbox-claims'
import { checkCallCode } from '@/lib/phone-code'

/**
 * POST /api/phone/code — one try at the emailed code of a phone call (#362).
 *
 * Called by the agent that holds the call (agent/src/phone-code.ts) with the
 * keypad digits: `{ roomName, code }`, `Authorization: Bearer <sync token>`.
 * The token names the machine, so the account; a code is only checked for a
 * call that account's machine is in. Replies `{ result: 'ok' | 'wrong' |
 * 'locked' | 'expired' }`; routeCall speaks the matching line.
 */
const MAX_BODY = 1024

export async function POST(request: Request) {
  const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  if (token.length < 16) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const raw = await request.text()
  if (raw.length > MAX_BODY) return NextResponse.json({ error: 'body too large' }, { status: 413 })
  let body: { roomName?: unknown; code?: unknown } = {}
  try { body = JSON.parse(raw) } catch {}
  const { roomName, code } = body
  if (typeof roomName !== 'string' || !roomName.startsWith('call-') || roomName.length > 128 || typeof code !== 'string' || code.length > 16) {
    return NextResponse.json({ error: 'invalid request' }, { status: 400 })
  }
  const admin = serviceClient()
  if (!admin) return NextResponse.json({ error: 'not configured' }, { status: 503 })
  const { data: rows } = await admin.from('instances').select('user_id').eq('sync_token', token).limit(2)
  if (rows?.length !== 1 || typeof rows[0]?.user_id !== 'string') return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const result = await checkCallCode(admin, rows[0].user_id, roomName, code)
  return NextResponse.json({ result })
}
