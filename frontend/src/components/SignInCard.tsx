import type { ReactNode } from 'react'

/** The signed-out card: a title, a line of why, and one primary Sign in. */
export default function SignInCard({ title, body, href, label, icon, secondary, className = '' }: {
  title: string
  body: string
  href: string
  label: string
  icon?: ReactNode
  /** A quiet text action under the primary one (for example Back). */
  secondary?: { label: string; onClick: () => void }
  className?: string
}) {
  return (
    <div className={`rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-6 text-center ${className}`}>
      {icon && (
        <div className="mx-auto mb-3 w-12 h-12 rounded-2xl bg-[var(--surface-2)] border border-[var(--border-subtle)] flex items-center justify-center">
          {icon}
        </div>
      )}
      <p className="text-[14px] text-[var(--text-primary)] font-medium">{title}</p>
      <p className="mt-1 text-[13px] text-[var(--text-secondary)]">{body}</p>
      <a href={href}
        className="mt-4 inline-flex items-center gap-2 rounded-xl bg-[var(--accent)] text-[var(--background)] px-4 py-2.5 text-[13px] font-semibold hover:opacity-90 active:scale-[0.98] transition-all">
        {label}
      </a>
      {secondary && (
        <div className="mt-3">
          <button type="button" onClick={secondary.onClick} className="text-[13px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] underline underline-offset-2 transition-colors">{secondary.label}</button>
        </div>
      )}
    </div>
  )
}
