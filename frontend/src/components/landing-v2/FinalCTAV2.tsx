import Link from 'next/link'
import Orb from './Orb'

/**
 * FinalCTAV2 — the close. Orb + one-line invitation + /login CTA. Server
 * component; no fake metrics or testimonials.
 */
export default function FinalCTAV2() {
  return (
    <section className="relative overflow-hidden">
      <div
        className="vn2-hero-glow pointer-events-none absolute top-[10%] left-1/2 w-[640px] max-w-[110vw] h-[640px] rounded-full"
        style={{ background: 'radial-gradient(circle, var(--accent-glow) 0%, transparent 70%)' }}
        aria-hidden="true"
      />
      <div className="relative z-10 mx-auto max-w-[760px] px-6 py-28 md:py-36 flex flex-col items-center text-center">
        <Orb size={96} state="speaking" />
        <h2 className="font-display mt-10 text-[var(--text-primary)] text-[clamp(2.2rem,6vw,3.6rem)] leading-[1.02] tracking-[-0.02em] font-semibold">
          Get in. <span className="italic text-[var(--accent)]">Say where to.</span>
        </h2>
        <p className="mt-6 max-w-[32rem] text-[var(--text-secondary)] text-[17px] leading-[1.6]">
          Your hands-free business OS is waiting. Start a voice session and let it
          drive the first task — free.
        </p>
        <Link
          href="/login"
          className="mt-9 h-13 px-8 inline-flex items-center justify-center rounded-xl text-[16px] font-semibold tracking-[-0.01em] transition-all duration-150 active:scale-[0.98]"
          style={{
            background: 'linear-gradient(135deg, var(--accent) 0%, var(--accent-dim) 100%)',
            color: 'var(--background)',
            boxShadow: '0 1px 2px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.12)',
            height: '3.25rem',
          }}
        >
          Take the wheel — free
        </Link>
        <p className="mt-6 font-mono text-[11px] text-[var(--text-muted)] tracking-[0.02em]">
          Runs on your machine · Bring your own keys · No lock-in
        </p>
      </div>
    </section>
  )
}
