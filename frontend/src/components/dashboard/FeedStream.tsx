'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createSupabaseBrowser } from '@/lib/supabase-browser'
import { prettySessionPreview, sessionActivityTime } from '@/lib/sessions'
import CompletionCard, { type Completion } from './CompletionCard'

/**
 * FeedStream — a labeled, vertical "dashboard-as-feed" section. This is the
 * phase-1 slice: the COMPLETIONS stream (replacing the old <LibraryBriefs/>).
 * It reuses data that already exists — published/draft `content_items` briefs
 * plus finished sessions from the already-loaded `sessions` prop — and renders
 * each as a passive CompletionCard, newest first. No new infra, no agent calls,
 * no realtime (those are later phases). The thin section shell (header label,
 * "Open library" link, loading / empty states, vertical list) is deliberately
 * generic so the later OFFERS / LIVE streams can reuse it.
 *
 * DESKTOP/LANDSCAPE ONLY (hidden below lg) — matches the slot it replaces and
 * the founder's IA lock for this feed.
 */

// Per-viewer "new since last visit" marker. localStorage is a convenience only:
// every access is wrapped so the feed renders fine if storage throws (private
// window, blocked site data, SSR) — a thrown read just means "nothing seen yet".
const SEEN_KEY = 'vn:feed:completions:lastSeen'

function readLastSeen(): number {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(SEEN_KEY) : null
    const n = v ? Number(v) : 0
    return Number.isFinite(n) ? n : 0
  } catch { return 0 }
}

function writeLastSeen(ms: number): void {
  try { localStorage.setItem(SEEN_KEY, String(ms)) } catch { /* ignore */ }
}

interface Brief {
  id: string
  type: string | null
  status: string | null
  title: string | null
  hook: string | null
  body: string | null
  created_at: string
}

// Only the session fields the feed reads; every one optional so older agents
// (no title / lastActivityAt) stay compatible.
interface FeedSession {
  sessionId: string
  timestamp: string
  lastMessage?: string
  cwd?: string
  title?: string | null
  lastActivityAt?: string | null
}

export default function FeedStream({
  kind = 'completions',
  sessions,
  onResume,
}: {
  // Only 'completions' is built in phase 1; the prop exists so the page can
  // name the stream and future phases can add 'offers' / 'live'.
  kind?: 'completions'
  sessions: FeedSession[]
  onResume: (sessionId: string, cwd?: string) => void
}) {
  const [briefs, setBriefs] = useState<Brief[]>([])
  const [loaded, setLoaded] = useState(false)
  // Snapshot the last-seen marker once on mount, so cards keep their "new" dot
  // for the whole visit even after we advance the marker below.
  const [lastSeen] = useState<number>(() => readLastSeen())

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
        if (!cancelled) setBriefs((data ?? []) as Brief[])
      } catch { /* quiet surface */ }
      finally { if (!cancelled) setLoaded(true) }
    })()
    return () => { cancelled = true }
  }, [])

  // Merge briefs + finished sessions into one completions list, newest first.
  const items = useMemo<Completion[]>(() => {
    const fromBriefs: Completion[] = briefs.map(b => ({
      id: `brief:${b.id}`,
      kind: 'brief',
      at: b.created_at,
      title: b.title || 'Untitled brief',
      typeLabel: b.type,
      status: b.status,
      hook: b.hook,
      body: b.body,
    }))
    const fromSessions: Completion[] = sessions.map(s => {
      const pv = prettySessionPreview(s)
      return {
        id: `session:${s.sessionId}`,
        kind: 'session',
        at: sessionActivityTime(s),
        title: pv.text,
        typeLabel: pv.label,
        sessionId: s.sessionId,
        cwd: s.cwd,
      }
    })
    return [...fromBriefs, ...fromSessions]
      .filter(c => !Number.isNaN(new Date(c.at).getTime()) && c.at !== '')
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      .slice(0, 12)
  }, [briefs, sessions])

  // Advance the last-seen marker to the newest item once things settle, so the
  // next visit only dots what arrived after this one.
  useEffect(() => {
    if (!loaded || items.length === 0) return
    const times = items.map(c => new Date(c.at).getTime()).filter(n => Number.isFinite(n))
    if (times.length === 0) return
    const newest = Math.max(...times)
    if (newest > lastSeen) writeLastSeen(newest)
  }, [loaded, items, lastSeen])

  const newCount = useMemo(
    () => items.filter(c => new Date(c.at).getTime() > lastSeen).length,
    [items, lastSeen],
  )

  // kind is 'completions' in phase 1; keep the switch explicit for later streams.
  const label = kind === 'completions' ? 'Completions' : 'Feed'

  return (
    <section className="mb-6 hidden lg:block" style={{ animation: 'fadeSlideIn .55s ease both' }}>
      <div className="flex items-center gap-2 mb-3 px-0.5">
        <svg className="w-4 h-4 text-[var(--accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4" /><path strokeLinecap="round" strokeLinejoin="round" d="M12 22a10 10 0 100-20 10 10 0 000 20z" /></svg>
        <h2 className="text-[var(--text-primary)] text-sm font-semibold">{label}</h2>
        {loaded && newCount > 0 && (
          <span className="inline-flex items-center gap-1 text-[10.5px] font-medium px-2 py-0.5 rounded-full text-[var(--accent)]"
            style={{ background: 'color-mix(in oklab, var(--accent) 14%, transparent)' }}>
            {newCount} new
          </span>
        )}
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
          No completions yet — finished sessions and briefs you create in a session show up here as proof of work.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map(c => (
            <CompletionCard
              key={c.id}
              item={c}
              isNew={new Date(c.at).getTime() > lastSeen}
              onResume={onResume}
            />
          ))}
        </div>
      )}
    </section>
  )
}
