import Link from 'next/link'
import LiveSessionMock from './LiveSessionMock'

export default function Hero() {
  return (
    <section id="top" className="relative overflow-hidden">
      {/* Ambient amber glow — hero only */}
      <div
        className="pointer-events-none absolute top-[18%] left-1/2 -translate-x-1/2 w-[720px] h-[720px] rounded-full"
        style={{ background: 'radial-gradient(circle, var(--accent-glow) 0%, transparent 70%)' }}
        aria-hidden="true"
      />

      <div className="relative mx-auto max-w-[1200px] px-6 pt-32 pb-20 md:pt-40 md:pb-28">
        <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,460px)] gap-12 lg:gap-16 items-center">
          {/* Copy column */}
          <div className="flex flex-col items-start">
            <span className="font-mono text-[11px] md:text-[12px] uppercase tracking-[0.18em] text-[var(--accent)]">
              Voice-native AI coding agent
            </span>

            <h1 className="font-display mt-5 text-[var(--text-primary)] text-[clamp(2.75rem,7vw,5rem)] leading-[0.98] tracking-[-0.03em] font-semibold">
              <span className="italic text-[var(--accent)]">Talk</span> to it.
              <br />
              It ships.
            </h1>

            <p className="mt-6 max-w-[34rem] text-[var(--text-secondary)] text-[17px] md:text-[18px] leading-[1.6]">
              Voice Native is an AI engineer you talk to. Speak to it like a teammate and it
              writes, runs, and debugs code on your machine — dispatching a team of
              specialist sub-agents while you watch every move in real time.
            </p>

            <div className="mt-8 flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
              <Link
                href="/login"
                className="h-12 px-6 inline-flex items-center justify-center rounded-xl text-[15px] font-semibold tracking-[-0.01em] transition-all duration-150 active:scale-[0.98]"
                style={{
                  background: 'linear-gradient(135deg, var(--accent) 0%, var(--accent-dim) 100%)',
                  color: 'var(--background)',
                  boxShadow: '0 1px 2px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.12)',
                }}
              >
                Start talking — free
              </Link>
              <a
                href="#features"
                className="h-12 px-6 inline-flex items-center justify-center rounded-xl text-[15px] font-medium text-[var(--text-primary)] border border-[var(--border)] hover:bg-[var(--surface)] transition-colors"
              >
                Watch a 90-second demo
              </a>
            </div>

            <p className="mt-6 font-mono text-[11px] md:text-[12px] text-[var(--text-muted)] tracking-[0.02em]">
              Your code never leaves your machine · Bring your own keys · No lock-in
            </p>
          </div>

          {/* Visual column */}
          <div className="flex justify-center lg:justify-end">
            <LiveSessionMock />
          </div>
        </div>
      </div>
    </section>
  )
}
