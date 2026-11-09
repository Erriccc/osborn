import { SCENARIOS } from '@/lib/scenarios'
import SceneBackdrop from './SceneBackdrop'

/**
 * ScenarioMoments — below the fold, a small number of immersive full-bleed
 * moments. Image + one evocative line each. FEEL, not explain: no feature
 * bullets, no body copy — a scene you drop into, then the next.
 *
 * IMAGE SLOTS (full-bleed, one per moment): each reuses the committed render at
 * scenario.image, generated from the matching prompt in
 * docs/hero-image-prompts.md and frontend/src/lib/scenarios.ts (imagePrompt):
 *   - gamers        → "gamers → cabin / POV"           (public/industries/gamers.jpg)
 *   - meeting-room  → "meeting-room → scene"           (public/industries/meeting-room.jpg)
 *   - multi-speaker → "multi-speaker → scene"          (public/industries/multi-speaker.jpg)
 * All three already exist; if any file goes missing, SceneBackdrop degrades to a
 * cinematic gradient. To feature a different scene, swap a slug below.
 *
 * Server component; SceneBackdrop is the only client island inside.
 */

const FEATURED = ['gamers', 'meeting-room', 'multi-speaker'] as const

const MOMENTS = FEATURED.map((slug) => SCENARIOS.find((s) => s.slug === slug)!).filter(Boolean)

export default function ScenarioMoments() {
  return (
    <section id="scenes" aria-label="Where it rides along" className="scroll-mt-16">
      {MOMENTS.map((m, i) => {
        const alignRight = i % 2 === 1
        return (
          <div
            key={m.slug}
            className="relative flex min-h-[64svh] items-end overflow-hidden"
          >
            <SceneBackdrop
              src={m.image}
              alt={m.headline}
              style={m.style === 'cabin' ? 'cabin' : 'scene'}
              objectPosition="center"
            />

            {/* Scrim for legibility — heavier on the side the copy sits */}
            <div
              className="pointer-events-none absolute inset-0"
              style={{
                background: alignRight
                  ? 'linear-gradient(270deg, rgba(12,11,9,0.86) 0%, rgba(12,11,9,0.45) 46%, rgba(12,11,9,0.12) 100%), linear-gradient(0deg, rgba(12,11,9,0.6) 0%, transparent 60%)'
                  : 'linear-gradient(90deg, rgba(12,11,9,0.86) 0%, rgba(12,11,9,0.45) 46%, rgba(12,11,9,0.12) 100%), linear-gradient(0deg, rgba(12,11,9,0.6) 0%, transparent 60%)',
              }}
              aria-hidden="true"
            />

            <div className="relative z-10 mx-auto w-full max-w-[1200px] px-4 pb-12 pt-24 sm:px-6 md:pb-16">
              <div
                className={`max-w-[20ch] ${
                  alignRight ? 'sm:ml-auto sm:text-right' : 'text-left'
                }`}
              >
                <span className="font-mono text-[10.5px] uppercase tracking-[0.2em] text-[var(--accent)]">
                  {m.segment}
                </span>
                <p className="font-display mt-3 text-[clamp(1.7rem,4.4vw,2.9rem)] font-semibold leading-[1.05] tracking-[-0.02em] text-[var(--text-primary)]">
                  {m.headline}
                </p>
              </div>
            </div>
          </div>
        )
      })}
    </section>
  )
}
