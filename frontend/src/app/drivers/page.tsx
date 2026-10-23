/**
 * /drivers — niche landing for professional drivers (rideshare, delivery,
 * trucking) and commuters. Angle: be productive / earn more while you drive —
 * hands-free, eyes on the road, legal in all 50 states (voice stays legal even
 * where handheld use is banned). Cabin-style hero. Server component.
 */

import Link from 'next/link'
import type { Metadata } from 'next'
import MarketingShell from '@/components/marketing/MarketingShell'
import ScenarioImage from '@/components/ScenarioImage'
import { getScenario } from '@/lib/scenarios'
import { SITE_URL } from '@/lib/supabase-anon'

const S = getScenario('drivers')!

export const metadata: Metadata = {
  title: 'Voice Native for drivers — be productive while you drive, hands-free',
  description:
    'Turn drive time into productive time. Talk to Voice Native and it writes, runs, and ships work on your machine while your hands stay on the wheel. Hands-free and legal in all 50 states.',
  alternates: { canonical: `${SITE_URL}/drivers` },
  openGraph: {
    title: 'Voice Native for drivers',
    description: 'Be productive while you drive — hands-free, eyes on the road, legal in all 50 states.',
    url: `${SITE_URL}/drivers`,
    type: 'website',
    images: [{ url: `${SITE_URL}/og.png` }],
  },
  twitter: { card: 'summary_large_image', title: 'Voice Native for drivers' },
}

const WHY: { title: string; body: string }[] = [
  {
    title: 'Dead time becomes shipped work',
    body: 'The miles between stops, the commute, the long haul — talk your work into existence instead of letting the hours vanish.',
  },
  {
    title: 'Say more in less time',
    body: 'You speak faster than you type and think out loud better than you text. A sentence out loud beats a paragraph typed.',
  },
  {
    title: 'Legal where phones aren’t',
    body: 'In 2026 most states fine handheld phone use with primary enforcement — but hands-free voice stays legal everywhere. It’s just your voice.',
  },
]

export default function DriversPage() {
  return (
    <MarketingShell>
      {/* Hero */}
      <section className="mx-auto max-w-[1200px] px-6 pt-16 pb-12">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--accent)]">For professional drivers &amp; commuters</p>
        <h1 className="mt-4 font-display text-4xl sm:text-6xl font-medium tracking-tight text-[var(--text-primary)] leading-[1.05] max-w-[16ch]">
          {S.headline}
        </h1>
        <p className="mt-6 max-w-[56ch] text-[17px] sm:text-[19px] text-[var(--text-secondary)] leading-relaxed">
          Voice Native is an AI engineer you talk to. On the highway, between rides, mid-commute — you speak, and it
          writes, runs, and ships real work on your machine. Eyes on the road, hands on the wheel.
        </p>
        <div className="mt-8 flex flex-col sm:flex-row items-start sm:items-center gap-4">
          <Link href="/login"
            className="inline-flex items-center gap-2 rounded-xl bg-[var(--accent)] px-6 py-3.5 text-[15px] font-semibold text-[var(--background)] hover:opacity-90 active:scale-[0.98] transition-all">
            Start talking — free
          </Link>
          <Link href="/industries" className="text-[14px] text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors">
            See other scenes →
          </Link>
        </div>
        <p className="mt-5 font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--text-muted)]">
          Hands-free · Eyes on the road · Legal in all 50 states
        </p>

        <div className="mt-10">
          <ScenarioImage src={S.image} alt={S.headline} scene={S.scene} style="cabin" priority />
        </div>
      </section>

      {/* Why */}
      <section className="mx-auto max-w-[1200px] px-6 py-12 border-t border-[var(--border-subtle)]">
        <div className="grid gap-4 sm:grid-cols-3">
          {WHY.map((w) => (
            <div key={w.title} className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-6">
              <h3 className="font-display text-xl text-[var(--text-primary)] leading-snug">{w.title}</h3>
              <p className="mt-2.5 text-[14px] text-[var(--text-secondary)] leading-relaxed">{w.body}</p>
            </div>
          ))}
        </div>
        <p className="mt-6 text-[12px] text-[var(--text-muted)] leading-relaxed max-w-[70ch]">
          Always follow your local laws and drive safely — Voice Native is designed for hands-free, eyes-on-the-road
          use, never for looking at or holding a device while driving.
        </p>
      </section>

      {/* CTA */}
      <section className="border-t border-[var(--border-subtle)]">
        <div className="mx-auto max-w-[1200px] px-6 py-16 text-center">
          <h2 className="font-display text-3xl sm:text-4xl text-[var(--text-primary)] leading-tight">
            Your commute is about to start earning.
          </h2>
          <p className="mt-3 text-[15px] text-[var(--text-secondary)]">Talk your next task done — free to start.</p>
          <Link href="/login"
            className="mt-7 inline-flex items-center gap-2 rounded-xl bg-[var(--accent)] px-6 py-3.5 text-[15px] font-semibold text-[var(--background)] hover:opacity-90 active:scale-[0.98] transition-all">
            Start talking — free
          </Link>
        </div>
      </section>
    </MarketingShell>
  )
}
