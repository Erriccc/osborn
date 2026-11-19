'use client'

import type { SupabaseClient, User } from '@supabase/supabase-js'
import { useState } from 'react'
import { SettingsRow } from '@/components/settings/ui'
import { toUsE164 } from '@/lib/phone'

/**
 * Settings → Account → Phone calls (#361). One step, two records: the number
 * is verified with a code on WhatsApp (Supabase phone change, so it lands in
 * auth.users.phone), and the consent box stamps instances.call_consent_at
 * through set_call_consent (migration 021). Inputs follow EmailOtpLogin.
 */

const SHARED_NUMBER = process.env.NEXT_PUBLIC_OSBORN_PHONE_NUMBER || ''

const inputClass = 'min-h-[44px] w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--background)] px-2.5 text-[15px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]'
const primaryClass = 'min-h-[44px] rounded-lg bg-[var(--accent)] px-3 text-[13px] font-semibold text-[var(--background)] disabled:opacity-50'
const secondaryClass = 'min-h-[44px] rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-2)] px-3 text-[13px] font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]'

export default function PhoneCalls({ supabase, user, consentAt, onUser, onConsent }: {
  supabase: SupabaseClient
  user: User
  consentAt: string | null
  onUser: (u: User) => void
  onConsent: (at: string | null) => void
}) {
  const verified = user.phone && user.phone_confirmed_at ? `+${user.phone.replace(/^\+/, '')}` : null
  const [editing, setEditing] = useState(false)
  const [step, setStep] = useState<'phone' | 'code'>('phone')
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function saveConsent(next: boolean): Promise<boolean> {
    const { data, error } = await supabase.rpc('set_call_consent', { p_consent: next })
    if (error) { setError(error.message); return false }
    onConsent((data as string | null) ?? null)
    return true
  }

  async function send(e: React.FormEvent) {
    e.preventDefault()
    const e164 = toUsE164(phone)
    if (!e164) { setError('Enter a US phone number'); return }
    setBusy(true); setError(null)
    const { error } = await supabase.auth.updateUser({ phone: e164 })
    setBusy(false)
    if (error) setError(error.message)
    else { setPhone(e164); setStep('code') }
  }

  async function verify(value: string) {
    if (value.length < 6 || busy) return
    setBusy(true); setError(null)
    const { data, error } = await supabase.auth.verifyOtp({ phone: phone, token: value, type: 'phone_change' })
    if (error || !data.user) { setBusy(false); setError(error?.message || 'Could not verify the code'); return }
    onUser(data.user)
    // A new number needs its own consent: stamp it now, or clear an old one.
    const saved = await saveConsent(consent)
    setBusy(false)
    if (saved) { setEditing(false); setStep('phone'); setCode('') }
  }

  async function toggleConsent() {
    setBusy(true); setError(null)
    await saveConsent(!consentAt)
    setBusy(false)
  }

  const errorLine = error ? <p className="mt-2 text-[13px] text-red-400">{error}</p> : null

  if (verified && !editing) {
    return (
      <>
        <SettingsRow label="Phone calls" sublabel={`Calls from ${verified}${SHARED_NUMBER ? ` to ${SHARED_NUMBER}` : ''} reach your Osborn`}>
          <button onClick={() => { setEditing(true); setError(null) }} className={secondaryClass}>Change</button>
        </SettingsRow>
        <SettingsRow label="Osborn may call me" sublabel={consentAt ? `Agreed ${new Date(consentAt).toLocaleDateString()}. Only covers Osborn calling you` : 'Osborn may call this number with an automated voice. Calling Osborn works either way'}>
          <input type="checkbox" checked={!!consentAt} disabled={busy} onChange={toggleConsent} aria-label="Osborn may call me" className="h-5 w-5 accent-[var(--accent)]" />
        </SettingsRow>
        {errorLine && <div className="px-4 pb-3">{errorLine}</div>}
      </>
    )
  }

  return (
    <SettingsRow stacked label="Phone calls" sublabel={`Verify your US number with a code on WhatsApp. Once it is verified you can call ${SHARED_NUMBER || 'the Osborn number'} from it to talk to your Osborn.`}>
      {step === 'phone' ? (
        <form onSubmit={send} className="flex flex-col gap-2">
          <input type="tel" inputMode="tel" autoComplete="tel" placeholder="(555) 123-4567" value={phone}
            onChange={(e) => { setPhone(e.target.value); if (error) setError(null) }} className={inputClass} />
          <label className="flex items-start gap-2 text-[12px] leading-snug text-[var(--text-secondary)]">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]" />
            Osborn may call this number with an automated voice. Optional, and only about Osborn calling you: you can call Osborn from this number either way. Change it here any time.
          </label>
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className={primaryClass}>{busy ? 'Sending…' : 'Send code on WhatsApp'}</button>
            {verified && <button type="button" onClick={() => { setEditing(false); setError(null) }} className={secondaryClass}>Cancel</button>}
          </div>
        </form>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); verify(code) }} className="flex flex-col gap-2">
          <p className="text-[13px] text-[var(--text-muted)]">Enter the 6-digit code sent on WhatsApp to <span className="font-medium text-[var(--text-primary)]">{phone}</span></p>
          <input type="text" inputMode="numeric" autoComplete="one-time-code" placeholder="______" value={code} autoFocus
            onChange={(e) => {
              const v = e.target.value.replace(/[^0-9]/g, '').slice(0, 6)
              setCode(v)
              if (v.length === 6) verify(v) // auto-submit on paste / autofill
            }}
            className={`${inputClass} text-center text-[22px] font-bold tracking-[0.4em]`} />
          <div className="flex gap-2">
            <button type="submit" disabled={busy || code.length < 6} className={primaryClass}>{busy ? 'Verifying…' : 'Verify'}</button>
            <button type="button" onClick={() => { setStep('phone'); setCode(''); setError(null) }} className={secondaryClass}>Use a different number</button>
          </div>
        </form>
      )}
      {errorLine}
    </SettingsRow>
  )
}
