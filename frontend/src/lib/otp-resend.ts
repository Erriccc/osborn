// Pure rules for the sign-in "Resend code" control (EmailOtpLogin).
// Supabase allows one OTP email per address every 60 seconds by default.
export const RESEND_COOLDOWN_MS = 60_000

export const OTP_EXPIRY_NOTE = 'Codes expire after a while.'
export const RESEND_RATE_LIMIT_MESSAGE = 'Please wait a minute before asking for another code.'
export const RESEND_FAILED_MESSAGE = 'Could not send a new code. Check your connection and try again.'

/** Whole seconds left before a resend is allowed (0 = allowed now). */
export function cooldownSecondsLeft(sentAt: number | null, now: number): number {
  if (sentAt == null) return 0
  return Math.max(0, Math.ceil((sentAt + RESEND_COOLDOWN_MS - now) / 1000))
}

export function resendLabel(secondsLeft: number, sending: boolean): string {
  if (sending) return 'Sending…'
  return secondsLeft > 0 ? `Resend code in ${secondsLeft}s` : 'Resend code'
}

/** Plain-words message for a failed send; never the raw provider string. */
export function sendErrorMessage(err: { status?: number; code?: string; message?: string } | null | undefined): string {
  if (!err) return RESEND_FAILED_MESSAGE
  const text = `${err.code ?? ''} ${err.message ?? ''}`.toLowerCase()
  if (err.status === 429 || text.includes('rate') || text.includes('seconds') || text.includes('too many')) {
    return RESEND_RATE_LIMIT_MESSAGE
  }
  return RESEND_FAILED_MESSAGE
}

export function sentNotice(email: string): string {
  return `Sent a new code to ${email}`
}
