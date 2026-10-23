/**
 * V2Styles — all V2-only CSS, injected as a scoped <style> tag so we never touch
 * globals.css. Every class is prefixed `vn2-` to avoid collisions with the live
 * landing.
 *
 * Scroll technique (3 tiers, progressive enhancement):
 *   1. NATIVE — CSS scroll-driven animations (animation-timeline: view()).
 *      Runs on the compositor thread, zero JS, gated by
 *      `@supports (animation-timeline: view())` (~84% of browsers mid-2026).
 *   2. FALLBACK — for browsers without animation-timeline, an IntersectionObserver
 *      island (ScrollAssembly) toggles `.vn2-inview` on each part; the same
 *      keyframes then play once via a normal animation.
 *   3. REDUCED MOTION — `prefers-reduced-motion: reduce` forces the final
 *      assembled state (opacity:1, no transform, no animation) for everyone.
 *
 * This is a server component (no 'use client'): it only emits static CSS.
 */
export default function V2Styles() {
  return (
    <style
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{
        __html: `
/* ---------- Assembly keyframes: parts fly/fade into their final place ---------- */
@keyframes vn2-rise {
  from { opacity: 0; transform: translateY(44px) scale(0.96); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes vn2-inLeft {
  from { opacity: 0; transform: translateX(-56px) rotate(-2deg); }
  to   { opacity: 1; transform: translateX(0) rotate(0); }
}
@keyframes vn2-inRight {
  from { opacity: 0; transform: translateX(56px) rotate(2deg); }
  to   { opacity: 1; transform: translateX(0) rotate(0); }
}
@keyframes vn2-pop {
  from { opacity: 0; transform: scale(0.8); }
  60%  { opacity: 1; transform: scale(1.04); }
  to   { opacity: 1; transform: scale(1); }
}
@keyframes vn2-drawLine {
  from { transform: scaleY(0); }
  to   { transform: scaleY(1); }
}
@keyframes vn2-hero-drift {
  0%, 100% { transform: translate(-50%, 0) scale(1); opacity: .9; }
  50%      { transform: translate(-50%, -14px) scale(1.04); opacity: 1; }
}

/* ---------- Ambient hero glow drift ---------- */
.vn2-hero-glow { animation: vn2-hero-drift 11s ease-in-out infinite; }

/* ---------- Connector lines between assembly parts ---------- */
.vn2-connector { transform-origin: top center; transform: scaleY(0); }

/* ---------- BASE state of every assembling part ----------
   Hidden by default so there's no flash of content before the part assembles.
   Tier 2 (IntersectionObserver) and Tier 3 (reduced-motion) both reveal from
   here; Tier 1 overrides the base below inside the @supports block. */
.vn2-part { opacity: 0; will-change: transform, opacity; }

/* ---------- TIER 2: IntersectionObserver fallback ----------
   When the JS island adds .vn2-inview, play the assembly animation once. */
.vn2-part.vn2-inview            { animation: vn2-rise   .8s cubic-bezier(.2,.7,.2,1) both; }
.vn2-part.vn2-inview.vn2-left   { animation-name: vn2-inLeft; }
.vn2-part.vn2-inview.vn2-right  { animation-name: vn2-inRight; }
.vn2-part.vn2-inview.vn2-pop    { animation-name: vn2-pop; }
.vn2-connector.vn2-inview       { animation: vn2-drawLine .6s ease-out both; }

/* Stagger: later parts lag slightly for the "piece together" cascade. */
.vn2-part.vn2-d1 { animation-delay: .06s; }
.vn2-part.vn2-d2 { animation-delay: .14s; }
.vn2-part.vn2-d3 { animation-delay: .22s; }

/* ---------- TIER 1: native CSS scroll-driven animations ----------
   Supported browsers drive the SAME keyframes off view() progress — the part
   assembles as it scrolls through the lower portion of the viewport. This also
   makes the effect scrubbable (reverses on scroll-up). */
@supports (animation-timeline: view()) {
  .vn2-part {
    animation: vn2-rise both;
    animation-timeline: view();
    /* play across the band from entry to ~45% up the viewport */
    animation-range: entry 8% cover 42%;
  }
  .vn2-part.vn2-left  { animation-name: vn2-inLeft; }
  .vn2-part.vn2-right { animation-name: vn2-inRight; }
  .vn2-part.vn2-pop   { animation-name: vn2-pop; }
  .vn2-connector {
    animation: vn2-drawLine both;
    animation-timeline: view();
    animation-range: entry 10% cover 38%;
  }
  /* In native mode the IO class is a no-op (JS stays dormant). */
  .vn2-part.vn2-inview, .vn2-connector.vn2-inview { }
}

/* ---------- TIER 3: reduced motion wins over everything ----------
   Show the final assembled state immediately. No transform, no animation. */
@media (prefers-reduced-motion: reduce) {
  .vn2-part,
  .vn2-part.vn2-inview,
  .vn2-connector,
  .vn2-connector.vn2-inview {
    opacity: 1 !important;
    transform: none !important;
    animation: none !important;
  }
  .vn2-hero-glow { animation: none !important; }
  .vn2-orb-body { animation: none !important; }
}

/* ---------- Mobile: lighten the lift so low-power devices stay smooth ----------
   Keep the fade but shrink the travel; also disable the ambient hero drift. */
@media (max-width: 767px) {
  @keyframes vn2-rise {
    from { opacity: 0; transform: translateY(20px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .vn2-part.vn2-left, .vn2-part.vn2-right { }
  .vn2-hero-glow { animation: none; }
}
`,
      }}
    />
  )
}
