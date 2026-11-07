'use client'

// Small, dismissible microphone banner above the composer (bug 7cf00ae6).
// In-flow (never fixed/overlay), so it can never cover Send, Close or any
// other button. Shown once per browser session per problem; see
// lib/mic-permission.ts for the rules and the per-platform copy.
import { useEffect, useState } from 'react'
import { micHelp, type MicErrorKind } from '@/lib/mic-permission'

export function MicBanner({ kind, onRetry, onDismiss }: {
  kind: MicErrorKind
  onRetry: () => void
  onDismiss: () => void
}) {
  // UA is read after mount so server and client render the same markup.
  const [env, setEnv] = useState<{ ua: string; maxTouchPoints?: number }>({ ua: '' })
  useEffect(() => {
    setEnv({ ua: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints })
  }, [])
  const help = micHelp(kind, env)
  return (
    <div role="status" aria-live="polite" data-testid="mic-banner"
      className="mx-3 mt-1.5 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] leading-snug text-amber-100">
      <svg className="w-4 h-4 mt-0.5 shrink-0 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-14 0m7 7v3m0-3a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
      </svg>
      <div className="min-w-0 flex-1">
        <span className="font-semibold text-amber-200">{help.title}.</span>{' '}
        <span className="text-amber-100/80">{help.body}</span>
      </div>
      <button onClick={onRetry}
        className="shrink-0 rounded-md bg-amber-400 px-2 py-1 text-[11px] font-semibold text-black hover:bg-amber-300">
        Try again
      </button>
      <button onClick={onDismiss} aria-label="Dismiss microphone notice"
        className="shrink-0 -mr-1 rounded p-1 text-amber-200/70 hover:bg-amber-500/20 hover:text-amber-100">
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
      </button>
    </div>
  )
}
