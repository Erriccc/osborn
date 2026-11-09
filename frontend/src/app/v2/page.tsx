import type { Metadata } from 'next'
import V2Styles from '@/components/landing-v2/V2Styles'
import NavV2 from '@/components/landing-v2/NavV2'
import HeroV2 from '@/components/landing-v2/HeroV2'
import ScenarioMoments from '@/components/landing-v2/ScenarioMoments'
import FinalCTAV2 from '@/components/landing-v2/FinalCTAV2'
import FooterV2 from '@/components/landing-v2/FooterV2'

/**
 * /v2 — V2 marketing landing PREVIEW ("feel, not explain"). The live landing at
 * / is untouched; the founder reviews this before we swap it in.
 *
 * Shape: a full-bleed cabin-POV hero with the voice orb as the focal point and
 * near-zero copy, then a few immersive scenario moments (image + one line each),
 * then a single quiet CTA. The imagery lives in slots (see the IMAGE SLOT notes
 * in HeroV2 / ScenarioMoments) so the founder can swap renders without code.
 *
 * noindex so the preview doesn't compete in search while it's a preview.
 */
export const metadata: Metadata = {
  title: { absolute: 'Voice Native — Talk. It drives. (preview)' },
  description:
    'Talk, and Voice Native drives the work — a team of agents writing, running, and shipping on your machine while you stay in the conversation.',
  robots: { index: false, follow: false },
  alternates: { canonical: '/v2' },
}

export default function V2Page() {
  return (
    <>
      <V2Styles />
      <main className="relative overflow-x-hidden bg-[var(--background)] text-[var(--text-primary)]">
        <NavV2 />
        <HeroV2 />
        <ScenarioMoments />
        <FinalCTAV2 />
        <FooterV2 />
      </main>
    </>
  )
}
