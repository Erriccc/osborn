/**
 * phone-code.ts — the emailed code that admits a phone caller (#362).
 *
 * With PHONE_EMAIL_CODE_ENABLED on, the agent joins the caller's room but does
 * not adopt the caller: no voice session, no voice actions, no tools. The
 * frontend emails the account a 6-digit code and tells the caller to type it.
 * Every keypad press goes to the code (never to approvals) until the frontend
 * (POST /api/phone/code, which counts tries and expiry) says it matched; then
 * the caller is adopted as before. Pure parts here; the wiring is in index.ts.
 */
import { RoomServiceClient } from 'livekit-server-sdk'
import { PHONE_EMAIL_CODE_ENABLED, isPhoneCallLive } from './data-sender-auth.js'

export const PHONE_CODE_LENGTH = 6
/** The code's window (CALL_CODE_TTL_MS in frontend/src/lib/phone-code.ts). */
export const PHONE_CODE_TTL_MS = 5 * 60_000
/**
 * The agent ends a call still waiting for its code this long after the step
 * opened, in case the frontend that follows the call is gone. The frontend's
 * own expiry goodbye comes first.
 */
export const PHONE_CODE_TIMEOUT_MS = PHONE_CODE_TTL_MS + 30_000
/** After a locked or expired answer, time for the frontend's goodbye line before the agent hangs up itself. */
export const PHONE_CODE_HANGUP_GRACE_MS = 12_000

/**
 * The frontend's spoken lines (hold #365, code prompt, retry) join a call's
 * room as URL ingress participants: never adopted, and their leaving ends
 * nothing. Independent of PHONE_EMAIL_CODE_ENABLED: it also stops the hold
 * line's leave from tearing down a call the agent has just taken (#365).
 */
export function isPhoneLinePlayer(ingress: boolean, activeRoomName: string | null, phoneRoomName: string | null): boolean {
  return ingress && isPhoneCallLive(activeRoomName, phoneRoomName, true)
}

/** What a phone caller joining gets: the voice session, or the code step first. */
export function phoneCallerAdmission(
  s: { verifiedRoom: string | null; room: string | null },
  codeEnabled = PHONE_EMAIL_CODE_ENABLED,
): 'adopt' | 'code' {
  return codeEnabled && (!s.room || s.verifiedRoom !== s.room) ? 'code' : 'adopt'
}

/**
 * One keypad press during the code step. Digits add up to PHONE_CODE_LENGTH and
 * then submit; `*` starts again; anything else (`#`, letters) is ignored.
 * `holding` (a try is being checked): digits are kept, the last six, and wait
 * for the next try instead of submitting.
 */
export function addCodeDigit(buffer: string, digit: string | undefined | null, holding = false): { buffer: string; submit?: string } {
  if (digit === '*') return { buffer: '' }
  if (typeof digit !== 'string' || !/^[0-9]$/.test(digit)) return { buffer }
  const next = (buffer + digit).slice(-PHONE_CODE_LENGTH)
  return next.length === PHONE_CODE_LENGTH && !holding ? { buffer: '', submit: next } : { buffer: next }
}

/** Digits held during a check that make a full code: submit them when the check comes back. */
export function heldCode(buffer: string): { buffer: string; submit?: string } {
  return buffer.length === PHONE_CODE_LENGTH ? { buffer: '', submit: buffer } : { buffer }
}

export type PhoneCodeResult = 'ok' | 'wrong' | 'locked' | 'expired' | 'error'

/**
 * What the agent does with the answer to a try: take the call, hang up (after
 * the frontend's goodbye) when the code is used up, or keep waiting.
 */
export function phoneCodeAction(result: PhoneCodeResult): 'adopt' | 'hang-up' | 'wait' {
  if (result === 'ok') return 'adopt'
  if (result === 'locked' || result === 'expired') return 'hang-up'
  return 'wait'
}

/**
 * Ends a phone call: removes the SIP caller from the room (LiveKit hangs up
 * the line). False when it could not (no LiveKit config, or the API refused).
 */
export async function removePhoneCaller(
  roomName: string,
  identity: string,
  client: Pick<RoomServiceClient, 'removeParticipant'> | null = defaultRoomService(),
): Promise<boolean> {
  if (!client) return false
  try {
    await client.removeParticipant(roomName, identity)
    return true
  } catch (e) {
    console.warn(`📞 could not hang up ${identity} in ${roomName}: ${(e as Error).message}`)
    return false
  }
}

function defaultRoomService(): RoomServiceClient | null {
  const { LIVEKIT_URL: url, LIVEKIT_API_KEY: key, LIVEKIT_API_SECRET: secret } = process.env
  return url && key && secret ? new RoomServiceClient(url, key, secret) : null
}

/** The frontend's answer to POST /api/phone/code, read strictly: anything unexpected is an error. */
export function readPhoneCodeReply(status: number, body: unknown): PhoneCodeResult {
  const r = (body as { result?: unknown } | null)?.result
  if (status === 200 && (r === 'ok' || r === 'wrong' || r === 'locked' || r === 'expired')) return r
  return 'error'
}

/**
 * Asks the frontend whether `code` is the one emailed for `roomName`. The
 * machine's sync token proves which account is asking.
 */
export async function checkPhoneCode(
  frontendUrl: string,
  syncToken: string | undefined,
  roomName: string,
  code: string,
  fetchFn: typeof fetch = fetch,
): Promise<PhoneCodeResult> {
  if (!syncToken) return 'error'
  try {
    const r = await fetchFn(`${frontendUrl}/api/phone/code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${syncToken}` },
      body: JSON.stringify({ roomName, code }),
      signal: AbortSignal.timeout(15_000),
    })
    return readPhoneCodeReply(r.status, await r.json().catch(() => null))
  } catch {
    return 'error'
  }
}
