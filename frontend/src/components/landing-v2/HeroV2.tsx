import Link from 'next/link'
import Orb from './Orb'

/**
 * HeroV2 — the "in the seat" moment. Calm, centered, cinematic. You talk; it
 * drives. The orb sits at the center like a dashboard presence with a slow
 * ambient drift (CSS only; frozen under reduced-motion via V2Styles).
 *
 * Server component — no client JS. CTAs link to /login.
 */
export default function HeroV2() {
  return (
    <section
      id="top"
      className="relative overflow-hidden min-h-[100svh] flex items-center justify-center"
    >
      {/* Ambient amber glow — drifts slowly behind the orb */}
      <div
        className="vn2-hero-glow pointer-events-none absolute top-[30%] left-1/2 w-[760px] max-w-[120vw] h-[760px] rounded-full"
        style={{ background: 'radial-gradient(circle, var(--accent-glow) 0%, transparent 68%)' }}
        aria-hidden="true"
      />

      {/* Horizon line — the sense of a road ahead */}
      <div
        className="pointer-events-none absolute left-0 right-0 top-1/2 h-px"
        style={{
          background:
            'linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 22%, transparent), transparent)',
        }}
        aria-hidden="true"
      />

      <div className="relative z-10 mx-auto max-w-[900px] px-6 pt-24 pb-16 flex flex-col items-center text-center">
        <span className="font-mono text-[11px] md:text-[12px] uppercase tracking-[0.2em] text-[var(--accent)]">
          The hands-free business OS
        </span>

        <h1 className="font-display mt-6 text-[var(--text-primary)] text-[clamp(2.8rem,8vw,5.5rem)] leading-[0.96] tracking-[-0.03em] font-semibold">
          <span className="italic text-[var(--accent)]">Talk.</span>
          <br />
          It drives the work.
        </h1>

        <p className="mt-7 max-w-[38rem] text-[var(--text-secondary)] text-[17px] md:text-[19px] leading-[1.6]">
          Lean back in the seat. Describe where you want to go, and Voice Native
          takes the wheel — a whole team of agents writing, running, and shipping
          on your machine while you stay in the conversation.
        </p>

        {/* The orb: the presence you talk to */}
        <div className="relative mt-12 mb-10 flex items-center justify-center">
          <Orb size={132} state="listening" />
        </div>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
          <Link
            href="/login"
            className="h-12 px-7 inline-flex items-center justify-center rounded-xl text-[15px] font-semibold tracking-[-0.01em] transition-all duration-150 active:scale-[0.98]"
            style={{
              background: 'linear-gradient(135deg, var(--accent) 0%, var(--accent-dim) 100%)',
              color: 'var(--background)',
              boxShadow: '0 1px 2px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.12)',
            }}
          >
            Take the wheel — free
          </Link>
          <a
            href="#assemble"
            className="h-12 px-7 inline-flex items-center justify-center rounded-xl text-[15px] font-medium text-[var(--text-primary)] border border-[var(--border)] hover:bg-[var(--surface)] transition-colors"
          >
            See it assemble
          </a>
        </div>

        <p className="mt-7 font-mono text-[11px] md:text-[12px] text-[var(--text-muted)] tracking-[0.02em]">
          Runs on your machine · Bring your own keys · No lock-in
        </p>

        {/* Scroll hint */}
        <div
          className="mt-14 flex flex-col items-center gap-2 text-[var(--text-muted)]"
          aria-hidden="true"
        >
          <span className="font-mono text-[10px] uppercase tracking-[0.2em]">Scroll</span>
          <svg width="14" height="22" viewBox="0 0 14 22" fill="none" stroke="currentColor">
            <rect x="1" y="1" width="12" height="20" rx="6" strokeWidth="1.3" />
            <line x1="7" y1="5" x2="7" y2="9" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        </div>
      </div>
    </section>
  )
}
