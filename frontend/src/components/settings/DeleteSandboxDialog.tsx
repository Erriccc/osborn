'use client'

import { useEffect, useRef, useState } from 'react'

// Focus-trapped confirm dialog for the destructive "Delete sandbox" action.
// Sprites does NOT soft-delete — overlay + persistent disk + checkpoints are
// gone for good. The friction here (type the word "delete") replaces the old
// two-tap arm with something that can't be fat-fingered. Cancel is focused
// first so an accidental Enter/Space dismisses rather than deletes.
export default function DeleteSandboxDialog({
  open,
  onCancel,
  onConfirm,
}: {
  open: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const [value, setValue] = useState('')
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)

  const confirmEnabled = value.trim().toLowerCase() === 'delete'

  // Reset the typed word each time the dialog opens, and focus Cancel first.
  useEffect(() => {
    if (!open) return
    setValue('')
    const id = requestAnimationFrame(() => cancelRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [open])

  // Esc to dismiss + focus trap (Tab cycles within the dialog only).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
        return
      }
      if (e.key !== 'Tab') return
      const root = dialogRef.current
      if (!root) return
      const focusable = root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input, [tabindex]:not([tabindex="-1"])'
      )
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onCancel])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[400] flex items-center justify-center bg-black/60 p-4 motion-safe:animate-[fadeIn_.15s_ease]"
      onClick={onCancel}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-sandbox-title"
        aria-describedby="delete-sandbox-desc"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-2xl border border-red-500/40 bg-[var(--surface)] p-5 shadow-2xl"
      >
        <h3 id="delete-sandbox-title" className="font-display text-lg font-semibold text-red-400">
          Delete sandbox
        </h3>
        <p id="delete-sandbox-desc" className="mt-1.5 text-[13px] leading-relaxed text-[var(--text-secondary)]">
          This permanently destroys your cloud machine — overlay, persistent
          disk, and checkpoints. There is no recovery. Switches you back to
          local. To confirm, type <span className="font-mono font-semibold text-[var(--text-primary)]">delete</span> below.
        </p>
        <label htmlFor="delete-confirm-input" className="sr-only">
          Type the word delete to confirm
        </label>
        <input
          id="delete-confirm-input"
          type="text"
          value={value}
          autoComplete="off"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && confirmEnabled) onConfirm()
          }}
          placeholder="delete"
          className="mt-4 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-3 py-2.5 text-[16px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)]/50 focus-visible:border-red-400/60 focus-visible:outline-none"
        />
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="min-h-[44px] rounded-lg px-4 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!confirmEnabled}
            className="min-h-[44px] rounded-lg bg-red-500 px-4 text-sm font-semibold text-white transition-colors hover:bg-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Delete sandbox
          </button>
        </div>
      </div>
    </div>
  )
}
