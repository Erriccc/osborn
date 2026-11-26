// Pure rules for the sign-in code controls (EmailOtpLogin).
// Supabase allows one OTP email per address every 60 seconds by default.
const RESEND_COOLDOWN_MS = 60_000

export const OTP_NEWEST_NOTE = 'Only the newest code works.'
const CODE_REJECTED_MESSAGE = 'That code did not work. Codes expire, and a new request replaces the old one.'
const VERIFY_FAILED_MESSAGE = 'Could not check the code. Try again.'
const CODE_LIMIT_MESSAGE = 'Too many codes requested. Try again later.'
const NETWORK_MESSAGE = 'Could not reach the server. Check your connection and try again.'

type AuthErr = { status?: number; code?: string; name?: string; message?: string } | null | undefined

/** Whole seconds left before a resend is allowed (0 = allowed now). */
export function cooldownSecondsLeft(sentAt: number | null, now: number): number {
  if (sentAt == null) return 0
  return Math.max(0, Math.ceil((sentAt + RESEND_COOLDOWN_MS - now) / 1000))
}

/** A `sentAt` that makes cooldownSecondsLeft report `seconds` at `now`. */
export function sentAtForWait(seconds: number, now: number): number {
  return now + seconds * 1000 - RESEND_COOLDOWN_MS
}

export function resendLabel(secondsLeft: number, sending: boolean): string {
  if (sending) return 'Sending…'
  return secondsLeft > 0 ? `Resend code in ${secondsLeft}s` : 'Resend code'
}

const isNetwork = (e: NonNullable<AuthErr>) => e.name === 'AuthRetryableFetchError' || /failed to fetch/i.test(e.message ?? '')

/** Plain-words message for a failed send, never the raw provider string. `waitSeconds` is the server's wait, if it gave one. */
export function otpSendError(err: AuthErr, kind: 'first' | 'resend'): { message: string; waitSeconds: number | null } {
  const what = kind === 'first' ? 'a code' : 'a new code'
  if (!err) return { message: `Could not send ${what}. Try again.`, waitSeconds: null }
  const text = (err.message ?? '').toLowerCase()
  const secs = /after (\d+) seconds/i.exec(err.message ?? '')
  if (secs) {
    const n = Number(secs[1])
    return { message: `Please wait ${n} seconds before asking for another code.`, waitSeconds: n }
  }
  if (err.status === 429 || err.code === 'over_email_send_rate_limit' || err.code === 'over_request_rate_limit' || /rate limit|rate_limit|too many/.test(text)) {
    return { message: CODE_LIMIT_MESSAGE, waitSeconds: null }
  }
  if (isNetwork(err)) return { message: NETWORK_MESSAGE, waitSeconds: null }
  return { message: `Could not send ${what}. Try again.`, waitSeconds: null }
}

/** Plain-words message for a failed code check. */
export function otpVerifyError(err: AuthErr): string {
  if (!err) return VERIFY_FAILED_MESSAGE
  if (err.code === 'otp_expired' || /expired|invalid/i.test(err.message ?? '')) return CODE_REJECTED_MESSAGE
  if (isNetwork(err)) return NETWORK_MESSAGE
  return VERIFY_FAILED_MESSAGE
}
