import Link from 'next/link'
import Orb from './Orb'
import SceneBackdrop from './SceneBackdrop'

/**
 * HeroV2 — the "in the seat" moment. FEEL, not explain. A full-bleed first-person
 * cabin POV fills the screen; the glowing voice ORB is the focal point; the copy
 * is three words. No paragraph, no feature bullets — the image + orb carry it.
 *
 * IMAGE SLOT (full-bleed hero backdrop):
 *   expects a cinematic FIRST-PERSON cabin POV, in-motion, dark premium interior
 *   with one warm amber accent glow — the "drivers → cabin / POV" prompt in
 *   docs/hero-image-prompts.md. It currently reuses the committed render
 *   public/industries/drivers.jpg so the preview is immersive immediately; for a
 *   dedicated wider hero plate, generate public/industries/hero-cabin.jpg from the
 *   "hero-cabin → full-bleed hero (cabin / POV)" prompt in that doc and swap `src`.
 *   If the file is ever missing, SceneBackdrop degrades to a cinematic gradient.
 *
 * Server component — no client JS of its own (SceneBackdrop is the only island).
 */
export default function HeroV2() {
  return (
    <section
      id="top"
      className="relative min-h-[100svh] flex items-center justify-center overflow-hidden"
    >
      {/* Full-bleed cabin POV behind everything */}
      <SceneBackdrop
        src="/industries/drivers.jpg"
        alt="First-person view from a driver's seat at dusk, hands relaxed, a warm amber dashboard glow ahead"
        style="cabin"
        priority
        objectPosition="center 60%"
      />

      {/* Cinematic scrims — darken top/bottom so copy + orb stay legible over any render */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'linear-gradient(180deg, rgba(12,11,9,0.72) 0%, rgba(12,11,9,0.32) 34%, rgba(12,11,9,0.58) 72%, var(--background) 100%)',
        }}
        aria-hidden="true"
      />
      {/* Soft amber vignette drifting behind the orb */}
      <div
        className="vn2-hero-glow pointer-events-none absolute top-1/2 left-1/2 h-[620px] w-[620px] max-w-[120vw] -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{ background: 'radial-gradient(circle, var(--accent-glow) 0%, transparent 66%)' }}
        aria-hidden="true"
      />

      <div className="relative z-10 mx-auto flex max-w-[820px] flex-col items-center px-4 text-center sm:px-6">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.26em] text-[var(--accent)] sm:text-[12px]">
          The hands-free business OS
        </span>

        {/* The orb: the presence you talk to — the focal point of the whole hero */}
        <div className="relative mt-10 mb-10 flex items-center justify-center">
          <Orb size={150} state="listening" />
        </div>

        <h1 className="font-display text-[clamp(3rem,13vw,6.5rem)] font-semibold leading-[0.92] tracking-[-0.035em] text-[var(--text-primary)]">
          <span className="italic text-[var(--accent)]">Talk.</span>
          <br />
          It drives.
        </h1>

        {/* One subtle, quiet entry point — the real CTA lives at the close */}
        <Link
          href="/login"
          className="mt-11 inline-flex h-11 items-center justify-center rounded-full border border-[var(--border)] px-6 text-[14px] font-medium tracking-[-0.01em] text-[var(--text-primary)] backdrop-blur-sm transition-colors hover:bg-[color-mix(in_srgb,var(--surface)_80%,transparent)]"
          style={{ background: 'color-mix(in srgb, var(--surface) 42%, transparent)' }}
        >
          Take the wheel
        </Link>
      </div>

      {/* Scroll cue — quiet, points into the scenes */}
      <a
        href="#scenes"
        aria-label="Scroll to see it in the wild"
        className="group absolute bottom-7 left-1/2 z-10 flex -translate-x-1/2 flex-col items-center gap-2 text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
      >
        <span className="font-mono text-[10px] uppercase tracking-[0.24em]">Scroll</span>
        <svg width="14" height="22" viewBox="0 0 14 22" fill="none" stroke="currentColor" aria-hidden="true">
          <rect x="1" y="1" width="12" height="20" rx="6" strokeWidth="1.3" />
          <line x1="7" y1="5" x2="7" y2="9" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      </a>
    </section>
  )
}
