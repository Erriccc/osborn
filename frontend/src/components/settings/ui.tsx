'use client'

import type { ReactNode } from 'react'

// ── Shared presentational primitives for the Settings page ──
// These are layout-only; all state/handlers live in the page. Styling matches
// the shipped dark/amber system (--background/--surface/--surface-2/
// --border-subtle/--accent/--text-*, font-display serif headings).

// A titled section with a serif heading + optional description. Content is a
// flush-divider stack of rows.
export function SettingsSection({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: ReactNode
}) {
  return (
    <section className="mb-10">
      <div className="mb-3">
        <h2 className="font-display text-xl font-medium text-[var(--text-primary)] tracking-tight">{title}</h2>
        {description && <p className="mt-1 text-[13px] leading-snug text-[var(--text-secondary)]">{description}</p>}
      </div>
      <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] divide-y divide-[var(--border-subtle)]">
        {children}
      </div>
    </section>
  )
}

// One flush row: a label (+ optional sublabel) on the left, a control on the
// right. 44px min height for tap targets.
export function SettingsRow({
  label,
  sublabel,
  children,
  stacked,
}: {
  label?: ReactNode
  sublabel?: ReactNode
  children?: ReactNode
  stacked?: boolean
}) {
  if (stacked) {
    return (
      <div className="px-4 py-3.5">
        {label && <div className="text-[13px] font-medium text-[var(--text-primary)]">{label}</div>}
        {sublabel && <div className="mt-0.5 text-[12px] leading-snug text-[var(--text-muted)]">{sublabel}</div>}
        <div className="mt-2.5">{children}</div>
      </div>
    )
  }
  return (
    <div className="flex min-h-[44px] items-center justify-between gap-3 px-4 py-3">
      {(label || sublabel) && (
        <div className="min-w-0">
          {label && <div className="text-[13px] font-medium text-[var(--text-primary)]">{label}</div>}
          {sublabel && <div className="mt-0.5 text-[12px] leading-snug text-[var(--text-muted)]">{sublabel}</div>}
        </div>
      )}
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  )
}

// Accessible on/off switch. aria-pressed + aria-label are required props so
// every toggle is labelled. prefers-reduced-motion disables the slide.
export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean
  onChange: () => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-pressed={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border-2 transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)] disabled:opacity-50 motion-reduce:transition-none ${
        checked ? 'border-[var(--accent)] bg-[var(--accent)]' : 'border-[var(--border-subtle)] bg-[var(--surface-2)]'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 motion-reduce:transition-none ${
          checked ? 'translate-x-5' : 'translate-x-0.5'
        }`}
      />
    </button>
  )
}
