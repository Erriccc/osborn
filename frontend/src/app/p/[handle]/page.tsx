/**
 * Public author index — /p/{handle}. Lists that handle's PUBLISHED items.
 *
 * SERVER component. Reads only the safe `public_content` view (published rows,
 * safe columns) via the cookie-less anon client. ISR, revalidate = 3600.
 */

import Link from 'next/link'
import type { Metadata } from 'next'
import { createSupabaseAnon, SITE_URL, type PublicContent } from '@/lib/supabase-anon'

export const revalidate = 3600

interface PageParams {
  params: { handle: string }
}

async function getItems(handle: string): Promise<PublicContent[]> {
  const supabase = createSupabaseAnon()
  if (!supabase) return []
  const { data, error } = await supabase
    .from('public_content')
    .select('id, type, title, hook, body, transcript, slug, poster_path, published_at, handle')
    .eq('handle', decodeURIComponent(handle))
    .order('published_at', { ascending: false })
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

export async function generateMetadata({ params }: PageParams): Promise<Metadata> {
  const handle = decodeURIComponent(params.handle)
  const canonical = `${SITE_URL}/p/${encodeURIComponent(params.handle)}`
  return {
    title: `${handle} — Voice Native`,
    description: `Pages published by ${handle} on Voice Native.`,
    alternates: { canonical },
    openGraph: {
      title: `${handle} — Voice Native`,
      description: `Pages published by ${handle} on Voice Native.`,
      url: canonical,
      type: 'profile',
      images: [{ url: `${SITE_URL}/og.png` }],
    },
    twitter: { card: 'summary_large_image', title: `${handle} — Voice Native` },
  }
}

export default async function AuthorIndexPage({ params }: PageParams) {
  const handle = decodeURIComponent(params.handle)
  const items = await getItems(params.handle)

  return (
    <main className="min-h-screen bg-[var(--background)] flex flex-col">
      <header className="sticky top-0 z-40 border-b border-[var(--border-subtle)] bg-[var(--background)]/80 backdrop-blur-md">
        <div className="max-w-4xl mx-auto px-5 h-14 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
            <span className="w-6 h-6 rounded-full bg-[var(--accent)] flex items-center justify-center">
              <svg className="w-3.5 h-3.5 text-[var(--background)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-14 0m7 7v3m0-3a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
            </span>
            <span className="font-display font-semibold text-[15px] text-[var(--text-primary)] tracking-tight">Voice Native</span>
          </Link>
          <Link href="/login" className="text-[12.5px] text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors">
            <span className="text-[var(--accent)]">Start your own →</span>
          </Link>
        </div>
      </header>

      <div className="w-full max-w-4xl mx-auto px-5 py-12 flex-1">
        <h1 className="font-display text-3xl font-medium text-[var(--text-primary)] tracking-tight">{handle}</h1>
        <p className="mt-1.5 text-[13px] text-[var(--text-secondary)]">
          {items.length} published page{items.length === 1 ? '' : 's'}
        </p>

        {items.length === 0 ? (
          <p className="mt-10 text-[var(--text-muted)] text-sm">Nothing published yet.</p>
        ) : (
          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            {items.map(item => (
              <Link key={item.id} href={`/p/${encodeURIComponent(handle)}/${item.slug}`}
                className="group flex flex-col rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-5 hover:border-[var(--accent-dim)]/50 hover:-translate-y-0.5 transition-all">
                <h2 className="font-display text-lg text-[var(--text-primary)] leading-snug line-clamp-2 group-hover:text-[var(--accent)] transition-colors">
                  {item.title || item.slug}
                </h2>
                {item.hook && <p className="mt-2 text-[13px] text-[var(--text-secondary)] line-clamp-3 leading-relaxed">{item.hook}</p>}
                <div className="mt-auto pt-4 text-[11px] text-[var(--text-muted)]">{fmtDate(item.published_at)}</div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </main>
  )
}
