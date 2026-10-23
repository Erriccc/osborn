import type { Metadata } from 'next'
import V2Styles from '@/components/landing-v2/V2Styles'
import NavV2 from '@/components/landing-v2/NavV2'
import HeroV2 from '@/components/landing-v2/HeroV2'
import ScrollAssembly from '@/components/landing-v2/ScrollAssembly'
import ValueProps from '@/components/landing-v2/ValueProps'
import FinalCTAV2 from '@/components/landing-v2/FinalCTAV2'
import FooterV2 from '@/components/landing-v2/FooterV2'

/**
 * /v2 — V2 marketing landing PREVIEW. The live landing at / is untouched; the
 * founder reviews this before we swap it in. noindex so it doesn't compete in
 * search while it's a preview.
 */
export const metadata: Metadata = {
  title: 'Voice Native — The Hands-Free Business OS (preview)',
  description:
    'Talk, and Voice Native drives the work — a team of agents writing, running, and shipping on your machine while you stay in the conversation.',
  robots: { index: false, follow: false },
  alternates: { canonical: '/v2' },
}

export default function V2Page() {
  return (
    <>
      <V2Styles />
      <main className="relative bg-[var(--background)] text-[var(--text-primary)] overflow-x-hidden">
        <NavV2 />
        <HeroV2 />
        <ScrollAssembly />
        <ValueProps />
        <FinalCTAV2 />
        <FooterV2 />
      </main>
    </>
  )
}
