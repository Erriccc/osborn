/**
 * /blog — the public content hub. Surfaces (a) Voice Native's guides &
 * comparisons (the marketing pages) and (b) the latest PUBLISHED pieces from
 * the community, read from the safe `public_content` view via the cookie-less
 * anon client. Each piece links to its canonical /p/{handle}/{slug} page.
 *
 * Rendered at request time against the live DB (force-dynamic) so newly
 * published pieces appear without a rebuild — same rationale as /p.
 */

import Link from 'next/link'
import type { Metadata } from 'next'
import MarketingShell from '@/components/marketing/MarketingShell'
import { createSupabaseAnon, SITE_URL, type PublicContent } from '@/lib/supabase-anon'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Blog — Voice Native',
  description:
    'Guides, comparisons, and pieces built with Voice Native — the AI coding agent you talk to. Explore how teams ship by voice.',
  alternates: { canonical: `${SITE_URL}/blog` },
  openGraph: {
    title: 'Blog — Voice Native',
    description:
      'Guides, comparisons, and pieces built with Voice Native — the AI coding agent you talk to.',
    url: `${SITE_URL}/blog`,
    type: 'website',
    images: [{ url: `${SITE_URL}/og.png` }],
  },
  twitter: { card: 'summary_large_image', title: 'Blog — Voice Native' },
}

const GUIDES: { href: string; eyebrow: string; title: string; blurb: string }[] = [
  {
    href: '/compare',
    eyebrow: 'Comparison',
    title: 'Voice Native vs. the alternatives',
    blurb: 'How talking to an agent that runs on your machine stacks up against chat-window copilots and autonomous IDEs.',
  },
  {
    href: '/use-cases',
    eyebrow: 'Use cases',
    title: 'What people ship by voice',
    blurb: 'Real workflows — from campaign launches to automated content pipelines — reproduced hands-free.',
  },
  {
    href: '/industries',
    eyebrow: 'Industries',
    title: 'Hands-free, everywhere work happens',
    blurb: 'See the agent dropped into real scenes — the driver’s seat, the boardroom, the battlestation, the remote call.',
  },
]

async function getLatest(): Promise<PublicContent[]> {
  const supabase = createSupabaseAnon()
  if (!supabase) return []
  const { data, error } = await supabase
    .from('public_content')
    .select('id, type, title, hook, body, transcript, slug, poster_path, published_at, handle, author_name')
    .order('published_at', { ascending: false })
    .limit(24)
  if (error || !data) return []
  return data as PublicContent[]
}

function fmtDate(iso: string | null): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  } catch {
    return iso.slice(0, 10)
  }
}

export default async function BlogIndexPage() {
  const items = await getLatest()

  return (
    <MarketingShell>
      {/* Hero */}
      <section className="mx-auto max-w-[1200px] px-6 pt-16 pb-10">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--accent)]">The Voice Native blog</p>
        <h1 className="mt-3 font-display text-4xl sm:text-5xl font-medium tracking-tight text-[var(--text-primary)] leading-[1.1]">
          Guides, comparisons, and work shipped by voice.
        </h1>
        <p className="mt-4 max-w-[60ch] text-[16px] text-[var(--text-secondary)] leading-relaxed">
          How teams build with an AI engineer they talk to — plus pieces published straight from a session. Open any one and talk to it.
        </p>
      </section>

      {/* Guides & comparisons */}
      <section className="mx-auto max-w-[1200px] px-6 pb-12">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--text-muted)]">Start here</h2>
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          {GUIDES.map((g) => (
            <Link key={g.href} href={g.href}
              className="group flex flex-col rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-6 hover:border-[var(--accent)]/40 hover:-translate-y-0.5 transition-all">
              <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-[var(--accent)]">{g.eyebrow}</span>
              <h3 className="mt-2 font-display text-xl text-[var(--text-primary)] group-hover:text-[var(--accent)] transition-colors">{g.title}</h3>
              <p className="mt-2 text-[14px] text-[var(--text-secondary)] leading-relaxed">{g.blurb}</p>
              <span className="mt-4 font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--text-muted)] group-hover:text-[var(--accent)] transition-colors">Read →</span>
            </Link>
          ))}
        </div>
      </section>

      {/* Latest published pieces */}
      <section className="mx-auto max-w-[1200px] px-6 pb-20">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--text-muted)]">Latest from the community</h2>
        {items.length === 0 ? (
          <p className="mt-5 text-[14px] text-[var(--text-muted)]">
            No published pieces yet — publish from a session and it shows up here.
          </p>
        ) : (
          <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((item) => (
              <Link key={item.id} href={`/p/${encodeURIComponent(item.handle || '')}/${item.slug}`}
                className="group flex flex-col rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-5 hover:border-[var(--accent)]/40 hover:-translate-y-0.5 transition-all">
                <div className="flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
                  {item.type && <span className="capitalize">{item.type.replace(/_/g, ' ')}</span>}
                  {item.published_at && <><span className="opacity-40">·</span><time dateTime={item.published_at}>{fmtDate(item.published_at)}</time></>}
                </div>
                <h3 className="mt-2 font-display text-lg text-[var(--text-primary)] leading-snug line-clamp-2 group-hover:text-[var(--accent)] transition-colors">
                  {item.title || item.slug}
                </h3>
                {item.hook && <p className="mt-2 text-[13px] text-[var(--text-secondary)] line-clamp-3 leading-relaxed">{item.hook}</p>}
                {item.handle && <span className="mt-auto pt-4 text-[11px] text-[var(--text-muted)]">{item.author_name || item.handle}</span>}
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* CTA */}
      <section className="border-t border-[var(--border-subtle)]">
        <div className="mx-auto max-w-[1200px] px-6 py-14 text-center">
          <h2 className="font-display text-2xl sm:text-3xl text-[var(--text-primary)]">Want your work here?</h2>
          <p className="mt-2 text-[14px] text-[var(--text-secondary)]">Talk to Voice Native, ship something, and publish it in a click.</p>
          <Link href="/login"
            className="mt-6 inline-flex items-center gap-2 rounded-xl bg-[var(--accent)] px-5 py-3 text-[14px] font-semibold text-[var(--background)] hover:opacity-90 active:scale-[0.98] transition-all">
            Start talking — free
          </Link>
        </div>
      </section>
    </MarketingShell>
  )
}
