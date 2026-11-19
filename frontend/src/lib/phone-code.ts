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
 *
 * Risk (founder decision): the emailed code is also a valid web login code until used.
 * Avoiding that needs our own hashed code and a non-login email path, which the repo lacks.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createSupabaseAnon } from '@/lib/supabase-anon'

export const CALL_CODE_TTL_MS = 5 * 60_000
export const CALL_CODE_MAX_TRIES = 3
/** Wrong codes an account may type per day across all its calls (a redial would otherwise reset the 3 tries). */
export const CALL_CODE_DAILY_MISS_CAP = 6
const DAY_MS = 24 * 3600_000
const CODE_FORMAT = /^[0-9]{6}$/

export const CODE_PROMPT_LINE = "I've emailed you a code. Type it on your keypad."
export const CODE_RETRY_LINE = "That code didn't match. Please try again."
export const CODE_LOCKED_LINE = "That code didn't match, so I'm ending the call to keep your account safe. Goodbye."
export const CODE_EXPIRED_LINE = 'The code has expired. Please call again. Goodbye.'
export const CODE_SEND_FAILED_LINE = "I couldn't email you a code just now. Please call again in a minute. Goodbye."
export const CODE_DAILY_LIMIT_LINE = "There have been too many wrong codes today, so I can't take this call. Please use the app. Goodbye."

export interface CallCodeRow {
  room_name: string
  user_id: string
  created_at?: string
  expires_at: string
  /** Tries counted, each before its check runs. */
  attempts: number
  /** Tries whose check has come back wrong. */
  misses: number
  verified_at: string | null
}

export type CallCodeStatus = 'open' | 'verified' | 'locked' | 'expired'
/** The agent's view of one try: matched, wrong (tries left), over, or not checked (`error`: try again). */
export type CallCodeResult = 'ok' | 'wrong' | 'locked' | 'expired' | 'error'

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

/** Wrong codes in the account's rows created within the last 24 h. */
export function dailyMisses(rows: Pick<CallCodeRow, 'misses' | 'created_at'>[], now: number): number {
  return rows
    .filter((r) => Date.parse(r.created_at ?? '') > now - DAY_MS)
    .reduce((n, r) => n + (r.misses || 0), 0)
}

/**
 * Only Supabase's "invalid or expired token" answer is a wrong code. A rate
 * limit, network error or 5xx says nothing about the code.
 */
export function isWrongCodeError(error: { code?: unknown; status?: unknown; message?: unknown } | null | undefined): boolean {
  if (!error) return false
  if (error.code === 'otp_expired') return true
  return error.status === 403 && /expired|invalid/i.test(String(error.message ?? ''))
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

/** The account's wrong codes today, or null when they cannot be read. */
async function readDailyMisses(admin: SupabaseClient, userId: string, now: number): Promise<{ misses: number; rooms: string[] } | null> {
  const { data, error } = await admin.from('phone_call_codes')
    .select('room_name, misses, created_at')
    .eq('user_id', userId)
    .gte('created_at', new Date(now - DAY_MS).toISOString())
  if (error || !Array.isArray(data)) return null
  return { misses: dailyMisses(data as CallCodeRow[], now), rooms: data.map((r: { room_name: string }) => r.room_name) }
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
): Promise<'sent' | 'already-open' | 'daily-limit' | 'no-email' | 'send-failed'> {
  const today = await readDailyMisses(admin, userId, now)
  if (!today) return 'send-failed'
  // A repeated webhook for the same call: the first routing owns its code.
  if (today.rooms.includes(roomName)) return 'already-open'
  if (today.misses >= CALL_CODE_DAILY_MISS_CAP) return 'daily-limit'
  const email = await accountEmail(admin, userId)
  if (!email) return 'no-email'
  const anon = createSupabaseAnon()
  if (!anon) return 'send-failed'
  // Old windows are of no further use.
  await admin.from('phone_call_codes').delete().lt('expires_at', new Date(now - DAY_MS).toISOString())
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
  const today = await readDailyMisses(admin, userId, now)
  if (!today) return 'error'
  if (today.misses >= CALL_CODE_DAILY_MISS_CAP) {
    // Locks this call too, so routeCall speaks the goodbye.
    await admin.from('phone_call_codes').update({ attempts: CALL_CODE_MAX_TRIES, misses: CALL_CODE_MAX_TRIES }).eq('room_name', roomName)
    return 'locked'
  }
  const attempts = row!.attempts + 1
  const { data: claimed } = await admin.from('phone_call_codes')
    .update({ attempts })
    .eq('room_name', roomName)
    .eq('attempts', row!.attempts)
    .is('verified_at', null)
    .select('room_name')
  if (!claimed?.length) return 'wrong'

  // Gives the claimed try back when the code could not be checked.
  const notChecked = async (why: string): Promise<CallCodeResult> => {
    console.warn(`[phone] code for ${roomName} not checked: ${why}`)
    await admin.from('phone_call_codes').update({ attempts: row!.attempts }).eq('room_name', roomName).eq('attempts', attempts)
    return 'error'
  }
  // A malformed code is the caller's doing: it uses a try without reaching Supabase.
  let matched = false
  if (CODE_FORMAT.test(code)) {
    const email = await accountEmail(admin, userId)
    // A fresh anon client: verifyOtp signs in, and that session must not stick to a shared client.
    const anon = createSupabaseAnon()
    if (!email || !anon) return notChecked(!email ? 'no account email' : 'no Supabase client')
    let reply: Awaited<ReturnType<typeof anon.auth.verifyOtp>>
    try {
      reply = await anon.auth.verifyOtp({ email, token: code, type: 'email' })
    } catch (e) {
      return notChecked((e as Error).message)
    }
    const { data, error } = reply
    if (error && !isWrongCodeError(error)) return notChecked(`${error.status ?? '?'} ${error.code ?? ''}`.trim())
    if (!error && !data?.session) return notChecked('no session in the reply')
    matched = !error
    // The check signed the account in; that session is not wanted.
    const jwt = data?.session?.access_token
    if (jwt) {
      const out = await admin.auth.admin.signOut(jwt, 'local').catch((e: Error) => ({ error: e }))
      if (out?.error) console.warn(`[phone] could not revoke the sign-in made by the code check for ${roomName}: ${out.error.message}`)
    }
  }
  // Tries run one at a time per call (the agent waits for each answer), so this is the latest count.
  await admin.from('phone_call_codes')
    .update(matched ? { verified_at: new Date(now).toISOString() } : { misses: attempts })
    .eq('room_name', roomName)
  return callCodeOutcome(matched, attempts)
}
