'use client'

import { useEffect, useState } from 'react'

/**
 * ActivityFeed — NOTES + PREVIOUS SESSIONS as one chronological surface.
 * MODELS: row anatomy from Apple Voice Memos (icon · 2-line clamped preview ·
 * relative time); height discipline per the founder's viewport rule — the
 * module is capped at 38dvh with internal scroll so it can never push the
 * rest of the dashboard below the fold (the failure mode of the old
 * unbounded notes wall).
 */

interface FeedNote { id: string; text: string; created_at: string }
interface FeedSession { sessionId: string; timestamp: string; lastMessage?: string; cwd?: string }

type Row =
  | { kind: 'note'; at: string; text: string; id: string }
  | { kind: 'session'; at: string; text: string; id: string; cwd?: string }

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

  useEffect(() => {
    fetch('/api/notes')
      .then(r => (r.ok ? r.json() : { notes: [] }))
      .then(j => setNotes(j.notes || []))
      .catch(() => {})
    const onNewNote = () => {
      // A note was just saved via UnifiedCreate → NotesCard — refresh soon.
      setTimeout(() => fetch('/api/notes').then(r => r.ok ? r.json() : { notes: [] }).then(j => setNotes(j.notes || [])).catch(() => {}), 1500)
    }
    window.addEventListener('vn:new-note', onNewNote)
    return () => window.removeEventListener('vn:new-note', onNewNote)
  }, [])

  const rows: Row[] = [
    ...notes.map(n => ({ kind: 'note' as const, at: n.created_at, text: n.text, id: n.id })),
    ...sessions.map(s => ({ kind: 'session' as const, at: s.timestamp, text: s.lastMessage || 'Session', id: s.sessionId, cwd: s.cwd })),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())

  return (
    <section className="mb-6 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] p-4" style={{ animation: 'fadeSlideIn .5s ease both' }}>
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-[var(--text-primary)] text-sm font-semibold">Recent activity</h2>
        <span className="text-[11px] text-[var(--text-muted)]">notes &amp; sessions</span>
      </div>
      {rows.length === 0 ? (
        <p className="text-[13px] text-[var(--text-muted)] py-2">Nothing yet — record a note or start a session.</p>
      ) : (
        <ul className="max-h-[38dvh] overflow-y-auto -mx-2 px-2 divide-y divide-[var(--border-subtle)]/60">
          {rows.slice(0, 30).map(r => (
            <li key={r.kind + r.id}>
              <button
                onClick={() => r.kind === 'session' && onResume(r.id, r.cwd)}
                className="w-full text-left py-2.5 flex items-start gap-3 group"
                title={r.kind === 'session' ? 'Resume session' : undefined}
              >
                <span className="shrink-0 mt-0.5 w-7 h-7 rounded-lg flex items-center justify-center"
                  style={{ background: r.kind === 'note' ? 'color-mix(in oklab, var(--accent) 14%, transparent)' : 'var(--surface-2)' }}>
                  {r.kind === 'note' ? (
                    <svg className="w-3.5 h-3.5 text-[var(--accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-14 0m7 7v3m0-3a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
                  ) : (
                    <svg className="w-3.5 h-3.5 text-[var(--text-secondary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z" /></svg>
                  )}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[13px] text-[var(--text-secondary)] leading-snug line-clamp-2 group-hover:text-[var(--text-primary)] transition-colors">{r.text}</span>
                  <span className="block mt-0.5 text-[10.5px] text-[var(--text-muted)]">
                    {r.kind === 'note' ? 'Note' : 'Session'} · {ago(r.at)}
                  </span>
                </span>
                {r.kind === 'session' && (
                  <svg className="w-4 h-4 shrink-0 mt-1 text-[var(--text-muted)] group-hover:text-[var(--accent)] transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
