import Link from 'next/link'

/**
 * FooterV2 — quiet close. No GitHub (not wired). Server component.
 */
export default function FooterV2() {
  return (
    <footer className="border-t border-[var(--border-subtle)]">
      <div className="mx-auto max-w-[1200px] px-6 py-10 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <span className="font-display text-[16px] tracking-[-0.01em] font-semibold text-[var(--text-primary)]">
          Voice <span className="italic text-[var(--accent)]">Native</span>
        </span>
        <div className="flex items-center gap-6">
          <Link
            href="/login"
            className="font-mono text-[12px] uppercase tracking-[0.14em] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
          >
            Take the wheel
          </Link>
          <span className="font-mono text-[11px] text-[var(--text-muted)]">
            voice-native.com
          </span>
        </div>
      </div>
    </footer>
  )
}
