import Link from 'next/link'

export default function FinalCTA() {
  return (
    <section aria-labelledby="final-cta-heading">
      <div className="mx-auto max-w-[1200px] px-6 py-24 md:py-32">
        <div
          className="relative overflow-hidden rounded-3xl border border-[var(--border)] px-8 py-16 md:px-16 md:py-24 text-center"
          style={{ background: 'var(--surface)' }}
        >
          {/* Single ambient glow */}
          <div
            className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[560px] h-[560px] rounded-full"
            style={{ background: 'radial-gradient(circle, var(--accent-glow) 0%, transparent 70%)' }}
            aria-hidden="true"
          />

          <div className="relative flex flex-col items-center">
            <h2
              id="final-cta-heading"
              className="font-display text-[var(--text-primary)] text-[clamp(2.25rem,6vw,4rem)] leading-[1.02] tracking-[-0.03em] font-semibold"
            >
              Stop typing prompts.
              <br />
              <span className="italic text-[var(--accent)]">Start talking.</span>
            </h2>

            <Link
              href="/login"
              className="mt-10 h-13 px-8 py-3.5 inline-flex items-center justify-center rounded-xl text-[16px] font-semibold tracking-[-0.01em] transition-all duration-150 active:scale-[0.98]"
              style={{
                background: 'linear-gradient(135deg, var(--accent) 0%, var(--accent-dim) 100%)',
                color: 'var(--background)',
                boxShadow: '0 1px 2px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.12)',
              }}
            >
              Start talking — free
            </Link>

            <p className="mt-6 font-mono text-[12px] text-[var(--text-muted)] tracking-[0.02em]">
              Your code never leaves your machine · Bring your own keys · No lock-in
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}
