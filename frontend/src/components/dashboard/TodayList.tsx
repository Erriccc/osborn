'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import LoadingLine from './LoadingLine'
import NoteSheet from './NoteSheet'
import { createSupabaseBrowser } from '@/lib/supabase-browser'
import { sessionMatchesQuery, type SessionListItem } from '@/lib/session-list'
import { groupByDay, timeUnderDay } from '@/lib/outputs-model'
import { buildTodayRows, type TodayBrief, type TodayKind, type TodayNote, type TodayRow } from '@/lib/today'

/**
 * Recent: the dashboard's one list (rows from lib/today.ts). MODEL: Things 3
 * "Today" and Linear "My Issues". Session rows resume, note rows open a
 * NoteSheet, brief rows open the brief. Each row is a single control; the
 * session live on the machine also gets View beside it (read-only, #383).
 */

type Filter = 'all' | TodayKind
const SHOWN = 8

// Per-viewer "new since last visit" marker; storage failures mean "nothing seen yet".
const SEEN_KEY = 'vn:feed:completions:lastSeen'
function readLastSeen(): number {
  try { const n = Number(localStorage.getItem(SEEN_KEY) || 0); return Number.isFinite(n) ? n : 0 } catch { return 0 }
}
function writeLastSeen(ms: number): void {
  try { localStorage.setItem(SEEN_KEY, String(ms)) } catch { /* ignore */ }
}

const ICON: Record<TodayKind, string> = {
  session: 'M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z',
  note: 'M19 11a7 7 0 01-14 0m7 7v3m0-3a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z',
  brief: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
}

