/**
 * /industries — the visual gallery of Voice Native's hands-free scenarios.
 * Each scenario shows its cinematic slot (AI render once produced), a
 * show-don't-tell headline, and the scene. Dedicated pages (e.g. /drivers)
 * link through; the rest read as concepts for now. Server component.
 */

import Link from 'next/link'
import type { Metadata } from 'next'
import MarketingShell from '@/components/marketing/MarketingShell'
import ScenarioImage from '@/components/ScenarioImage'
import { SCENARIOS } from '@/lib/scenarios'
import { SITE_URL } from '@/lib/supabase-anon'

export const metadata: Metadata = {
  title: 'Industries — Voice Native hands-free, everywhere work happens',
  description:
    'From the driver’s seat to the boardroom: see Voice Native make work ship hands-free across industries — drivers, meeting rooms, onboarding, remote calls, and multi-speaker rooms.',
  alternates: { canonical: `${SITE_URL}/industries` },
  openGraph: {
    title: 'Industries — Voice Native',
    description: 'Hands-free work, everywhere it happens. Drivers, meeting rooms, onboarding, remote calls, and more.',
    url: `${SITE_URL}/industries`,
    type: 'website',
    images: [{ url: `${SITE_URL}/og.png` }],
  },
  twitter: { card: 'summary_large_image', title: 'Industries — Voice Native' },
}

export default function IndustriesPage() {
  return (
    <MarketingShell>
      {/* Hero */}
      <section className="mx-auto max-w-[1200px] px-6 pt-16 pb-10">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--accent)]">Hands-free, everywhere</p>
        <h1 className="mt-3 font-display text-4xl sm:text-5xl font-medium tracking-tight text-[var(--text-primary)] leading-[1.1] max-w-[20ch]">
          Wherever your hands are busy, your voice still ships.
        </h1>
        <p className="mt-4 max-w-[60ch] text-[16px] text-[var(--text-secondary)] leading-relaxed">
          The same agent, dropped into the places real work happens. Pick the scene that looks like your day.
        </p>
      </section>

      {/* Gallery */}
      <section className="mx-auto max-w-[1200px] px-6 pb-20">
        <div className="grid gap-x-6 gap-y-12 lg:grid-cols-2">
          {SCENARIOS.map((s, i) => (
            <article key={s.slug} className="flex flex-col">
              <ScenarioImage src={s.image} alt={s.headline} scene={s.scene} style={s.style} priority={i < 2} />
              <div className="mt-5">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-[var(--accent)]">{s.segment}</span>
                  <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--text-muted)] opacity-70">
                    {s.style === 'cabin' ? 'POV' : 'Scene'}
                  </span>
                </div>
                <h2 className="mt-2 font-display text-2xl text-[var(--text-primary)] leading-snug">{s.headline}</h2>
                <p className="mt-2 text-[14px] text-[var(--text-secondary)] leading-relaxed max-w-[52ch]">{s.scene}</p>
                {s.page ? (
                  <Link href={s.page}
                    className="mt-4 inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--accent)] hover:opacity-80 transition-opacity">
                    Explore {s.segment} →
                  </Link>
                ) : (
                  <span className="mt-4 inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--text-muted)]">
                    Concept — page coming
                  </span>
                )}
              </div>
            </article>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-[var(--border-subtle)]">
        <div className="mx-auto max-w-[1200px] px-6 py-14 text-center">
          <h2 className="font-display text-2xl sm:text-3xl text-[var(--text-primary)]">Don&apos;t see your scene?</h2>
          <p className="mt-2 text-[14px] text-[var(--text-secondary)]">If your hands are busy and your voice is free, it works. Talk to it.</p>
          <Link href="/login"
            className="mt-6 inline-flex items-center gap-2 rounded-xl bg-[var(--accent)] px-5 py-3 text-[14px] font-semibold text-[var(--background)] hover:opacity-90 active:scale-[0.98] transition-all">
            Start talking — free
          </Link>
        </div>
      </section>
    </MarketingShell>
  )
}
