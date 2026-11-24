import type { CSSProperties, ReactNode } from 'react'

/** The primary sign-in button's fill (the /login form and this card). */
export const SIGN_IN_BUTTON_STYLE: CSSProperties = { background: 'linear-gradient(135deg, var(--accent) 0%, var(--accent-dim) 100%)', color: 'var(--background)' }

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
        <div className="mx-auto mb-3 w-12 h-12 rounded-2xl bg-surface-2 border border-[var(--border)] text-[var(--text-primary)] flex items-center justify-center">
          {icon}
        </div>
      )}
      <p className="text-[14px] text-[var(--text-primary)] font-medium">{title}</p>
      <p className="mt-1 text-[13px] text-[var(--text-secondary)]">{body}</p>
      <a href={href}
        style={SIGN_IN_BUTTON_STYLE}
        className="mt-4 inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-5 text-[15px] font-semibold hover:opacity-90 active:scale-[0.98] transition-all">
        {label}
      </a>
      {secondary && (
        <div className="mt-3">
          <button type="button" onClick={secondary.onClick} className="text-[13px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] underline underline-offset-2 transition-colors">{secondary.label}</button>
        </div>
      )}
    </div>
  )
}
