import { NextResponse } from 'next/server'
import { serviceClient } from '@/lib/sandbox-claims'
import { checkCallCode } from '@/lib/phone-code'
import { PHONE_ROOM_PREFIX } from '@/lib/phone'
import { bearerToken, syncTokenUserId } from '@/lib/sync-token-auth'

/**
 * POST /api/phone/code — one try at the emailed code of a phone call (#362).
 *
 * Called by the agent that holds the call (agent/src/phone-code.ts) with the
 * keypad digits: `{ roomName, code }`, `Authorization: Bearer <sync token>`.
 * The token names the machine, so the account; a code is only checked for a
 * call that account's machine is in. Replies `{ result: 'ok' | 'wrong' |
 * 'locked' | 'expired' }`, or 503 `{ result: 'error' }` when the code could
 * not be checked; routeCall speaks the matching line.
 */
const MAX_BODY = 1024

export async function POST(request: Request) {
  const token = bearerToken(request)
  if (token.length < 16) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const raw = await request.text()
  if (raw.length > MAX_BODY) return NextResponse.json({ error: 'body too large' }, { status: 413 })
  let body: { roomName?: unknown; code?: unknown } = {}
  try { body = JSON.parse(raw) } catch {}
  const { roomName, code } = body
  if (typeof roomName !== 'string' || !roomName.startsWith(PHONE_ROOM_PREFIX) || roomName.length > 128 || typeof code !== 'string' || code.length > 16) {
    return NextResponse.json({ error: 'invalid request' }, { status: 400 })
  }
  const admin = serviceClient()
  if (!admin) return NextResponse.json({ error: 'not configured' }, { status: 503 })
  const userId = await syncTokenUserId(admin, token)
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const result = await checkCallCode(admin, userId, roomName, code)
  // 'error': the code was not checked (Supabase or network trouble); the try was given back.
  return NextResponse.json({ result }, { status: result === 'error' ? 503 : 200 })
}
