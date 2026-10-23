/**
 * /use-cases — index of real, grounded case studies. Server-rendered + SEO.
 * Links to each /use-cases/[slug] editorial page.
 */
import type { Metadata } from 'next'
import Link from 'next/link'
import MarketingShell from '@/components/marketing/MarketingShell'
import MarketingCTA from '@/components/marketing/MarketingCTA'
import { CASE_STUDIES } from '@/lib/case-studies'

const SITE_URL = 'https://www.voice-native.com'
const CANONICAL = `${SITE_URL}/use-cases`

const TITLE = 'Use cases — real work Voice Native has shipped'
const DESCRIPTION =
  'Real case studies of what Voice Native has actually done by voice: Google Ads automation, a LinkedIn launch model, an automated content pipeline, and meeting-to-action.'

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: CANONICAL },
  openGraph: {
    type: 'website',
    url: CANONICAL,
    title: TITLE,
    description: DESCRIPTION,
    siteName: 'Voice Native',
  },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION },
}

export default function UseCasesIndex() {
  return (
    <MarketingShell>
      <section aria-labelledby="uc-hero" className="border-b border-[var(--border-subtle)]">
        <div className="mx-auto max-w-[1200px] px-6 py-20 md:py-28">
          <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--accent)] md:text-[12px]">
            Use cases
          </span>
          <h1
            id="uc-hero"
            className="font-display mt-4 max-w-[18ch] text-[clamp(2.25rem,6vw,4rem)] font-semibold leading-[1.02] tracking-[-0.02em] text-[var(--text-primary)]"
          >
            Real work, described out loud and shipped
          </h1>
          <p className="mt-6 max-w-[44rem] text-[17px] leading-relaxed text-[var(--text-secondary)] md:text-[19px]">
            These are not hypotheticals. Each one is work Voice Native actually did,
            told as problem, approach, and outcome — grounded in the product’s own
            session history.
          </p>
        </div>
      </section>

      <section aria-label="Case studies">
        <div className="mx-auto max-w-[1200px] px-6 py-16 md:py-24">
          <ul className="grid gap-5 sm:grid-cols-2">
            {CASE_STUDIES.map((c) => (
              <li key={c.slug}>
                <Link
                  href={`/use-cases/${c.slug}`}
                  className="group flex h-full flex-col rounded-2xl border border-[var(--border)] p-6 transition-colors hover:border-[var(--accent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
                  style={{ background: 'var(--surface)' }}
                >
                  <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--accent)]">
                    {c.category}
                  </span>
                  <h2 className="font-display mt-3 text-[21px] font-semibold leading-snug tracking-[-0.01em] text-[var(--text-primary)]">
                    {c.title}
                  </h2>
                  <p className="mt-3 flex-1 text-[15px] leading-[1.65] text-[var(--text-secondary)]">
                    {c.summary}
                  </p>
                  <span className="mt-5 font-mono text-[12px] uppercase tracking-[0.12em] text-[var(--text-secondary)] transition-colors group-hover:text-[var(--accent)]">
                    Read the story →
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <MarketingCTA />
    </MarketingShell>
  )
}
