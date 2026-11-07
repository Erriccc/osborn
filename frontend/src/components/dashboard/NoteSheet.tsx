'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * NoteSheet — open a saved voice note (UI item 26 gap 4): full text,
 * attachments, Copy, and Delete with ONE confirm step. Delete is permanent
 * (hard delete via DELETE /api/notes?id=, owner-checked server-side; no undo).
 * Focus starts on Close so a stray Enter never deletes; Esc closes (or backs
 * out of the confirm step); Tab is trapped inside the sheet.
 */

export interface SheetNote { id: string; text: string; created_at: string; attachments?: string[] }

export function noteCopyText(note: { text: string; attachments?: string[] }): string {
  const atts = note.attachments || []
  return atts.length ? `${note.text}\n${atts.join('\n')}` : note.text
}

/** href for an attachment only when it parses as an http(s) URL; else null (render as text). */
export function safeAttachmentHref(u: string): string | null {
  try {
    const url = new URL(u)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

/** Display label: last path segment, URL-decoded; raw string if decoding fails (malformed %). */
export function attachmentLabel(u: string): string {
  const raw = u.split('/').pop() || u
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

export default function NoteSheet({
  note,
  onClose,
  onDeleted,
}: {
  note: SheetNote | null
  onClose: () => void
  onDeleted: (id: string) => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  const sheetRef = useRef<HTMLDivElement | null>(null)
  const open = !!note

  // Save the element that opened the sheet; restore focus to it on close.
  useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    return () => { if (prev && typeof prev.focus === 'function' && prev.isConnected) prev.focus() }
  }, [open])

  // Reset per note; focus Close first.
  useEffect(() => {
    if (!open) return
    setConfirming(false); setBusy(false); setError(null); setCopied(false)
    const id = requestAnimationFrame(() => closeRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [open, note?.id])

  // Entering the confirm step focuses Cancel (safe default).
  useEffect(() => {
    if (!confirming) return
    const id = requestAnimationFrame(() => cancelRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [confirming])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (busy) return
        if (confirming) setConfirming(false)
        else onClose()
        return
      }
      if (e.key !== 'Tab') return
      const root = sheetRef.current
      if (!root) return
      const focusable = root.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, confirming, busy, onClose])

  if (!note) return null
  const atts = note.attachments || []

  const copy = () => {
    navigator.clipboard.writeText(noteCopyText(note)).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 1500) },
      () => setError('Could not copy to the clipboard.'),
    )
  }

  const doDelete = async () => {
    setBusy(true); setError(null)
    try {
      const r = await fetch(`/api/notes?id=${encodeURIComponent(note.id)}`, { method: 'DELETE' })
      // 404 = already gone (or never ours): either way it should leave the list.
      if (r.ok || r.status === 404) { onDeleted(note.id); return }
      const j = await r.json().catch(() => ({}))
      setError(r.status === 401 ? 'You are signed out. Sign in again to delete this note.' : (j.error || 'Could not delete the note.'))
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
    }
    setBusy(false)
    setConfirming(false)
  }

  return (
    <div
      className="fixed inset-0 z-[400] flex items-end sm:items-center justify-center bg-black/60 sm:p-4 motion-safe:animate-[fadeIn_.15s_ease]"
      onClick={() => { if (!busy) onClose() }}
    >
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="note-sheet-title"
        onClick={e => e.stopPropagation()}
        className="w-full sm:max-w-lg max-h-[85vh] flex flex-col rounded-t-2xl sm:rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] shadow-2xl"
      >
        <div className="flex items-center gap-2 px-5 pt-4 pb-3 border-b border-[var(--border-subtle)]">
          <h3 id="note-sheet-title" className="text-sm font-semibold text-[var(--text-primary)]">Note</h3>
          <span className="text-[11px] text-[var(--text-muted)]">{new Date(note.created_at).toLocaleString()}</span>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close note"
            className="ml-auto min-h-[44px] min-w-[44px] -mr-2 rounded-lg flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto">
          <p className="text-[14px] leading-relaxed text-[var(--text-primary)] whitespace-pre-wrap break-words">{note.text}</p>
          {atts.length > 0 && (
            <ul className="mt-4 space-y-1.5" aria-label="Attachments">
              {atts.map(u => {
                const href = safeAttachmentHref(u)
                const label = attachmentLabel(u)
                return (
                  <li key={u}>
                    {href ? (
                      <a href={href} target="_blank" rel="noopener noreferrer"
                        className="text-[12px] text-[var(--accent)] hover:underline break-all">
                        {label}
                      </a>
                    ) : (
                      <span className="text-[12px] text-[var(--text-secondary)] break-all">{label}</span>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {error && <p role="alert" className="px-5 pb-2 text-[12px] text-red-400">{error}</p>}

        <div className="flex items-center gap-2 px-5 py-3 border-t border-[var(--border-subtle)]">
          {confirming ? (
            <>
              <span className="text-[13px] text-[var(--text-secondary)] mr-auto">Delete this note for good? This cannot be undone.</span>
              <button
                ref={cancelRef}
                type="button"
                onClick={() => setConfirming(false)}
                disabled={busy}
                className="min-h-[44px] rounded-lg px-4 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={doDelete}
                disabled={busy}
                className="min-h-[44px] rounded-lg bg-red-500 px-4 text-sm font-semibold text-white hover:bg-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 disabled:opacity-50"
              >
                {busy ? 'Deleting…' : 'Delete'}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="min-h-[44px] rounded-lg px-3 text-sm text-red-400 hover:text-red-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
              >
                Delete
              </button>
              <button
                type="button"
                onClick={copy}
                className="ml-auto min-h-[44px] rounded-lg bg-[var(--accent)] px-4 text-sm font-semibold text-[var(--background)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                {copied ? 'Copied' : atts.length ? 'Copy with attachments' : 'Copy'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
