'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createSupabaseBrowser } from '@/lib/supabase-browser'

/**
 * LibraryBriefs — session-generated BRIEFS as a horizontal shelf.
 * MODELS: shelf anatomy from Spotify Home / App Store Today (cards scroll
 * horizontally with snap — the page stops growing downward); card look from
 * App Store feature cards (title + caption + meta pill). Rows link into
 * /library for refine/publish (workflows never duplicated here).
 * DESKTOP/LANDSCAPE ONLY (hidden below lg) per the founder's IA lock.
 */

interface Brief {
  id: string
  type: string | null
  status: string | null
  title: string | null
  hook: string | null
  created_at: string
}

function ago(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

const TYPE_LABEL: Record<string, string> = {
  blog: 'Blog', x_thread: 'X thread', linkedin: 'LinkedIn', short: 'Short script',
  newsletter: 'Newsletter', note: 'Note', source: 'Session brief',
}

export default function LibraryBriefs() {
  const [items, setItems] = useState<Brief[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const sb = createSupabaseBrowser()
        const { data: u } = await sb.auth.getUser()
        if (!u.user || cancelled) return
        const { data } = await sb
          .from('content_items')
          .select('id, type, status, title, hook, created_at')
          .order('created_at', { ascending: false })
          .limit(12)
        if (!cancelled) setItems((data ?? []) as Brief[])
      } catch { /* quiet surface */ }
      finally { if (!cancelled) setLoaded(true) }
    })()
    return () => { cancelled = true }
  }, [])

  return (
    <section className="mb-6 hidden lg:block" style={{ animation: 'fadeSlideIn .55s ease both' }}>
      <div className="flex items-center gap-2 mb-2.5 px-0.5">
        <svg className="w-4 h-4 text-[var(--accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 19.5A2.5 2.5 0 016.5 17H20" /><path strokeLinecap="round" strokeLinejoin="round" d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" /></svg>
        <h2 className="text-[var(--text-primary)] text-sm font-semibold">Briefs from your sessions</h2>
        <Link href="/library" className="ml-auto text-[11.5px] text-[var(--accent)] hover:opacity-80 transition-opacity">
          Open library →
        </Link>
      </div>

      {!loaded ? (
        <div className="flex items-center gap-2 py-4">
          <span className="w-4 h-4 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
          <span className="text-[13px] text-[var(--text-muted)]">Loading…</span>
        </div>
      ) : items.length === 0 ? (
        <p className="text-[13px] text-[var(--text-muted)] py-3 px-0.5">
          No briefs yet — ask in a session to turn your work into a brief, then refine and publish it.
        </p>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-2 snap-x snap-mandatory" style={{ scrollbarWidth: 'thin' }}>
          {items.map(b => (
            <Link key={b.id} href="/library"
              className="snap-start shrink-0 w-[240px] lg:w-[260px] rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] p-3.5 hover:border-[var(--accent-dim)]/50 transition-colors group">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[10.5px] font-medium px-2 py-0.5 rounded-full shrink-0"
                  style={{
                    background: b.status === 'published' ? 'color-mix(in oklab, #22c55e 14%, transparent)' : 'var(--surface-2)',
                    color: b.status === 'published' ? '#4ade80' : 'var(--text-muted)',
                  }}>
                  {b.type ? (TYPE_LABEL[b.type] || b.type) : 'Brief'}
                </span>
                <span className="ml-auto text-[10.5px] text-[var(--text-muted)]">{ago(b.created_at)}</span>
              </div>
              <p className="text-[13.5px] font-medium text-[var(--text-primary)] truncate group-hover:text-[var(--accent)] transition-colors">
                {b.title || 'Untitled'}
              </p>
              {b.hook && <p className="text-[12px] text-[var(--text-muted)] leading-snug line-clamp-2 mt-1">{b.hook}</p>}
            </Link>
          ))}
        </div>
      )}
    </section>
  )
}
