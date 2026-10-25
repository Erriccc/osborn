'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createSupabaseBrowser } from '@/lib/supabase-browser'

/**
 * LibraryBriefs — BRIEFS GENERATED FROM PREVIOUS SESSIONS, surfaced on the
 * dashboard. MODELS: Google Drive "Recent files" list (title-first row, type
 * chip, status, relative date — instantly recognizable document listing);
 * height discipline per the founder's viewport rule (30dvh cap + internal
 * scroll). DESKTOP/LANDSCAPE ONLY (hidden below lg) per the founder — mobile
 * keeps the lean single-column dashboard and reaches these via /library.
 *
 * Data: the signed-in user's content_items (RLS owner-scoped) — the same
 * rows /library manages; this is the read-mostly at-a-glance surface. Rows
 * link into /library for refine/publish (never duplicated here).
 */

interface Brief {
  id: string
  type: string | null
  status: string | null
  title: string | null
  hook: string | null
  slug: string | null
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
          .select('id, type, status, title, hook, slug, created_at')
          .order('created_at', { ascending: false })
          .limit(50)
        if (!cancelled) setItems((data ?? []) as Brief[])
      } catch { /* not signed in / table missing — surface stays quiet */ }
      finally { if (!cancelled) setLoaded(true) }
    })()
    return () => { cancelled = true }
  }, [])

  return (
    <section className="mb-6 hidden lg:block rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] p-4" style={{ animation: 'fadeSlideIn .55s ease both' }}>
      <div className="flex items-center gap-2 mb-3">
        <svg className="w-4 h-4 text-[var(--accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 19.5A2.5 2.5 0 016.5 17H20" /><path strokeLinecap="round" strokeLinejoin="round" d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" /></svg>
        <h2 className="text-[var(--text-primary)] text-sm font-semibold">Briefs from your sessions</h2>
        <Link href="/library" className="ml-auto text-[11.5px] text-[var(--accent)] hover:opacity-80 transition-opacity">
          Open library →
        </Link>
      </div>

      {!loaded ? (
        <div className="flex items-center gap-2 py-3">
          <span className="w-4 h-4 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
          <span className="text-[13px] text-[var(--text-muted)]">Loading…</span>
        </div>
      ) : items.length === 0 ? (
        <p className="text-[13px] text-[var(--text-muted)] py-2">
          No briefs yet — ask in a session to turn your work into a brief, then refine and publish it here.
        </p>
      ) : (
        <ul className="max-h-[30dvh] overflow-y-auto -mx-2 px-2 divide-y divide-[var(--border-subtle)]/60">
          {items.map(b => (
            <li key={b.id}>
              <Link href="/library" className="flex items-center gap-3 py-2.5 group">
                <span className="flex-1 min-w-0">
                  <span className="block text-[13.5px] font-medium text-[var(--text-primary)] truncate group-hover:text-[var(--accent)] transition-colors">
                    {b.title || 'Untitled'}
                  </span>
                  {b.hook && <span className="block text-[12px] text-[var(--text-muted)] truncate mt-0.5">{b.hook}</span>}
                </span>
                <span className="shrink-0 text-[10.5px] font-medium px-2 py-0.5 rounded-full"
                  style={{
                    background: b.status === 'published' ? 'color-mix(in oklab, #22c55e 14%, transparent)' : 'var(--surface-2)',
                    color: b.status === 'published' ? '#4ade80' : 'var(--text-muted)',
                  }}>
                  {b.type ? (TYPE_LABEL[b.type] || b.type) : 'Brief'}
                </span>
                <span className="shrink-0 text-[10.5px] text-[var(--text-muted)] w-12 text-right">{ago(b.created_at)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
