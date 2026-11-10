'use client'

import React, { useEffect, useRef, useState } from 'react'
import { submitBugReport, type BugReportSeverity, type BugReportType } from '@/lib/bug-report'

type Props = {
  open: boolean
  onClose: () => void
}

const SEVERITIES: BugReportSeverity[] = ['low', 'medium', 'high', 'critical']

// In-app "Report a bug" form. Posts to /api/report, which inserts into the
// bug_reports table as the signed-in user (RLS-scoped) AND mirrors the report to
// GitHub Issues server-side (issue #44). This is the manual counterpart to the
// voice bug-reporter skill — the test run flagged that there was no non-voice way to file.
export function ReportBugModal({ open, onClose }: Props) {
  const [type, setType] = useState<BugReportType>('bug')
  const [severity, setSeverity] = useState<BugReportSeverity>('medium')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [repro, setRepro] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [doneId, setDoneId] = useState<string | null>(null)
  const titleRef = useRef<HTMLInputElement | null>(null)

  // Reset + focus when it opens.
  useEffect(() => {
    if (!open) return
    setError(null); setDoneId(null); setBusy(false)
    const id = setTimeout(() => titleRef.current?.focus(), 40)
    return () => clearTimeout(id)
  }, [open])

  // Escape to close (unless mid-submit).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy, onClose])

  if (!open) return null

  const submit = async () => {
    setBusy(true); setError(null)
    const res = await submitBugReport({
      type, severity, title, description,
      reproduction_notes: repro || undefined,
      osborn_version: 'web',
      metadata: {
        source: 'web-direct',
        path: typeof window !== 'undefined' ? window.location.pathname : undefined,
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 300) : undefined,
      },
    })
    setBusy(false)
    if (res.ok) { setDoneId(res.id ?? 'ok'); setTitle(''); setDescription(''); setRepro('') }
    else setError(res.error)
  }

  const canSubmit = title.trim().length >= 3 && description.trim().length > 0 && !busy

  return (
    <div
      className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center bg-black/60 p-0 sm:p-4"
      onClick={() => { if (!busy) onClose() }}
      role="dialog"
      aria-modal="true"
      aria-label="Report a bug"
    >
      <div
        className="w-full sm:max-w-md max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border border-neutral-700 bg-neutral-900 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {doneId ? (
          <div className="py-4 text-center">
            <div className="text-2xl">🪲</div>
            <h2 className="mt-2 text-base font-semibold text-neutral-100">Thanks — report filed</h2>
            <p className="mt-1 text-sm text-neutral-400">The team will see it. You can file another or close this.</p>
            <div className="mt-5 flex gap-2">
              <button className="flex-1 rounded-lg border border-neutral-700 px-3 py-2 text-sm text-neutral-200 hover:bg-neutral-800" onClick={() => setDoneId(null)}>File another</button>
              <button className="flex-1 rounded-lg bg-amber-500 px-3 py-2 text-sm font-medium text-black hover:bg-amber-400" onClick={onClose}>Done</button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-neutral-100">Report a bug</h2>
              <button aria-label="Close" className="rounded-md p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200" onClick={() => { if (!busy) onClose() }}>✕</button>
            </div>
            <p className="mt-1 text-xs text-neutral-500">Problems with Osborn itself (voice, the app, crashes) — not your project's own code.</p>

            {/* Type */}
            <div className="mt-4 inline-flex rounded-lg border border-neutral-700 p-0.5 text-sm">
              {(['bug', 'feature'] as BugReportType[]).map((tp) => (
                <button key={tp} onClick={() => setType(tp)}
                  className={`rounded-md px-3 py-1 capitalize ${type === tp ? 'bg-amber-500 text-black' : 'text-neutral-300 hover:bg-neutral-800'}`}>
                  {tp === 'bug' ? 'Bug' : 'Feature'}
                </button>
              ))}
            </div>

            {/* Severity */}
            <div className="mt-4">
              <label className="text-xs font-medium text-neutral-400">Severity</label>
              <div className="mt-1 grid grid-cols-4 gap-1">
                {SEVERITIES.map((s) => (
                  <button key={s} onClick={() => setSeverity(s)}
                    className={`rounded-md border px-2 py-1.5 text-xs capitalize ${severity === s ? 'border-amber-500 bg-amber-500/15 text-amber-300' : 'border-neutral-700 text-neutral-400 hover:bg-neutral-800'}`}>
                    {s}
                  </button>
                ))}
              </div>
            </div>

            {/* Title */}
            <div className="mt-4">
              <label className="text-xs font-medium text-neutral-400">Title</label>
              <input ref={titleRef} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200}
                placeholder="Short summary"
                className="mt-1 w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-base text-neutral-100 placeholder-neutral-600 outline-none focus:border-amber-500 sm:text-sm" />
            </div>

            {/* Description */}
            <div className="mt-3">
              <label className="text-xs font-medium text-neutral-400">What happened</label>
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} maxLength={8000}
                placeholder="What you expected vs. what happened"
                className="mt-1 w-full resize-y rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-base text-neutral-100 placeholder-neutral-600 outline-none focus:border-amber-500 sm:text-sm" />
            </div>

            {/* Repro (optional) */}
            <div className="mt-3">
              <label className="text-xs font-medium text-neutral-400">Steps to reproduce <span className="text-neutral-600">(optional)</span></label>
              <textarea value={repro} onChange={(e) => setRepro(e.target.value)} rows={2} maxLength={4000}
                className="mt-1 w-full resize-y rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-base text-neutral-100 placeholder-neutral-600 outline-none focus:border-amber-500 sm:text-sm" />
            </div>

            {error && <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>}

            <div className="mt-5 flex gap-2">
              <button className="flex-1 rounded-lg border border-neutral-700 px-3 py-2 text-sm text-neutral-200 hover:bg-neutral-800" onClick={() => { if (!busy) onClose() }} disabled={busy}>Cancel</button>
              <button className="flex-1 rounded-lg bg-amber-500 px-3 py-2 text-sm font-medium text-black hover:bg-amber-400 disabled:opacity-50" onClick={submit} disabled={!canSubmit}>
                {busy ? 'Sending…' : 'Submit'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
