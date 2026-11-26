'use client'

import type { SupabaseClient } from '@supabase/supabase-js'
import { useEffect, useRef, useState } from 'react'
import { SIGN_IN_BUTTON_STYLE } from '@/components/SignInCard'
import { OTP_NEWEST_NOTE, cooldownSecondsLeft, otpSendError, otpVerifyError, resendLabel, sentAtForWait } from '@/lib/otp-resend'

/**
 * Email OTP (6-digit code) login — app-wide auth that needs no OAuth provider,
 * no redirect, and no third-party OAuth app. Same flow the native app uses, so
 * web + mobile share one auth path. On success, the parent's
 * onAuthStateChange redirects to /dashboard.
 *
 * Requires the Supabase "Magic Link" email template to include {{ .Token }}.
 */
export default function EmailOtpLogin({ supabase }: { supabase: SupabaseClient }) {
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState<null | 'send' | 'verify' | 'resend'>(null)
  const codeRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [sentAt, setSentAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const secondsLeft = cooldownSecondsLeft(sentAt, now)

  useEffect(() => {
    if (secondsLeft <= 0) return
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [secondsLeft > 0])

  function requestCode() {
    return supabase.auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: true } })
  }

  async function send(e: React.FormEvent) {
    e.preventDefault()
    if (!email.includes('@')) { setError('Enter a valid email'); return }
    setBusy('send'); setError(null)
    const { error } = await requestCode()
    setBusy(null)
    if (error) setError(otpSendError(error, 'first').message)
    else { setSentAt(Date.now()); setNow(Date.now()); setNotice(null); setStep('code') }
  }

  async function resend() {
    if (busy || secondsLeft > 0) return
    setBusy('resend'); setError(null); setNotice(null)
    const { error } = await requestCode()
    setBusy(b => (b === 'resend' ? null : b))
    const t = Date.now()
    setNow(t)
    if (error) {
      const { message, waitSeconds } = otpSendError(error, 'resend')
      setError(message)
      if (waitSeconds != null) setSentAt(sentAtForWait(waitSeconds, t))
      return
    }
    setSentAt(t); setCode(''); setNotice(`Sent a new code to ${email.trim()}.`)
    codeRef.current?.focus()
  }

  async function verify(value: string) {
    if (value.length < 6 || busy === 'verify' || busy === 'send') return
    setBusy(b => (b === 'resend' ? b : 'verify')); setError(null)
    const { error } = await supabase.auth.verifyOtp({ email: email.trim(), token: value.trim(), type: 'email' })
    setBusy(b => (b === 'verify' ? null : b))
    if (error) setError(otpVerifyError(error))
    // success → parent onAuthStateChange sends to /dashboard
  }

  if (step === 'email') {
    return (
      <form onSubmit={send} className="flex flex-col gap-2">
        <input
          type="email"
          aria-label="Email address"
          inputMode="email"
          autoComplete="email"
          placeholder="you@email.com"
          value={email}
          onChange={(e) => { setEmail(e.target.value); if (error) setError(null) }}
          className="w-full h-11 bg-[var(--background)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] text-[15px] px-3 outline-none focus:border-[var(--accent)]"
        />
        <button
          type="submit"
          disabled={busy === 'send'}
          className="w-full h-11 rounded-lg font-semibold text-[15px] transition-all active:scale-[0.98] disabled:opacity-50"
          style={SIGN_IN_BUTTON_STYLE}
        >
          {busy === 'send' ? 'Sending…' : 'Email me a code'}
        </button>
        {error ? <p className="text-red-400 text-[13px] text-center">{error}</p> : null}
      </form>
    )
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); verify(code) }} className="flex flex-col gap-2">
      <p className="text-[var(--text-muted)] text-[13px] text-center">
        Enter the 6-digit code sent to <span className="text-[var(--text-primary)] font-medium">{email}</span>
      </p>
      <input
        type="text"
        inputMode="numeric"
        aria-label="6-digit code"
        autoComplete="one-time-code"
        placeholder="______"
        ref={codeRef}
        value={code}
        autoFocus
        onChange={(e) => {
          const v = e.target.value.replace(/[^0-9]/g, '').slice(0, 6)
          setCode(v)
          if (v.length === 6) verify(v) // auto-submit on paste / autofill
        }}
        className="w-full h-14 bg-[var(--background)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] text-[26px] font-bold tracking-[0.4em] text-center px-3 outline-none focus:border-[var(--accent)]"
      />
      <p className="text-[var(--text-muted)] text-[12px] text-center">{OTP_NEWEST_NOTE}</p>
      <button
        type="submit"
        disabled={busy === 'verify' || code.length < 6}
        className="w-full h-11 rounded-lg font-semibold text-[15px] transition-all active:scale-[0.98] disabled:opacity-50"
        style={SIGN_IN_BUTTON_STYLE}
      >
        {busy === 'verify' ? 'Verifying…' : 'Verify'}
      </button>
      <button type="button" onClick={resend} disabled={busy !== null || secondsLeft > 0} className="text-[var(--text-muted)] text-[13px] hover:text-[var(--text-primary)] disabled:opacity-50 disabled:hover:text-[var(--text-muted)]">
        {resendLabel(secondsLeft, busy === 'resend')}
      </button>
      <button type="button" disabled={busy === 'resend'} onClick={() => { setStep('email'); setCode(''); setError(null); setNotice(null); setSentAt(null) }} className="text-[var(--text-muted)] text-[13px] hover:text-[var(--text-primary)] disabled:opacity-50">
        Use a different email
      </button>
      <p role="status" className="text-[var(--text-muted)] text-[13px] text-center empty:hidden">{notice}</p>
      <p role="alert" className="text-red-400 text-[13px] text-center empty:hidden">{error}</p>
    </form>
  )
}
