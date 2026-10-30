'use client'

import type { SupabaseClient } from '@supabase/supabase-js'
import { useState } from 'react'

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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function send(e: React.FormEvent) {
    e.preventDefault()
    if (!email.includes('@')) { setError('Enter a valid email'); return }
    setBusy(true); setError(null)
    const { error } = await supabase.auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: true } })
    setBusy(false)
    if (error) setError(error.message)
    else setStep('code')
  }

  async function verify(value: string) {
    if (value.length < 6 || busy) return
    setBusy(true); setError(null)
    const { error } = await supabase.auth.verifyOtp({ email: email.trim(), token: value.trim(), type: 'email' })
    setBusy(false)
    if (error) setError(error.message)
    // success → parent onAuthStateChange sends to /dashboard
  }

  if (step === 'email') {
    return (
      <form onSubmit={send} className="flex flex-col gap-2">
        <input
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="you@email.com"
          value={email}
          onChange={(e) => { setEmail(e.target.value); if (error) setError(null) }}
          className="w-full h-11 bg-[var(--background)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] text-[15px] px-3 outline-none focus:border-[var(--accent)]"
        />
        <button
          type="submit"
          disabled={busy}
          className="w-full h-11 rounded-lg font-semibold text-[15px] transition-all active:scale-[0.98] disabled:opacity-50"
          style={{ background: 'linear-gradient(135deg, var(--accent) 0%, var(--accent-dim) 100%)', color: 'var(--background)' }}
        >
          {busy ? 'Sending…' : 'Email me a code'}
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
        autoComplete="one-time-code"
        placeholder="______"
        value={code}
        autoFocus
        onChange={(e) => {
          const v = e.target.value.replace(/[^0-9]/g, '').slice(0, 6)
          setCode(v)
          if (v.length === 6) verify(v) // auto-submit on paste / autofill
        }}
        className="w-full h-14 bg-[var(--background)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] text-[26px] font-bold tracking-[0.4em] text-center px-3 outline-none focus:border-[var(--accent)]"
      />
      <button
        type="submit"
        disabled={busy || code.length < 6}
        className="w-full h-11 rounded-lg font-semibold text-[15px] transition-all active:scale-[0.98] disabled:opacity-50"
        style={{ background: 'linear-gradient(135deg, var(--accent) 0%, var(--accent-dim) 100%)', color: 'var(--background)' }}
      >
        {busy ? 'Verifying…' : 'Verify'}
      </button>
      <button type="button" onClick={() => { setStep('email'); setCode(''); setError(null) }} className="text-[var(--text-muted)] text-[13px] hover:text-[var(--text-primary)]">
        Use a different email
      </button>
      {error ? <p className="text-red-400 text-[13px] text-center">{error}</p> : null}
    </form>
  )
}
