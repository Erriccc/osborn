export default function FeatureMemory() {
  return (
    <section id="features" className="scroll-mt-20">
      <div className="mx-auto max-w-[1200px] px-6 py-20 md:py-24 border-t border-[var(--border-subtle)]">
        <div className="grid md:grid-cols-2 gap-10 md:gap-16 items-center">
          <div>
            <span className="font-mono text-[11px] md:text-[12px] uppercase tracking-[0.18em] text-[var(--accent)]">
              Memory
            </span>
            <h2 className="font-display mt-4 text-[var(--text-primary)] text-[clamp(1.75rem,4vw,2.6rem)] leading-[1.08] tracking-[-0.02em] font-semibold">
              It remembers your project. Every session.
            </h2>
            <p className="mt-5 max-w-[34rem] text-[var(--text-secondary)] text-[16px] leading-[1.65]">
              Osborn keeps per-session memory with semantic recall — decisions you made,
              the shape of your codebase, the bug you chased last Tuesday. Pick up exactly
              where you left off instead of re-explaining your stack every single time.
            </p>
          </div>

          {/* Recall sliver */}
          <div
            className="rounded-2xl border border-[var(--border)] p-5"
            style={{ background: 'var(--surface)' }}
            aria-hidden="true"
          >
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--text-muted)]">
              recalled from this project
            </span>
            <ul className="mt-4 flex flex-col gap-3">
              {[
                'auth uses Supabase + httpOnly cookies',
                'you prefer tabs over spaces in this repo',
                'last session: fixed the deploy flake in CI',
                'billing lives in src/billing/stripe.ts',
              ].map((line) => (
                <li key={line} className="flex items-start gap-2.5 font-mono text-[12px] text-[var(--text-secondary)]">
                  <span className="mt-[2px] text-[var(--accent)]">↳</span>
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  )
}
