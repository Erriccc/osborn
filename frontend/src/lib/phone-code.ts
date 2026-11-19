/**
 * phone-code.ts — the emailed code that admits a phone call (#362). Server-only.
 *
 * Supabase Auth makes the code: signInWithOtp emails it (the Magic Link
 * template with {{ .Token }}, the same email EmailOtpLogin sends), stores it
 * hashed and makes it single-use; verifyOtp checks it. A `phone_call_codes`
 * row per call (migration 022) adds what Supabase does not: a 5-minute window
 * and 3 tries, shared by every frontend instance. The agent collects the
 * keypad digits and asks POST /api/phone/code; routeCall (phone-calls.ts)
 * watches the row to speak the retry and goodbye lines.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export const CALL_CODE_TTL_MS = 5 * 60_000
export const CALL_CODE_MAX_TRIES = 3
const CODE_FORMAT = /^[0-9]{6}$/

export const CODE_PROMPT_LINE = "I've emailed you a code. Type it on your keypad."
export const CODE_RETRY_LINE = "That code didn't match. Please try again."
export const CODE_LOCKED_LINE = "That code didn't match, so I'm ending the call to keep your account safe. Goodbye."
export const CODE_EXPIRED_LINE = 'The code has expired. Please call again. Goodbye.'
export const CODE_SEND_FAILED_LINE = "I couldn't email you a code just now. Please call again in a minute. Goodbye."

export interface CallCodeRow {
  room_name: string
  user_id: string
  expires_at: string
  /** Tries counted, each before its check runs. */
  attempts: number
  /** Tries whose check has come back wrong. */
  misses: number
  verified_at: string | null
}

export type CallCodeStatus = 'open' | 'verified' | 'locked' | 'expired'
/** The agent's view of one try: matched, wrong (tries left), or over. */
export type CallCodeResult = 'ok' | 'wrong' | 'locked' | 'expired'

/**
 * Where a call's code stands, counting `tries`: 'attempts' to decide whether
 * another try may start, 'misses' for what the caller has been told (a try in
 * flight is neither a miss nor a lock yet). A missing row counts as expired.
 */
export function callCodeStatus(
  row: Pick<CallCodeRow, 'expires_at' | 'attempts' | 'misses' | 'verified_at'> | null,
  now: number,
  tries: 'attempts' | 'misses' = 'attempts',
): CallCodeStatus {
  if (!row) return 'expired'
  if (row.verified_at) return 'verified'
  if (row[tries] >= CALL_CODE_MAX_TRIES) return 'locked'
  if (!(Date.parse(row.expires_at) > now)) return 'expired'
  return 'open'
}

/** The answer to a try that was counted (`attempts` includes it). */
export function callCodeOutcome(matched: boolean, attempts: number): CallCodeResult {
  if (matched) return 'ok'
  return attempts >= CALL_CODE_MAX_TRIES ? 'locked' : 'wrong'
}

/** The answer to a try the row refuses before any check (no try is counted). */
export function refusedTry(status: CallCodeStatus): CallCodeResult | null {
  if (status === 'verified') return 'ok'
  if (status === 'locked') return 'locked'
  if (status === 'expired') return 'expired'
  return null
}

/**
 * What the waiting call does next, from the row and the misses it has already
 * answered: 'retry' when a new wrong try came back and tries are left.
 */
export function callCodeNext(seenMisses: number, row: CallCodeRow | null, now: number): 'wait' | 'retry' | CallCodeStatus {
  const status = callCodeStatus(row, now, 'misses')
  if (status !== 'open') return status
  return row!.misses > seenMisses ? 'retry' : 'wait'
}

/** A fresh anon client per use: verifyOtp signs in, and that session must not stick to a shared client. */
function anonClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
}

async function accountEmail(admin: SupabaseClient, userId: string): Promise<string | null> {
  const { data, error } = await admin.auth.admin.getUserById(userId)
  const email = data?.user?.email
  return !error && typeof email === 'string' && email ? email : null
}

/** Opens the call's code window and emails the code (once per call). */
export async function startCallCode(
  admin: SupabaseClient,
  userId: string,
  roomName: string,
  now = Date.now(),
): Promise<'sent' | 'already-open' | 'no-email' | 'send-failed'> {
  const email = await accountEmail(admin, userId)
  if (!email) return 'no-email'
  const anon = anonClient()
  if (!anon) return 'send-failed'
  // Old windows are of no further use.
  await admin.from('phone_call_codes').delete().lt('expires_at', new Date(now - 24 * 3600_000).toISOString())
  const { error: rowError } = await admin.from('phone_call_codes').insert({
    room_name: roomName,
    user_id: userId,
    expires_at: new Date(now + CALL_CODE_TTL_MS).toISOString(),
  })
  // A repeated webhook for the same call: the first routing owns its code.
  if (rowError?.code === '23505') return 'already-open'
  if (rowError) {
    console.warn(`[phone] could not open a code window for ${roomName}: ${rowError.message}`)
    return 'send-failed'
  }
  const { error } = await anon.auth.signInWithOtp({ email, options: { shouldCreateUser: false } })
  if (error) {
    console.warn(`[phone] code email for ${roomName} failed: ${error.message}`)
    return 'send-failed'
  }
  return 'sent'
}

export async function readCallCode(admin: SupabaseClient, roomName: string): Promise<CallCodeRow | null> {
  const { data } = await admin.from('phone_call_codes')
    .select('room_name, user_id, expires_at, attempts, misses, verified_at')
    .eq('room_name', roomName)
    .maybeSingle()
  return (data as CallCodeRow | null) ?? null
}

/**
 * One try at the code for `roomName`, asked by the machine of `userId`. The
 * try is counted before Supabase checks the code, and only when the count it
 * read is still current, so concurrent tries cannot exceed the limit.
 */
export async function checkCallCode(
  admin: SupabaseClient,
  userId: string,
  roomName: string,
  code: string,
  now = Date.now(),
): Promise<CallCodeResult> {
  const row = await readCallCode(admin, roomName)
  if (row && row.user_id !== userId) return 'expired'
  const refused = refusedTry(callCodeStatus(row, now))
  if (refused) return refused
  const attempts = row!.attempts + 1
  const { data: claimed } = await admin.from('phone_call_codes')
    .update({ attempts })
    .eq('room_name', roomName)
    .eq('attempts', row!.attempts)
    .is('verified_at', null)
    .select('room_name')
  if (!claimed?.length) return 'wrong'

  let matched = false
  if (CODE_FORMAT.test(code)) {
    const email = await accountEmail(admin, userId)
    const anon = anonClient()
    if (email && anon) {
      const { data, error } = await anon.auth.verifyOtp({ email, token: code, type: 'email' })
      matched = !error && !!data?.session
      // The check signed the account in; that session is not wanted.
      if (data?.session?.access_token) await admin.auth.admin.signOut(data.session.access_token, 'local').catch(() => {})
    }
  }
  // Tries run one at a time per call (the agent waits for each answer), so this is the latest count.
  await admin.from('phone_call_codes')
    .update(matched ? { verified_at: new Date(now).toISOString() } : { misses: attempts })
    .eq('room_name', roomName)
  return callCodeOutcome(matched, attempts)
}