export default function TodayList({
  sessions,
  sessionsLoading,
  onResume,
  liveSessionId,
}: {
  /** Deduped (prepareSessions), so each session is one row. */
  sessions: SessionListItem[]
  sessionsLoading?: boolean
  onResume: (sessionId: string, cwd?: string) => void
  /** The session live on the machine right now: its row gets View (read-only room view, #383). */
  liveSessionId?: string | null
}) {
  const [notes, setNotes] = useState<TodayNote[]>([])
  const [briefs, setBriefs] = useState<TodayBrief[]>([])
  const [briefsLoaded, setBriefsLoaded] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [all, setAll] = useState(false)
  const [openNote, setOpenNote] = useState<TodayNote | null>(null)
  const [lastSeen] = useState<number>(() => readLastSeen())

  useEffect(() => {
    const load = () => fetch('/api/notes')
      .then(r => (r.ok ? r.json() : { notes: [] }))
      .then(j => setNotes(j.notes || []))
      .catch(() => {})
    load()
    const onNewNote = () => setTimeout(load, 1500)
    const onSaved = () => load()
    window.addEventListener('vn:new-note', onNewNote)
    window.addEventListener('vn:note-saved', onSaved)
    return () => { window.removeEventListener('vn:new-note', onNewNote); window.removeEventListener('vn:note-saved', onSaved) }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const sb = createSupabaseBrowser()
        const { data: u } = await sb.auth.getUser()
        if (!u.user || cancelled) return
        const { data } = await sb.from('content_items').select('id, type, title, created_at')
          .order('created_at', { ascending: false }).limit(12)
        if (!cancelled) setBriefs((data ?? []) as TodayBrief[])
      } catch { /* quiet surface */ }
      finally { if (!cancelled) setBriefsLoaded(true) }
    })()
    return () => { cancelled = true }
  }, [])

  const rows = useMemo(() => buildTodayRows(sessions, notes, briefs), [sessions, notes, briefs])
  const sessionById = useMemo(() => new Map(sessions.map(s => [s.sessionId, s])), [sessions])
  const continueKey = rows.find(r => r.kind === 'session')?.key

  // Advance the last-seen marker once everything is in, so the next visit only dots what is newer.
  useEffect(() => {
    if (sessionsLoading || !briefsLoaded || rows.length === 0) return
    const newest = Math.max(...rows.map(r => new Date(r.at).getTime()).filter(Number.isFinite))
    if (newest > lastSeen) writeLastSeen(newest)
  }, [sessionsLoading, briefsLoaded, rows, lastSeen])

  const q = query.trim().toLowerCase()
  const hit = (r: TodayRow) => r.kind === 'session'
    ? sessionMatchesQuery(sessionById.get(r.id)!, q)
    : `${r.title} ${r.label ?? ''}`.toLowerCase().includes(q)
  const matches = rows.filter(r => (filter === 'all' || r.kind === filter) && (!q || hit(r)))
  // The Continue row stays visible even when newer notes or briefs push it past the cap.
  const capped = matches.slice(0, SHOWN)
  const pinned = matches.find(r => r.key === continueKey)
  const shown = q || all ? matches : pinned && !capped.includes(pinned) ? [...capped.slice(0, SHOWN - 1), pinned] : capped
  const count = (k: TodayKind) => rows.filter(r => r.kind === k).length
  const chips: { k: Filter; label: string; n: number | string }[] = [
    { k: 'all', label: 'All', n: sessionsLoading ? '…' : rows.length },
    { k: 'session', label: 'Sessions', n: sessionsLoading ? '…' : count('session') },
    { k: 'note', label: 'Notes', n: count('note') },
    ...(count('brief') ? [{ k: 'brief' as const, label: 'Briefs', n: count('brief') }] : []),
  ]
  const waiting = (filter === 'all' || filter === 'session') && sessionsLoading

  const open = (r: TodayRow) => {
    if (r.kind === 'session') onResume(r.id, r.cwd)
    else if (r.kind === 'note') { const n = notes.find(x => x.id === r.id); if (n) setOpenNote(n) }
  }

  const row = (r: TodayRow) => {
    const inner = (
      <>
        <span className="sr-only">{r.kind === 'session' ? 'Resume session:' : r.kind === 'note' ? 'Open note:' : 'Open brief:'}</span>
        <svg aria-hidden="true" className={`w-4 h-4 shrink-0 ${r.kind === 'note' ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d={ICON[r.kind]} /></svg>
        <span className="min-w-0 flex-1 truncate text-[13.5px] text-text-primary/90 group-hover:text-[var(--text-primary)]">{r.title}</span>
        {r.key === continueKey && <span className="shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-semibold text-[var(--accent)] bg-accent-dim/20">Continue</span>}
        {r.label && <span className="hidden sm:inline shrink-0 rounded-full px-2 py-0.5 text-[10.5px] text-[var(--text-secondary)] bg-[var(--surface-2)]">{r.label}</span>}
        {r.kind === 'note' && r.attachments?.length ? <span className="shrink-0 text-[11px] text-[var(--text-muted)]">{r.attachments.length} file{r.attachments.length > 1 ? 's' : ''}</span> : null}
        {new Date(r.at).getTime() > lastSeen && lastSeen > 0 && <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-[var(--accent)]"><span className="sr-only">New since your last visit</span></span>}
        {r.at && <span className="shrink-0 min-w-14 text-right font-mono text-[10.5px] text-[var(--text-secondary)]">{timeUnderDay(r.at)}</span>}
      </>
    )
    const cls = 'group flex w-full min-h-[40px] items-center gap-2 sm:gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-surface-2/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]'
    const live = r.kind === 'session' && !!liveSessionId && r.id === liveSessionId
    const viewHref = `/view?${new URLSearchParams({ session: r.id, ...(r.cwd ? { workingDirectory: r.cwd } : {}) })}`
    return (
      <li key={r.key} className={live ? 'flex items-center gap-1' : undefined}>
        {r.kind === 'brief'
          ? <Link href={`/library/${r.id}`} className={cls} title={r.title}>{inner}</Link>
          : <button type="button" onClick={() => open(r)} title={r.title} className={live ? `${cls} min-w-0 flex-1` : cls}>{inner}</button>}
        {live && (
          <Link href={viewHref} title="Watch this live session without joining it" aria-label={`View live session: ${r.title}`}
            className="shrink-0 flex min-h-[40px] items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-surface-2/60 hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--voice-speaking)]" aria-hidden="true" />
            View
          </Link>
        )}
      </li>
    )
  }

  return (
    <section aria-label="Recent" className="mb-6" style={{ animation: 'fadeSlideIn .5s ease both' }}>
      <div className="flex flex-wrap items-center gap-2 mb-2 px-0.5">
        <h2 className="text-[var(--text-primary)] text-sm font-semibold">Recent</h2>
        <div className="flex flex-wrap gap-1.5 ml-auto">
          {chips.map(c => (
            <button key={c.k} type="button" onClick={() => setFilter(c.k)} aria-pressed={filter === c.k}
              className={'min-h-[32px] px-3 rounded-full text-[12px] font-medium transition-colors ' +
                (filter === c.k
                  ? 'bg-[var(--accent)] text-[var(--background)]'
                  : 'text-[var(--text-secondary)] bg-[var(--surface)] border border-[var(--border-subtle)] hover:text-[var(--text-primary)]')}>
              {c.label} <span className={'text-[10px] ' + (filter === c.k ? 'opacity-80' : 'opacity-60')}>{c.n}</span>
            </button>
          ))}
        </div>
      </div>

      {rows.length > SHOWN && (
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search" aria-label="Search sessions, notes and briefs"
          className="mb-1.5 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface)] px-3 py-1.5 text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-[var(--accent-dim)]" />
      )}

      {shown.length === 0 && waiting ? (
        <LoadingLine />
      ) : shown.length === 0 ? (
        <p className="text-[13px] text-[var(--text-secondary)] py-3 px-0.5">
          {q ? `Nothing matches “${query.trim()}”.` : 'Nothing yet — start a session or record a note.'}
        </p>
      ) : (
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] p-1.5">
          {groupByDay(shown, r => r.at).map(g => (
            <div key={g.label}>
              <h3 className="px-2.5 pt-2 pb-1 text-[10.5px] font-medium uppercase tracking-wider text-[var(--text-secondary)]">{g.label}</h3>
              <ul className="space-y-px">{g.items.map(row)}</ul>
            </div>
          ))}
        </div>
      )}
      {!q && matches.length > SHOWN && (
        <button type="button" onClick={() => setAll(v => !v)} className="mt-1.5 px-2.5 text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--accent)]">
          {all ? 'Show fewer' : `Show all ${matches.length}`}
        </button>
      )}

      <NoteSheet
        note={openNote}
        onClose={() => setOpenNote(null)}
        onDeleted={id => { setNotes(ns => ns.filter(n => n.id !== id)); setOpenNote(null) }}
      />
    </section>
  )
}
