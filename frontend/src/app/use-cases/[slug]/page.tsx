/**
 * /use-cases/[slug] — a single case study as a clean editorial page.
 *
 * Server-rendered and statically generated from the real case-study data.
 * Per-page SEO (title/description/OG/canonical) + article semantics.
 */
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import MarketingShell from '@/components/marketing/MarketingShell'
import MarketingCTA from '@/components/marketing/MarketingCTA'
import { CASE_STUDIES, getCaseStudy, allCaseStudySlugs } from '@/lib/case-studies'

const SITE_URL = 'https://www.voice-native.com'

interface PageParams {
  params: { slug: string }
}

export function generateStaticParams() {
  return allCaseStudySlugs().map((slug) => ({ slug }))
}

export function generateMetadata({ params }: PageParams): Metadata {
  const study = getCaseStudy(params.slug)
  if (!study) return { title: 'Case study not found' }

  const canonical = `${SITE_URL}/use-cases/${study.slug}`
  return {
    title: study.title,
    description: study.seoDescription,
    alternates: { canonical },
    openGraph: {
      type: 'article',
      url: canonical,
      title: study.title,
      description: study.seoDescription,
      siteName: 'Voice Native',
    },
    twitter: {
      card: 'summary_large_image',
      title: study.title,
      description: study.seoDescription,
    },
  }
}

export default function CaseStudyPage({ params }: PageParams) {
  const study = getCaseStudy(params.slug)
  if (!study) notFound()

  const related = CASE_STUDIES.filter((c) => c.slug !== study.slug).slice(0, 2)

  return (
    <MarketingShell>
      <article>
        {/* Hero */}
        <header className="border-b border-[var(--border-subtle)]">
          <div className="mx-auto max-w-[760px] px-6 py-16 md:py-24">
            <Link
              href="/use-cases"
              className="font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--text-secondary)] transition-colors hover:text-[var(--accent)]"
            >
              ← All use cases
            </Link>
            <p className="mt-8 font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--accent)] md:text-[12px]">
              {study.category}
            </p>
            <h1 className="font-display mt-4 text-[clamp(2rem,5vw,3.25rem)] font-semibold leading-[1.05] tracking-[-0.02em] text-[var(--text-primary)]">
              {study.title}
            </h1>
            <p className="mt-6 text-[17px] leading-relaxed text-[var(--text-secondary)] md:text-[19px]">
              {study.summary}
            </p>

            <dl className="mt-8 flex flex-wrap gap-x-8 gap-y-3">
              {study.facts.map((f) => (
                <div key={f.label}>
                  <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--text-muted)]">
                    {f.label}
                  </dt>
                  <dd className="mt-1 text-[14px] text-[var(--text-primary)]">{f.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </header>

        {/* Body */}
        <div className="mx-auto max-w-[760px] px-6 py-16 md:py-20">
          {study.sections.map((section, i) => (
            <section key={i} className={i > 0 ? 'mt-14' : ''}>
              <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--accent)]">
                {section.kicker}
              </p>
              <h2 className="font-display mt-3 text-[clamp(1.5rem,3.5vw,2rem)] font-semibold leading-[1.1] tracking-[-0.015em] text-[var(--text-primary)]">
                {section.heading}
              </h2>
              {section.body.map((p, j) => (
                <p
                  key={j}
                  className="mt-4 text-[16px] leading-[1.7] text-[var(--text-secondary)] md:text-[17px]"
                >
                  {p}
                </p>
              ))}

              {/* Pull quote after the first section */}
              {i === 0 && study.pullQuote && (
                <blockquote className="mt-10 border-l-2 border-[var(--accent)] pl-6">
                  <p className="font-display text-[clamp(1.25rem,3vw,1.6rem)] italic leading-snug text-[var(--text-primary)]">
                    “{study.pullQuote}”
                  </p>
                </blockquote>
              )}
            </section>
          ))}
        </div>

        {/* Related */}
        {related.length > 0 && (
          <section aria-labelledby="related-heading" className="border-t border-[var(--border-subtle)]">
            <div className="mx-auto max-w-[1200px] px-6 py-16">
              <h2
                id="related-heading"
                className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--text-muted)]"
              >
                More use cases
              </h2>
              <ul className="mt-6 grid gap-5 sm:grid-cols-2">
                {related.map((c) => (
                  <li key={c.slug}>
                    <Link
                      href={`/use-cases/${c.slug}`}
                      className="group flex h-full flex-col rounded-2xl border border-[var(--border)] p-6 transition-colors hover:border-[var(--accent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
                      style={{ background: 'var(--surface)' }}
                    >
                      <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--accent)]">
                        {c.category}
                      </span>
                      <h3 className="font-display mt-3 text-[18px] font-semibold leading-snug text-[var(--text-primary)]">
                        {c.title}
                      </h3>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        )}
      </article>

      <MarketingCTA />
    </MarketingShell>
  )
}
