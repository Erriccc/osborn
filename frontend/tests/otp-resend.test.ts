// Run: cd frontend && npx tsx tests/otp-resend.test.ts
import assert from 'node:assert/strict'
import {
  RESEND_COOLDOWN_MS, RESEND_FAILED_MESSAGE, RESEND_RATE_LIMIT_MESSAGE,
  cooldownSecondsLeft, resendLabel, sendErrorMessage, sentNotice,
} from '../src/lib/otp-resend'

assert.equal(RESEND_COOLDOWN_MS, 60_000)
assert.equal(cooldownSecondsLeft(null, 1000), 0)
assert.equal(cooldownSecondsLeft(1000, 1000), 60)
assert.equal(cooldownSecondsLeft(1000, 1000 + 18_000), 42)
assert.equal(cooldownSecondsLeft(1000, 1000 + 59_999), 1)
assert.equal(cooldownSecondsLeft(1000, 1000 + 60_000), 0)
assert.equal(cooldownSecondsLeft(1000, 1000 + 999_999), 0)
assert.equal(resendLabel(42, false), 'Resend code in 42s')
assert.equal(resendLabel(0, false), 'Resend code')
assert.equal(resendLabel(0, true), 'Sending…')
assert.equal(resendLabel(10, true), 'Sending…')
assert.equal(sendErrorMessage({ status: 429, message: 'email rate limit exceeded' }), RESEND_RATE_LIMIT_MESSAGE)
assert.equal(sendErrorMessage({ message: 'For security purposes, you can only request this after 42 seconds.' }), RESEND_RATE_LIMIT_MESSAGE)
assert.equal(sendErrorMessage({ code: 'over_email_send_rate_limit' }), RESEND_RATE_LIMIT_MESSAGE)
assert.equal(sendErrorMessage({ status: 500, message: 'boom SMTP internal' }), RESEND_FAILED_MESSAGE)
assert.ok(!sendErrorMessage({ message: 'boom SMTP internal' }).includes('SMTP'))
assert.equal(sendErrorMessage(null), RESEND_FAILED_MESSAGE)
assert.equal(sentNotice('a@b.co'), 'Sent a new code to a@b.co')
console.log('otp-resend: ok')
