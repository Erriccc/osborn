'use client'

/**
 * Library — the user's content library (Supabase `content_items`).
 *
 * The content-lens worker publishes one page per compaction period into
 * `content_items` (migration 007). This page is the dashboard-reachable view of
 * that library: it reads the signed-in owner's rows directly (RLS policy
 * `content_items_owner_select` = `auth.uid() = owner_user_id`, so the anon
 * browser client only ever sees the caller's own items), newest first, with a
 * status filter + search, a responsive card grid, and a reading modal.
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

function DocIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 3v4a1 1 0 001 1h4" />
      <path d="M17 21H7a2 2 0 01-2-2V5a2 2 0 012-2h7l5 5v11a2 2 0 01-2 2z" />
      <path d="M9 9h1M9 13h6M9 17h6" />
    </svg>
  )
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
  const [reading, setReading] = useState<ContentItem | null>(null)
  const [handle, setHandle] = useState<string | null>(null)
  const [publishing, setPublishing] = useState(false)
  const [copied, setCopied] = useState(false)

  // Resolve the signed-in user, then load their library rows (RLS scopes to owner).
  useEffect(() => {
    let cancelled = false
    supabase.auth.getUser().then(async ({ data: { user: u } }) => {
      if (cancelled) return
      setUser(u ?? null)
      setAuthChecked(true)
      if (!u) { setLoading(false); return }
      // Owner handle for public URLs = profiles.username (email during alpha,
      // per migration 007). Fall back to the email if the profile isn't loaded.
      supabase.from('profiles').select('username').eq('id', u.id).maybeSingle()
        .then(({ data: p }) => {
          if (cancelled) return
          setHandle((p as { username?: string } | null)?.username ?? u.email ?? null)
        })
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

  // Public URL for a published item (null until we know handle + slug).
  const publicUrl = (item: ContentItem): string | null =>
    handle && item.slug && item.status === 'published'
      ? `https://voice-native.com/p/${encodeURIComponent(handle)}/${item.slug}`
      : null

  async function togglePublish(item: ContentItem, action: 'publish' | 'unpublish') {
    if (publishing) return
    setPublishing(true)
    try {
      const res = await fetch('/api/content/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, itemId: item.id, slug: item.slug ?? undefined }),
      })
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || 'Request failed')
      // Optimistically patch the item in place (and the open modal).
      const patch = (i: ContentItem): ContentItem =>
        i.id === item.id
          ? {
              ...i,
              status: action === 'publish' ? 'published' : 'draft',
              slug: json.slug ?? i.slug,
              published_at: action === 'publish' ? (json.publishedAt ?? i.published_at ?? new Date().toISOString()) : i.published_at,
            }
          : i
      setItems(prev => prev.map(patch))
      setReading(prev => (prev && prev.id === item.id ? patch(prev) : prev))
      if (json.handle) setHandle(json.handle)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Publish failed')
    } finally {
      setPublishing(false)
    }
  }

  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch { /* clipboard unavailable */ }
  }

  // Esc closes the reading modal.
  useEffect(() => {
    if (!reading) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setReading(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [reading])

  const counts = useMemo(() => ({
    all: items.length,
    published: items.filter(i => i.status === 'published').length,
    draft: items.filter(i => i.status === 'draft').length,
  }), [items])

  // Most-recently-published item, for the Featured hero. Only shown when the
  // current filter would include it (so it never fights the filter/search).
  const featured = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matches = items
      .filter(i => i.status === 'published' && i.published_at)
      .filter(i => {
        if (filter === 'draft') return false
        if (!q) return true
        return [i.title, i.hook, i.body, i.slug, i.type].some(f => (f ?? '').toLowerCase().includes(q))
      })
      .sort((a, b) => (b.published_at! > a.published_at! ? 1 : -1))
    return matches[0] ?? null
  }, [items, filter, query])

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
      {/* Header — logo home + breadcrumb, mirrors the dashboard chrome */}
      <header className="sticky top-0 z-40 border-b border-[var(--border-subtle)] bg-[var(--background)]/80 backdrop-blur-md">
        <div className="max-w-6xl mx-auto px-4 lg:px-6 h-12 flex items-center justify-between">
          <div className="flex items-center gap-2.5 min-w-0">
            <Link href="/dashboard" className="flex items-center gap-2 hover:opacity-80 transition-opacity shrink-0">
              <div className="w-6 h-6 rounded-full bg-[var(--accent)] flex items-center justify-center">
                <svg className="w-3.5 h-3.5 text-[var(--background)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-14 0m7 7v3m0-3a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
              </div>
              <span className="font-display font-semibold text-[15px] text-[var(--text-primary)] tracking-tight">Osborn</span>
            </Link>
            <span className="text-[var(--text-muted)]">/</span>
            <span className="text-[14px] text-[var(--text-secondary)]">Library</span>
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto w-full px-4 lg:px-6 py-7 flex-1">
        {/* Hero */}
        <div className="mb-6">
          <h1 className="font-display text-2xl sm:text-3xl font-medium text-[var(--text-primary)] leading-tight">Library</h1>
          <p className="mt-1 text-[13px] text-[var(--text-secondary)]">
            {counts.all > 0
              ? `${counts.all} page${counts.all === 1 ? '' : 's'} your sessions wrote — ${counts.published} published, ${counts.draft} draft.`
              : 'Pages your sessions write show up here automatically.'}
          </p>
        </div>

        {/* Toolbar: filter segments + search */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-2.5 mb-5">
          <div className="inline-flex rounded-xl bg-[var(--surface)] border border-[var(--border-subtle)] p-1 gap-1">
            {(['all', 'published', 'draft'] as StatusFilter[]).map(f => (
              <button key={f} onClick={() => setFilter(f)}
                className={`px-3 py-1.5 rounded-lg text-[12.5px] font-medium capitalize transition-all ${
                  filter === f
                    ? 'bg-[var(--accent)] text-[var(--background)] shadow-sm'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                }`}>
                {f} <span className={filter === f ? 'opacity-70' : 'text-[var(--text-muted)]'}>{counts[f]}</span>
              </button>
            ))}
          </div>
          <div className="relative flex-1 min-w-0 sm:max-w-sm">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M11 18a7 7 0 100-14 7 7 0 000 14z" /></svg>
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search library…"
              className="w-full bg-[var(--surface)] border border-[var(--border-subtle)] rounded-xl pl-9 pr-3 py-2 text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]/50"
            />
          </div>
        </div>

        {/* States */}
        {!authChecked || loading ? (
          <div className="flex flex-col items-center justify-center py-24 gap-3">
            <div className="w-6 h-6 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
            <p className="text-[var(--text-muted)] text-sm">Loading your library…</p>
          </div>
        ) : !user ? (
          <div className="text-center py-24">
            <p className="text-[var(--text-secondary)] text-sm mb-3">Sign in to view your library.</p>
            <Link href="/dashboard" className="text-[var(--accent)] text-sm hover:underline">Go to dashboard →</Link>
          </div>
        ) : error ? (
          <div className="rounded-lg border border-red-400/30 bg-red-400/[0.06] px-3 py-2.5 text-[12.5px] text-red-200">{error}</div>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 gap-3 text-center">
            <div className="w-12 h-12 rounded-2xl bg-[var(--surface)] border border-[var(--border-subtle)] flex items-center justify-center">
              <DocIcon className="w-6 h-6 text-[var(--text-muted)]" />
            </div>
            <p className="text-[var(--text-secondary)] text-sm max-w-xs">
              {items.length === 0
                ? 'No library pages yet. They’re written automatically as your sessions compact.'
                : 'Nothing matches that filter.'}
            </p>
          </div>
        ) : (
          <>
            {/* Featured hero — the most recently published page, feed-style. */}
            {featured && (
              <div className="mb-7 rounded-3xl border border-[var(--border-subtle)] bg-gradient-to-br from-[var(--surface)] to-[var(--surface-2)] p-6 sm:p-8">
                <div className="flex items-center gap-2 mb-3">
                  <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium bg-[var(--accent-dim)]/25 text-[var(--accent)]">Featured</span>
                  <span className="text-[11px] text-[var(--text-muted)]">{fmtDate(featured.published_at)}</span>
                  {featured.type && <><span className="text-[var(--text-muted)] opacity-40">·</span><span className="text-[11px] text-[var(--text-muted)] capitalize">{featured.type.replace(/_/g, ' ')}</span></>}
                </div>
                <h2 className="font-display text-2xl sm:text-3xl font-medium text-[var(--text-primary)] leading-tight max-w-2xl">
                  {featured.title || featured.slug || 'Untitled page'}
                </h2>
                {featured.hook && <p className="mt-2.5 text-[14px] text-[var(--text-secondary)] italic leading-relaxed max-w-2xl">{featured.hook}</p>}
                <div className="mt-5 flex flex-wrap items-center gap-2.5">
                  <button onClick={() => setReading(featured)}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--accent)] text-[var(--background)] px-4 py-2 text-[13px] font-semibold hover:opacity-90 transition-opacity">
                    Read →
                  </button>
                  {publicUrl(featured) && (
                    <button onClick={() => copyLink(publicUrl(featured)!)}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] text-[var(--text-secondary)] px-4 py-2 text-[13px] font-medium hover:text-[var(--text-primary)] hover:border-[var(--accent-dim)]/50 transition-all">
                      {copied ? 'Copied ✓' : 'Copy link'}
                    </button>
                  )}
                </div>
              </div>
            )}

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {visible.map(item => {
              const heading = item.title || item.slug || 'Untitled page'
              const published = item.status === 'published'
              return (
                <button key={item.id} onClick={() => setReading(item)}
                  className="group text-left flex flex-col rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-4 hover:border-[var(--accent-dim)]/50 hover:-translate-y-0.5 hover:shadow-[0_8px_30px_-12px_rgba(0,0,0,0.6)] transition-all">
                  <div className="flex items-center justify-between mb-3">
                    <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${published ? 'bg-[var(--accent-dim)]/25 text-[var(--accent)]' : 'bg-[var(--surface-2)] text-[var(--text-muted)]'}`}>
                      <DocIcon className="w-[18px] h-[18px]" />
                    </div>
                    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium ${
                      published ? 'bg-emerald-500/15 text-emerald-300' : 'bg-[var(--surface-2)] text-[var(--text-muted)]'
                    }`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${published ? 'bg-emerald-400' : 'bg-[var(--text-muted)]'}`} />
                      {item.status}
                    </span>
                  </div>
                  <h3 className="text-[15px] font-semibold text-[var(--text-primary)] leading-snug line-clamp-2 group-hover:text-[var(--accent)] transition-colors">{heading}</h3>
                  {item.hook && <p className="text-[12.5px] text-[var(--text-secondary)] mt-1.5 line-clamp-3 leading-relaxed">{item.hook}</p>}
                  <div className="mt-auto pt-3 flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
                    <span>{fmtDate(item.published_at || item.created_at)}</span>
                    {item.type && <><span className="opacity-40">·</span><span>{item.type}</span></>}
                  </div>
                </button>
              )
            })}
          </div>
          </>
        )}
      </div>

      {/* Reading modal */}
      {reading && (
        <div className="fixed inset-0 z-[200] flex items-start sm:items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-6" onClick={() => setReading(null)}>
          <div className="w-full sm:max-w-2xl max-h-full sm:max-h-[85vh] bg-[var(--surface)] sm:rounded-2xl border border-[var(--border-subtle)] shadow-2xl flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-[var(--border-subtle)] shrink-0">
              <div className="min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium ${
                    reading.status === 'published' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-[var(--surface-2)] text-[var(--text-muted)]'
                  }`}>{reading.status}</span>
                  <span className="text-[11px] text-[var(--text-muted)]">{fmtDate(reading.published_at || reading.created_at)}</span>
                </div>
                <h2 className="text-lg font-semibold text-[var(--text-primary)] leading-snug">{reading.title || reading.slug || 'Untitled page'}</h2>
              </div>
              <button onClick={() => setReading(null)} aria-label="Close"
                className="shrink-0 p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="overflow-y-auto px-5 py-4">
              {reading.hook && <p className="text-[13px] text-[var(--text-secondary)] italic mb-3">{reading.hook}</p>}
              {reading.body
                ? <pre className="whitespace-pre-wrap break-words font-sans text-[13.5px] text-[var(--text-secondary)] leading-relaxed">{reading.body}</pre>
                : <p className="text-[12px] text-[var(--text-muted)] italic">No body content.</p>}
            </div>

            {/* Publish control — the only way to make an item public is this POST
                to /api/content/publish (the browser RLS can't flip to published). */}
            <div className="shrink-0 border-t border-[var(--border-subtle)] px-5 py-3.5">
              {reading.status === 'published' ? (
                <div className="flex flex-col gap-2.5">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-emerald-300">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> Public ✓
                    </span>
                    {publicUrl(reading) && (
                      <>
                        <span className="text-[var(--text-muted)] opacity-40">·</span>
                        <button onClick={() => copyLink(publicUrl(reading)!)}
                          className="text-[12.5px] text-[var(--accent)] hover:underline">
                          {copied ? 'Copied ✓' : 'Copy link'}
                        </button>
                        <span className="text-[var(--text-muted)] opacity-40">·</span>
                      </>
                    )}
                    <button disabled={publishing} onClick={() => togglePublish(reading, 'unpublish')}
                      className="text-[12.5px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50">
                      {publishing ? 'Working…' : 'Make private'}
                    </button>
                  </div>
                  {publicUrl(reading) && (
                    <code className="block text-[11px] text-[var(--text-muted)] truncate font-mono">{publicUrl(reading)}</code>
                  )}
                </div>
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <p className="text-[12px] text-[var(--text-muted)]">Publishing makes this page public and indexable.</p>
                  <button disabled={publishing} onClick={() => togglePublish(reading, 'publish')}
                    className="shrink-0 inline-flex items-center gap-1.5 rounded-xl bg-[var(--accent)] text-[var(--background)] px-4 py-2 text-[13px] font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity">
                    {publishing ? 'Publishing…' : 'Publish to web'}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
