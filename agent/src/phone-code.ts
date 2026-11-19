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
import { PHONE_EMAIL_CODE_ENABLED } from './data-sender-auth.js'

export const PHONE_CODE_LENGTH = 6

/** What a phone caller joining gets: the voice session, or the code step first. */
export function phoneCallerAdmission(
  s: { verifiedRoom: string | null; room: string | null },
  codeEnabled = PHONE_EMAIL_CODE_ENABLED,
): 'adopt' | 'code' {
  return codeEnabled && (!s.room || s.verifiedRoom !== s.room) ? 'code' : 'adopt'
}

/** Where a keypad press goes: the code while the code step is open, else approvals. */
export function phoneKeypadTarget(codeStepOpen: boolean): 'code' | 'approvals' {
  return codeStepOpen ? 'code' : 'approvals'
}

/**
 * One keypad press during the code step. Digits add up to PHONE_CODE_LENGTH and
 * then submit; `*` starts again; anything else (`#`, letters) is ignored.
 */
export function addCodeDigit(buffer: string, digit: string | undefined | null): { buffer: string; submit?: string } {
  if (digit === '*') return { buffer: '' }
  if (typeof digit !== 'string' || !/^[0-9]$/.test(digit)) return { buffer }
  const next = (buffer + digit).slice(-PHONE_CODE_LENGTH)
  return next.length === PHONE_CODE_LENGTH ? { buffer: '', submit: next } : { buffer: next }
}

export type PhoneCodeResult = 'ok' | 'wrong' | 'locked' | 'expired' | 'error'

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
