'use client'

import { useEffect, useState } from 'react'

/**
 * ActivityShelf (exported as ActivityFeed) — NOTES + SESSIONS as one shelf.
 * MODELS: shelf anatomy from Spotify Home ("Made For You" row — a short
 * section whose cards scroll horizontally with snap, so the page stops
 * growing downward); filtering from WhatsApp's DM chips (All / Unread /
 * Favorites) — here All / Notes / Sessions over one merged stream.
 * Session cards tap-to-resume; note cards are static previews.
 */

interface FeedNote { id: string; text: string; created_at: string; attachments?: string[] }
interface FeedSession { sessionId: string; timestamp: string; lastMessage?: string; cwd?: string }
type Filter = 'all' | 'note' | 'session'

function ago(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export default function ActivityFeed({
  sessions,
  onResume,
}: {
  sessions: FeedSession[]
  onResume: (sessionId: string, cwd?: string) => void
}) {
  const [notes, setNotes] = useState<FeedNote[]>([])
  const [filter, setFilter] = useState<Filter>('note') // founder: default to Notes

  useEffect(() => {
    const load = () => fetch('/api/notes')
      .then(r => (r.ok ? r.json() : { notes: [] }))
      .then(j => setNotes(j.notes || []))
      .catch(() => {})
    load()
    const onNewNote = () => setTimeout(load, 1500)
    const onSaved = () => load() // note saved → refresh immediately, no page reload
    window.addEventListener('vn:new-note', onNewNote)
    window.addEventListener('vn:note-saved', onSaved)
    return () => { window.removeEventListener('vn:new-note', onNewNote); window.removeEventListener('vn:note-saved', onSaved) }
  }, [])

  const rows = [
    ...notes.map(n => ({ kind: 'note' as const, at: n.created_at, text: n.text, id: n.id })),
    ...sessions.map(s => ({ kind: 'session' as const, at: s.timestamp, text: s.lastMessage || 'Session', id: s.sessionId, cwd: s.cwd })),
  ]
    .filter(r => filter === 'all' || r.kind === filter)
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, 12)

  const CHIPS: { k: Filter; label: string; count: number }[] = [
    { k: 'all', label: 'All', count: notes.length + sessions.length },
    { k: 'note', label: 'Notes', count: notes.length },
    { k: 'session', label: 'Sessions', count: sessions.length },
  ]

  return (
    <section className="mb-6" style={{ animation: 'fadeSlideIn .5s ease both' }}>
      <div className="flex items-center gap-2 mb-2.5 px-0.5">
        <h2 className="text-[var(--text-primary)] text-sm font-semibold">Recent activity</h2>
        {/* WhatsApp-style filter chips */}
        <div className="flex gap-1.5 ml-auto">
          {CHIPS.map(c => (
            <button key={c.k} onClick={() => setFilter(c.k)}
              aria-pressed={filter === c.k}
              className={'min-h-[32px] px-3 rounded-full text-[12px] font-medium transition-colors ' +
                (filter === c.k
                  ? 'bg-[var(--accent)] text-[var(--background)]'
                  : 'text-[var(--text-secondary)] bg-[var(--surface)] border border-[var(--border-subtle)] hover:text-[var(--text-primary)]')}>
              {c.label}{' '}
              <span className={'text-[10px] ' + (filter === c.k ? 'opacity-80' : 'opacity-60')}>{c.count}</span>
            </button>
          ))}
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="text-[13px] text-[var(--text-muted)] py-3 px-0.5">Nothing here yet — record a note or start a session.</p>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-2 snap-x snap-mandatory"
          style={{ scrollbarWidth: 'thin' }}>
          {rows.map(r => (
            <button key={r.kind + r.id}
              onClick={() => r.kind === 'session' && onResume(r.id, r.cwd)}
              className="snap-start shrink-0 w-[240px] sm:w-[260px] text-left rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] p-3.5 hover:border-[var(--accent-dim)]/50 transition-colors group">
              <div className="flex items-center gap-2 mb-2">
                <span className="w-6 h-6 rounded-lg flex items-center justify-center shrink-0"
                  style={{ background: r.kind === 'note' ? 'color-mix(in oklab, var(--accent) 14%, transparent)' : 'var(--surface-2)' }}>
                  {r.kind === 'note' ? (
                    <svg className="w-3.5 h-3.5 text-[var(--accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-14 0m7 7v3m0-3a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
                  ) : (
                    <svg className="w-3.5 h-3.5 text-[var(--text-secondary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z" /></svg>
                  )}
                </span>
                <span className="text-[10.5px] uppercase tracking-wide text-[var(--text-muted)] font-medium">
                  {r.kind === 'note' ? 'Note' : 'Session'}
                </span>
                <span className="ml-auto text-[10.5px] text-[var(--text-muted)]">{ago(r.at)}</span>
              </div>
              <p className="text-[13px] text-[var(--text-secondary)] leading-snug line-clamp-3 group-hover:text-[var(--text-primary)] transition-colors">
                {r.text}
              </p>
              <span className="flex items-center gap-2 mt-2.5">
                {r.kind === 'note' && (r as { attachments?: string[] }).attachments?.length ? (
                  <span className="inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)]">
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                    {(r as { attachments?: string[] }).attachments!.length}
                  </span>
                ) : null}
                {r.kind === 'note' && (
                  <button
                    onClick={e => {
                      e.stopPropagation()
                      const atts = (r as { attachments?: string[] }).attachments || []
                      navigator.clipboard.writeText(atts.length ? `${r.text}\n${atts.join('\n')}` : r.text).catch(() => {})
                    }}
                    className="text-[11px] font-medium text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors">
                    Copy note
                  </button>
                )}
              </span>
              {r.kind === 'session' && (
                <span className="inline-flex items-center gap-1 mt-2.5 text-[11px] font-medium text-[var(--accent)]">
                  Resume
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </section>
  )
}
