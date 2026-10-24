/**
 * Public, indexable article page — /p/{handle}/{slug}.
 *
 * SERVER component. Reads ONE published row from the SAFE `public_content`
 * view (migration 007) matching handle+slug, via the cookie-less anon client
 * so the page stays statically cacheable (ISR, revalidate = 3600).
 *
 * public_content exposes only published items and a safe column list, so this
 * can never leak drafts or another user's private columns.
 */

import { notFound } from 'next/navigation'
import Link from 'next/link'
import type { Metadata } from 'next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { createSupabaseAnon, SITE_URL, type PublicContent } from '@/lib/supabase-anon'
import TalkAboutItButton from '@/components/TalkAboutItButton'
import FastBrainChat from '@/components/FastBrainChat'

// Render at REQUEST time against the live DB — never prebuild. This page
// toggles published/unpublished and re-titles (new slug) via the studio, so
// static generation baked a stale "Not Found" at build time (seen in prod:
// 10-byte text/plain 404 that Safari downloaded). Correctness over CDN cache.
export const dynamic = 'force-dynamic'

interface PageParams {
  params: { handle: string; slug: string }
}

/** Fetch one published row by handle + slug from the safe public view. */
async function getItem(handle: string, slug: string): Promise<PublicContent | null> {
  const supabase = createSupabaseAnon()
  if (!supabase) return null
  const { data, error } = await supabase
    .from('public_content')
    .select('id, type, title, hook, body, transcript, slug, poster_path, published_at, handle, author_name')
    .eq('handle', decodeURIComponent(handle))
    .eq('slug', slug)
    .maybeSingle()
  if (error || !data) return null
  return data as PublicContent
}

function absPosterUrl(poster: string | null): string {
  if (!poster) return `${SITE_URL}/og.png`
  if (poster.startsWith('http://') || poster.startsWith('https://')) return poster
  return `${SITE_URL}${poster.startsWith('/') ? '' : '/'}${poster}`
}

function fmtDate(iso: string | null): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
  } catch {
    return iso.slice(0, 10)
  }
}

export async function generateMetadata({ params }: PageParams): Promise<Metadata> {
  const item = await getItem(params.handle, params.slug)
  if (!item) return { title: 'Not found — Voice Native' }

  const title = item.title || item.slug || 'Untitled'
  const description = item.hook || undefined
  const canonical = `${SITE_URL}/p/${encodeURIComponent(params.handle)}/${params.slug}`
  const image = absPosterUrl(item.poster_path)

  return {
    title: `${title} — Voice Native`,
    description,
    alternates: { canonical },
    openGraph: {
      title,
      description,
      url: canonical,
      type: 'article',
      publishedTime: item.published_at || undefined,
      images: [{ url: image }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [image],
    },
  }
}

export default async function PublicArticlePage({ params }: PageParams) {
  const item = await getItem(params.handle, params.slug)
  if (!item) notFound()

  const title = item.title || item.slug || 'Untitled'
  const canonical = `${SITE_URL}/p/${encodeURIComponent(params.handle)}/${params.slug}`
  const image = absPosterUrl(item.poster_path)

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: title,
    description: item.hook || undefined,
    datePublished: item.published_at || undefined,
    author: item.handle ? { '@type': 'Person', name: item.handle } : undefined,
    image: [image],
    mainEntityOfPage: { '@type': 'WebPage', '@id': canonical },
    publisher: { '@type': 'Organization', name: 'Voice Native', url: SITE_URL },
  }

  return (
    <main className="min-h-screen bg-[var(--background)] flex flex-col">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      {/* Minimal public header */}
      <header className="sticky top-0 z-40 border-b border-[var(--border-subtle)] bg-[var(--background)]/80 backdrop-blur-md">
        <div className="max-w-4xl mx-auto px-5 h-14 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
            <span className="w-6 h-6 rounded-full bg-[var(--accent)] flex items-center justify-center">
              <svg className="w-3.5 h-3.5 text-[var(--background)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-14 0m7 7v3m0-3a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
            </span>
            <span className="font-display font-semibold text-[15px] text-[var(--text-primary)] tracking-tight">Voice Native</span>
          </Link>
          <Link href="/login" className="text-[12.5px] text-[var(--accent)] hover:opacity-80 transition-opacity whitespace-nowrap">
            Start your own →
          </Link>
        </div>
      </header>

      <article className="w-full max-w-[72ch] mx-auto px-5 py-12 sm:py-16 flex-1">
        {/* Meta line */}
        <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-[var(--text-muted)] mb-4">
          {item.published_at && <time dateTime={item.published_at}>{fmtDate(item.published_at)}</time>}
          {item.handle && <><span className="opacity-40">·</span>
            <Link href={`/p/${encodeURIComponent(item.handle)}`} className="hover:text-[var(--accent)] transition-colors">{item.author_name || item.handle}</Link></>}
          {item.type && <><span className="opacity-40">·</span><span className="capitalize">{item.type.replace(/_/g, ' ')}</span></>}
        </div>

        <h1 className="font-display text-3xl sm:text-4xl font-medium text-[var(--text-primary)] leading-[1.15] tracking-tight">
          {title}
        </h1>

        {item.hook && (
          <p className="mt-4 text-[17px] italic text-[var(--text-secondary)] leading-relaxed">
            {item.hook}
          </p>
        )}

        <div className="mt-8 h-px bg-[var(--border-subtle)]" />

        <div className="mt-8 prose-osborn text-[16px] text-[var(--text-secondary)] leading-[1.75]">
          {item.body ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.body}</ReactMarkdown>
          ) : (
            <p className="text-[var(--text-muted)] italic">No content.</p>
          )}
        </div>
      </article>

      {/* On-page conversation — a lightweight fast-brain chat grounded in this
          piece. Ask questions here; reproduce the whole thing below. */}
      <section className="w-full max-w-[72ch] mx-auto px-5 pb-4">
        <FastBrainChat itemId={item.id} title={item.title} hook={item.hook} body={item.body} />
      </section>

      {/* Footer CTA — reproduce this task as your own, or start fresh */}
      <footer className="border-t border-[var(--border-subtle)]">
        <div className="max-w-[72ch] mx-auto px-5 py-10 text-center">
          <p className="font-display text-xl text-[var(--text-primary)]">Want your own version?</p>
          <p className="mt-1.5 text-[13px] text-[var(--text-secondary)]">
            Drop into a Voice Native session seeded with this piece and reproduce it as your own — same format, your topic.
          </p>
          <div className="mt-5 flex flex-col sm:flex-row items-center justify-center gap-3">
            <TalkAboutItButton itemId={item.id} type={item.type} title={item.title} hook={item.hook} body={item.body} />
            <Link href="/login"
              className="text-[13px] text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors">
              Start fresh →
            </Link>
          </div>
        </div>
      </footer>
    </main>
  )
}
