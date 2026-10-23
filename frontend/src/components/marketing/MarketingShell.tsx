import Link from 'next/link'
import type { ReactNode } from 'react'

/**
 * Shared chrome for the marketing routes (/compare, /use-cases/*).
 *
 * Matches the landing brand: dark surfaces, Fraunces display, JetBrains mono
 * eyebrows, amber accent. Pure server component — no client JS. Provides a
 * slim top bar (wordmark + login) and a footer, around arbitrary children.
 */
export default function MarketingShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      <header className="border-b border-[var(--border-subtle)]">
        <nav
          aria-label="Primary"
          className="mx-auto flex max-w-[1200px] items-center justify-between px-6 py-5"
        >
          <Link
            href="/"
            className="font-display text-[18px] font-semibold tracking-[-0.01em] text-[var(--text-primary)]"
          >
            Voice Native
          </Link>
          <div className="flex items-center gap-5 font-mono text-[12px] uppercase tracking-[0.14em]">
            <Link
              href="/blog"
              className="text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
            >
              Blog
            </Link>
            <Link
              href="/industries"
              className="hidden sm:inline text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
            >
              Industries
            </Link>
            <Link
              href="/compare"
              className="text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
            >
              Compare
            </Link>
            <Link
              href="/use-cases"
              className="text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
            >
              Use cases
            </Link>
            <Link
              href="/login"
              className="rounded-full border border-[var(--border)] px-4 py-1.5 text-[var(--text-primary)] transition-colors hover:border-[var(--accent)]"
            >
              Log in
            </Link>
          </div>
        </nav>
      </header>

      <main>{children}</main>

      <footer className="border-t border-[var(--border-subtle)]">
        <div className="mx-auto flex max-w-[1200px] flex-col gap-3 px-6 py-10 text-[13px] text-[var(--text-muted)] sm:flex-row sm:items-center sm:justify-between">
          <span className="font-display text-[15px] text-[var(--text-secondary)]">
            Voice Native
          </span>
          <span className="font-mono text-[11px] uppercase tracking-[0.14em]">
            Talk to it. It ships.
          </span>
        </div>
      </footer>
    </div>
  )
}
