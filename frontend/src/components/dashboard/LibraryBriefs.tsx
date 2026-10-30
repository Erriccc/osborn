'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { createSupabaseBrowser } from '@/lib/supabase-browser'

/**
 * LibraryBriefs — session-generated briefs as a scannable VERTICAL FEED.
 * MODELS: Muse's /feed (the founder's benchmark) — headline → hook → the
 * evidence rendered INLINE (markdown: tables, stat callouts, code) → timestamp,
 * with a light status filter. Reads like a news feed, not a tool. Cards open
 * into /library for refine/publish (those workflows are never duplicated here).
 * DESKTOP/LANDSCAPE ONLY (hidden below lg) per the founder's IA lock.
 */

interface Brief {
  id: string
  type: string | null
  status: string | null
  title: string | null
  hook: string | null
  body: string | null
  created_at: string
}

type StatusFilter = 'all' | 'published' | 'draft'

function ago(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

const TYPE_LABEL: Record<string, string> = {
  blog: 'Blog', x_thread: 'X thread', linkedin: 'LinkedIn', short: 'Short script',
  newsletter: 'Newsletter', note: 'Note', source: 'Session brief', text_post: 'Post',
}

// Render at most this much of the body in the feed preview — it's clamped
// visually too, but slicing keeps a 50KB brief from mounting in full ×8.
const PREVIEW_CHARS = 1200

export default function LibraryBriefs() {
  const [items, setItems] = useState<Brief[]>([])
  const [loaded, setLoaded] = useState(false)
  const [filter, setFilter] = useState<StatusFilter>('all')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const sb = createSupabaseBrowser()
        const { data: u } = await sb.auth.getUser()
        if (!u.user || cancelled) return
        const { data } = await sb
          .from('content_items')
          .select('id, type, status, title, hook, body, created_at')
          .order('created_at', { ascending: false })
          .limit(12)
        if (!cancelled) setItems((data ?? []) as Brief[])
      } catch { /* quiet surface */ }
      finally { if (!cancelled) setLoaded(true) }
    })()
    return () => { cancelled = true }
  }, [])

  const counts = useMemo(() => ({
    all: items.length,
    published: items.filter(i => i.status === 'published').length,
    draft: items.filter(i => i.status !== 'published').length,
  }), [items])

  const visible = useMemo(() => items.filter(i =>
    filter === 'all' ? true : filter === 'published' ? i.status === 'published' : i.status !== 'published',
  ).slice(0, 8), [items, filter])

  const CHIPS: { k: StatusFilter; label: string }[] = [
    { k: 'all', label: 'All' },
    { k: 'published', label: 'Published' },
    { k: 'draft', label: 'Drafts' },
  ]

  return (
    <section className="mb-6 hidden lg:block" style={{ animation: 'fadeSlideIn .55s ease both' }}>
      <div className="flex items-center gap-2 mb-3 px-0.5">
        <svg className="w-4 h-4 text-[var(--accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 19.5A2.5 2.5 0 016.5 17H20" /><path strokeLinecap="round" strokeLinejoin="round" d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" /></svg>
        <h2 className="text-[var(--text-primary)] text-sm font-semibold">Briefs from your sessions</h2>
        <div className="ml-auto flex items-center gap-1.5">
          {loaded && items.length > 0 && CHIPS.map(c => (
            <button key={c.k} onClick={() => setFilter(c.k)}
              aria-pressed={filter === c.k}
              className={'min-h-[28px] px-2.5 rounded-full text-[11.5px] font-medium transition-colors ' +
                (filter === c.k
                  ? 'bg-[var(--accent)] text-[var(--background)]'
                  : 'text-[var(--text-secondary)] bg-[var(--surface)] border border-[var(--border-subtle)] hover:text-[var(--text-primary)]')}>
              {c.label} <span className={filter === c.k ? 'opacity-80' : 'opacity-60'}>{counts[c.k]}</span>
            </button>
          ))}
          <Link href="/library" className="text-[11.5px] text-[var(--accent)] hover:opacity-80 transition-opacity ml-1">
            Open library →
          </Link>
        </div>
      </div>

      {!loaded ? (
        <div className="flex items-center gap-2 py-4">
          <span className="w-4 h-4 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
          <span className="text-[13px] text-[var(--text-muted)]">Loading…</span>
        </div>
      ) : visible.length === 0 ? (
        <p className="text-[13px] text-[var(--text-muted)] py-3 px-0.5">
          {items.length === 0
            ? 'No briefs yet — ask in a session to turn your work into a brief, then refine and publish it.'
            : 'Nothing matches that filter.'}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {visible.map(b => {
            const body = (b.body || '').replace(/<!--[\s\S]*?-->/g, '').trim()
            const preview = body.slice(0, PREVIEW_CHARS)
            const published = b.status === 'published'
            return (
              <article key={b.id}
                className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-5 hover:border-[var(--accent-dim)]/40 transition-colors">
                <header className="flex items-center gap-2 mb-1.5">
                  <span className="text-[10.5px] font-medium px-2 py-0.5 rounded-full shrink-0"
                    style={{
                      background: published ? 'color-mix(in oklab, #22c55e 14%, transparent)' : 'var(--surface-2)',
                      color: published ? '#4ade80' : 'var(--text-muted)',
                    }}>
                    {b.type ? (TYPE_LABEL[b.type] || b.type) : 'Brief'}
                  </span>
                  {published && (
                    <span className="inline-flex items-center gap-1 text-[10.5px] text-emerald-400/90">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> Public
                    </span>
                  )}
                  <time className="ml-auto text-[11px] text-[var(--text-muted)]">{ago(b.created_at)}</time>
                </header>

                <Link href="/library" className="block group">
                  <h3 className="font-display text-[16px] font-medium text-[var(--text-primary)] leading-snug group-hover:text-[var(--accent)] transition-colors">
                    {b.title || 'Untitled brief'}
                  </h3>
                </Link>

                {b.hook && (
                  <p className="text-[13px] text-[var(--text-secondary)] italic leading-relaxed mt-1">{b.hook}</p>
                )}

                {preview && (
                  <div className="relative mt-3 max-h-[220px] overflow-hidden">
                    <div className="prose-osborn text-[12.5px] leading-relaxed">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{preview}</ReactMarkdown>
                    </div>
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-[var(--surface)] to-transparent" />
                  </div>
                )}

                <div className="mt-3">
                  <Link href="/library" className="text-[12px] font-medium text-[var(--accent)] hover:opacity-80 transition-opacity">
                    Open in library →
                  </Link>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}
