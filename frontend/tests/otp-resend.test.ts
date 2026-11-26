// Run: cd frontend && npx tsx tests/otp-resend.test.ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CODE_LIMIT_MESSAGE, CODE_REJECTED_MESSAGE, NETWORK_MESSAGE, OTP_NEWEST_NOTE, VERIFY_FAILED_MESSAGE,
  cooldownSecondsLeft, otpSendError, otpVerifyError, resendLabel, sentAtForWait,
} from '../src/lib/otp-resend'

assert.equal(cooldownSecondsLeft(null, 1000), 0)
assert.equal(cooldownSecondsLeft(1000, 1000), 60)
assert.equal(cooldownSecondsLeft(1000, 1000 + 18_000), 42)
assert.equal(cooldownSecondsLeft(1000, 1000 + 59_999), 1)
assert.equal(cooldownSecondsLeft(1000, 1000 + 60_000), 0)
assert.equal(cooldownSecondsLeft(sentAtForWait(42, 5000), 5000), 42)
assert.equal(cooldownSecondsLeft(sentAtForWait(90, 5000), 5000), 90)
assert.equal(resendLabel(42, false), 'Resend code in 42s')
assert.equal(resendLabel(0, false), 'Resend code')
assert.equal(resendLabel(10, true), 'Sending…')

const wait = otpSendError({ message: 'For security purposes, you can only request this after 42 seconds.' }, 'resend')
assert.deepEqual(wait, { message: 'Please wait 42 seconds before asking for another code.', waitSeconds: 42 })
assert.equal(otpSendError({ status: 429, code: 'over_email_send_rate_limit', message: 'x after 7 seconds' }, 'first').waitSeconds, 7)
assert.deepEqual(otpSendError({ code: 'over_email_send_rate_limit' }, 'resend'), { message: CODE_LIMIT_MESSAGE, waitSeconds: null })
assert.equal(otpSendError({ message: 'email rate limit exceeded' }, 'resend').message, CODE_LIMIT_MESSAGE)
assert.equal(otpSendError({ status: 429 }, 'first').message, CODE_LIMIT_MESSAGE)
// code/status wins over unrelated text
assert.equal(otpSendError({ status: 429, message: 'boom' }, 'first').message, CODE_LIMIT_MESSAGE)
assert.equal(otpSendError({ code: 'over_email_send_rate_limit', message: 'boom' }, 'first').message, CODE_LIMIT_MESSAGE)
// "generate" contains "rate" but is not a rate limit
assert.equal(otpSendError({ status: 500, message: 'Unable to generate a code' }, 'resend').message, 'Could not send a new code. Try again.')
assert.equal(otpSendError({ status: 500, message: 'boom SMTP internal' }, 'first').message, 'Could not send a code. Try again.')
assert.ok(!otpSendError({ message: 'boom SMTP internal' }, 'first').message.includes('SMTP'))
assert.equal(otpSendError(null, 'first').message, 'Could not send a code. Try again.')
assert.equal(otpSendError({ name: 'AuthRetryableFetchError', message: 'x' }, 'first').message, NETWORK_MESSAGE)
assert.equal(otpSendError({ message: 'Failed to fetch' }, 'resend').message, NETWORK_MESSAGE)
assert.equal(otpSendError({ message: 'Failed to fetch' }, 'resend').waitSeconds, null)

assert.equal(otpVerifyError({ code: 'otp_expired', message: 'x' }), CODE_REJECTED_MESSAGE)
assert.equal(otpVerifyError({ message: 'Token has expired or is invalid' }), CODE_REJECTED_MESSAGE)
assert.equal(otpVerifyError({ name: 'AuthRetryableFetchError', message: 'Failed to fetch' }), NETWORK_MESSAGE)
assert.equal(otpVerifyError({ status: 500, message: 'SMTP boom' }), VERIFY_FAILED_MESSAGE)
assert.equal(OTP_NEWEST_NOTE, 'Only the newest code works.')

// Wiring (source-level)
const src = readFileSync(join(__dirname, '..', 'src', 'components', 'EmailOtpLogin.tsx'), 'utf8')
assert.ok(/busy === 'verify' \? 'Verifying…'/.test(src), 'Verify label depends on verify only')
assert.ok(!/resending/.test(src), 'no separate resending flag')
assert.ok(/otpSendError\(error, 'first'\)/.test(src), 'email step uses the shared mapper')
assert.ok(!/setError\(error\.message\)/.test(src), 'no raw provider error shown')
assert.ok(/disabled=\{busy === 'resend'\}[^>]*onClick=\{\(\) => \{ setStep\('email'\)/.test(src), 'change-email disabled while resending')
assert.ok(/ref=\{codeRef\}/.test(src) && /codeRef\.current\?\.focus\(\)/.test(src), 'code input focused after resend')
assert.ok(/<p role="status"[^>]*>\{notice\}<\/p>/.test(src) && /<p role="alert"/.test(src), 'status and alert containers always mounted')
assert.ok(!/<input[^>]*disabled/.test(src.slice(src.indexOf('aria-label="6-digit code"'), src.indexOf('aria-label="6-digit code"') + 700)), 'code input stays editable')
console.log('otp-resend: ok')
