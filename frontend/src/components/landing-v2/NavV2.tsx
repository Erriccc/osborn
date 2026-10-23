import Link from 'next/link'

/**
 * NavV2 — minimal, calm top bar for the V2 preview. Server component.
 * Transparent over the hero; the amber wordmark + a single CTA. No GitHub.
 */
export default function NavV2() {
  return (
    <header className="absolute top-0 inset-x-0 z-30">
      <nav className="mx-auto max-w-[1200px] px-6 h-16 flex items-center justify-between">
        <Link
          href="/v2"
          className="font-display text-[18px] tracking-[-0.01em] font-semibold text-[var(--text-primary)]"
        >
          Voice <span className="italic text-[var(--accent)]">Native</span>
        </Link>

        <div className="flex items-center gap-5">
          <a
            href="#assemble"
            className="hidden sm:inline font-mono text-[12px] uppercase tracking-[0.14em] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
          >
            How it drives
          </a>
          <Link
            href="/login"
            className="h-9 px-4 inline-flex items-center justify-center rounded-lg text-[13px] font-semibold tracking-[-0.01em] transition-all duration-150 active:scale-[0.98]"
            style={{
              background: 'linear-gradient(135deg, var(--accent) 0%, var(--accent-dim) 100%)',
              color: 'var(--background)',
              boxShadow: '0 1px 2px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.12)',
            }}
          >
            Take the wheel
          </Link>
        </div>
      </nav>
    </header>
  )
}
