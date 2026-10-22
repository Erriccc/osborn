import Link from 'next/link'

export default function PricingTeaser() {
  return (
    <section id="pricing" className="scroll-mt-20">
      <div className="mx-auto max-w-[1200px] px-6 py-20 md:py-28">
        <div className="max-w-[40rem]">
          <span className="font-mono text-[11px] md:text-[12px] uppercase tracking-[0.18em] text-[var(--accent)]">
            Pricing
          </span>
          <h2 className="font-display mt-4 text-[var(--text-primary)] text-[clamp(2rem,4.5vw,3rem)] leading-[1.05] tracking-[-0.02em] font-semibold">
            Start free. Scale when you&rsquo;re ready.
          </h2>
        </div>

        <div className="mt-14 grid md:grid-cols-2 gap-5">
          {/* Free */}
          <div
            className="rounded-2xl border border-[var(--border)] p-8 flex flex-col"
            style={{ background: 'var(--surface)' }}
          >
            <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--text-secondary)]">
              Free
            </span>
            <p className="font-display mt-3 text-[var(--text-primary)] text-[28px] tracking-[-0.01em] font-semibold">
              Bring your own keys
            </p>
            <p className="mt-3 text-[var(--text-secondary)] text-[15px] leading-[1.6]">
              Run Osborn on your own machine with your own model keys. You pay the model
              providers directly — nothing in between.
            </p>
            <ul className="mt-6 flex flex-col gap-2.5 font-mono text-[13px] text-[var(--text-secondary)]">
              {[
                'Full voice-native agent',
                'The whole sub-agent team',
                'Runs on your machine',
                'Self-hosted or your cloud',
              ].map((f) => (
                <li key={f} className="flex items-center gap-2.5">
                  <span className="text-[var(--accent)]">✓</span>
                  {f}
                </li>
              ))}
            </ul>
            <Link
              href="/login"
              className="mt-8 h-12 inline-flex items-center justify-center rounded-xl text-[15px] font-semibold tracking-[-0.01em] transition-all duration-150 active:scale-[0.98]"
              style={{
                background: 'linear-gradient(135deg, var(--accent) 0%, var(--accent-dim) 100%)',
                color: 'var(--background)',
                boxShadow: '0 1px 2px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.12)',
              }}
            >
              Start talking
            </Link>
          </div>

          {/* Teams / Enterprise */}
          <div
            className="rounded-2xl border border-[var(--border)] p-8 flex flex-col"
            style={{ background: 'var(--surface-raised)' }}
          >
            <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--accent)]">
              Teams / Enterprise
            </span>
            <p className="font-display mt-3 text-[var(--text-primary)] text-[28px] tracking-[-0.01em] font-semibold">
              Talk to us
            </p>
            <p className="mt-3 text-[var(--text-secondary)] text-[15px] leading-[1.6]">
              Shared sessions, managed infrastructure, SSO, and deployment on your own
              cloud. We&rsquo;ll shape it to how your team ships.
            </p>
            <ul className="mt-6 flex flex-col gap-2.5 font-mono text-[13px] text-[var(--text-secondary)]">
              {[
                'Everything in Free',
                'Team sessions & sharing',
                'Deploy on your own cloud',
                'SSO & priority support',
              ].map((f) => (
                <li key={f} className="flex items-center gap-2.5">
                  <span className="text-[var(--accent)]">✓</span>
                  {f}
                </li>
              ))}
            </ul>
            <a
              href="mailto:hello@voice-native.com?subject=Osborn%20for%20teams"
              className="mt-8 h-12 inline-flex items-center justify-center rounded-xl text-[15px] font-medium text-[var(--text-primary)] border border-[var(--border)] hover:bg-[var(--surface)] transition-colors"
            >
              Talk to us
            </a>
          </div>
        </div>
      </div>
    </section>
  )
}
