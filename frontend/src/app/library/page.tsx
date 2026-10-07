'use client'

/**
 * Library — the user's content library (Supabase `content_items`).
 *
 * The content-lens worker publishes one page per compaction period into
 * `content_items` (migration 007). This page is the dashboard-reachable view of
 * that library: it reads the signed-in owner's rows directly (RLS policy
 * `content_items_owner_select` = `auth.uid() = owner_user_id`, so the anon
 * browser client only ever sees the caller's own items), newest first, with a
 * status filter + search and an inline read view.
 */

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createSupabaseBrowser } from '@/lib/supabase-browser'
import type { User } from '@supabase/supabase-js'

interface ContentItem {
  id: string
  type: string | null
  status: string
  title: string | null
  hook: string | null
  body: string | null
  source_session_id: string | null
  source_kind: string | null
  slug: string | null
  published_at: string | null
  created_at: string
  updated_at: string
}

type StatusFilter = 'all' | 'published' | 'draft'

function fmtDate(iso: string | null): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  } catch {
    return iso.slice(0, 10)
  }
}

export default function LibraryPage() {
  const supabase = useMemo(() => createSupabaseBrowser(), [])
  const [user, setUser] = useState<User | null>(null)
  const [authChecked, setAuthChecked] = useState(false)
  const [items, setItems] = useState<ContentItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)

  // Resolve the signed-in user, then load their library rows (RLS scopes to owner).
  useEffect(() => {
    let cancelled = false
    supabase.auth.getUser().then(async ({ data: { user: u } }) => {
      if (cancelled) return
      setUser(u ?? null)
      setAuthChecked(true)
      if (!u) { setLoading(false); return }
      const { data, error: qErr } = await supabase
        .from('content_items')
        .select('id, type, status, title, hook, body, source_session_id, source_kind, slug, published_at, created_at, updated_at')
        .order('created_at', { ascending: false })
      if (cancelled) return
      if (qErr) setError(qErr.message)
      else setItems((data ?? []) as ContentItem[])
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [supabase])

  const counts = useMemo(() => ({
    all: items.length,
    published: items.filter(i => i.status === 'published').length,
    draft: items.filter(i => i.status === 'draft').length,
  }), [items])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items.filter(i => {
      if (filter !== 'all' && i.status !== filter) return false
      if (!q) return true
      return [i.title, i.hook, i.body, i.slug, i.type].some(f => (f ?? '').toLowerCase().includes(q))
    })
  }, [items, filter, query])

  return (
    <main className="min-h-screen bg-[var(--background)] flex flex-col">
      {/* Header — mirrors the dashboard header */}
      <header className="sticky top-0 z-40 border-b border-[var(--border-subtle)] bg-[var(--background)]/80 backdrop-blur-md">
        <div className="max-w-2xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/dashboard" title="Back to dashboard"
              className="p-1.5 -ml-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface)] transition-all">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
            </Link>
            <span className="font-display text-[var(--text-primary)] font-semibold text-[16px] tracking-tight">Library</span>
          </div>
          <span className="text-[11px] text-[var(--text-muted)]">{counts.all} item{counts.all === 1 ? '' : 's'}</span>
        </div>
      </header>

      <div className="max-w-2xl mx-auto w-full px-4 py-5 flex-1">
        {/* Filter tabs + search */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-2.5 mb-4">
          <div className="flex rounded-xl bg-[var(--surface)] border border-[var(--border-subtle)] p-1 gap-1">
            {(['all', 'published', 'draft'] as StatusFilter[]).map(f => (
              <button key={f} onClick={() => setFilter(f)}
                className={`flex-1 sm:flex-none px-3 py-1.5 rounded-lg text-[12.5px] font-medium capitalize transition-all ${
                  filter === f
                    ? 'bg-[var(--background)] text-[var(--text-primary)] shadow-sm border border-[var(--border-subtle)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                }`}>
                {f} <span className="text-[var(--text-muted)]">{counts[f]}</span>
              </button>
            ))}
          </div>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search library…"
            className="flex-1 min-w-0 bg-[var(--surface)] border border-[var(--border-subtle)] rounded-xl px-3 py-2 text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]/50"
          />
        </div>

        {/* States */}
        {!authChecked || loading ? (
          <div className="text-center py-16 text-[var(--text-muted)] text-sm">Loading your library…</div>
        ) : !user ? (
          <div className="text-center py-16">
            <p className="text-[var(--text-secondary)] text-sm mb-3">Sign in to view your library.</p>
            <Link href="/dashboard" className="text-[var(--accent)] text-sm hover:underline">Go to dashboard →</Link>
          </div>
        ) : error ? (
          <div className="rounded-lg border border-red-400/30 bg-red-400/[0.06] px-3 py-2.5 text-[12.5px] text-red-200">{error}</div>
        ) : visible.length === 0 ? (
          <div className="text-center py-16 text-[var(--text-muted)] text-sm">
            {items.length === 0
              ? 'No library pages yet. They’re published automatically as your sessions compact.'
              : 'Nothing matches that filter.'}
          </div>
        ) : (
          <ul className="space-y-2.5">
            {visible.map(item => {
              const isOpen = expanded === item.id
              const heading = item.title || item.slug || 'Untitled page'
              return (
                <li key={item.id}
                  className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] overflow-hidden">
                  <button onClick={() => setExpanded(isOpen ? null : item.id)}
                    className="w-full text-left px-3.5 py-3 flex items-start gap-3 hover:bg-[var(--surface-raised)] transition-colors">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[14px] font-medium text-[var(--text-primary)] truncate">{heading}</span>
                        <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium ${
                          item.status === 'published'
                            ? 'bg-emerald-500/15 text-emerald-300'
                            : 'bg-[var(--surface-raised)] text-[var(--text-muted)] border border-[var(--border-subtle)]'
                        }`}>{item.status}</span>
                        {item.type && <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] text-[var(--text-muted)] bg-[var(--background)] border border-[var(--border-subtle)]">{item.type}</span>}
                      </div>
                      {item.hook && <p className="text-[12.5px] text-[var(--text-secondary)] mt-1 line-clamp-2">{item.hook}</p>}
                      <div className="text-[11px] text-[var(--text-muted)] mt-1.5 flex items-center gap-2 flex-wrap">
                        <span>{fmtDate(item.published_at || item.created_at)}</span>
                        {item.source_session_id && <span className="font-mono">· {item.source_session_id.slice(0, 8)}</span>}
                        {item.source_kind && <span>· {item.source_kind}</span>}
                      </div>
                    </div>
                    <svg className={`w-4 h-4 shrink-0 mt-0.5 text-[var(--text-muted)] transition-transform ${isOpen ? 'rotate-90' : ''}`}
                      viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9 18l6-6-6-6" />
                    </svg>
                  </button>
                  {isOpen && (
                    <div className="px-3.5 pb-3.5 pt-0.5 border-t border-[var(--border-subtle)]">
                      {item.body
                        ? <pre className="whitespace-pre-wrap break-words font-sans text-[13px] text-[var(--text-secondary)] leading-relaxed mt-2">{item.body}</pre>
                        : <p className="text-[12px] text-[var(--text-muted)] mt-2 italic">No body content.</p>}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </main>
  )
}
