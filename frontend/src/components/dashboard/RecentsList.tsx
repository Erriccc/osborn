'use client'

// Recents: newest-first session list for the dashboard's left column, modelled on Claude's app sidebar.

import { useMemo, useState } from 'react'
import { prettySessionPreview, sessionActivityTime } from '@/lib/sessions'
import { sessionMatchesQuery, type SessionListItem } from '@/lib/session-list'

const SHOWN = 8

export default function RecentsList<T extends SessionListItem>({ sessions, onOpen, formatDate }: {
  /** Already prepared (prepareSessions) and sorted newest first (sortSessionsByActivity). */
  sessions: T[]
  onOpen: (s: T) => void
  formatDate: (iso: string) => string
}) {
  const [query, setQuery] = useState('')
  const [all, setAll] = useState(false)
  const q = query.trim()
  const matches = useMemo(() => (q ? sessions.filter((s) => sessionMatchesQuery(s, q)) : sessions), [sessions, q])
  const rows = q || all ? matches : matches.slice(0, SHOWN)

  return (
    <section aria-label="Recents" className="mb-5">
      <h2 className="mb-2 px-1 text-xs font-medium uppercase tracking-wider text-[var(--text-secondary)]">Recents</h2>
      {sessions.length > SHOWN && (
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search sessions"
          aria-label="Search sessions"
          className="mb-1.5 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface)] px-3 py-1.5 text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-[var(--accent-dim)]"
        />
      )}
      <ul className="space-y-px">
        {rows.map((s) => {
          const t = sessionActivityTime(s)
          const title = prettySessionPreview(s).text
          return (
            <li key={s.sessionId}>
              <button
                onClick={() => onOpen(s)}
                title={title}
                className="group flex w-full items-baseline gap-3 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--surface-2)]/60"
              >
                <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--text-primary)]/85 group-hover:text-[var(--text-primary)]">{title}</span>
                {t && <span className="shrink-0 font-mono text-[10.5px] text-[var(--text-secondary)]">{formatDate(t)}</span>}
              </button>
            </li>
          )
        })}
      </ul>
      {q && matches.length === 0 && <p className="px-2.5 py-1.5 text-xs text-[var(--text-muted)]">No sessions match “{q}”.</p>}
      {!q && matches.length > SHOWN && (
        <button onClick={() => setAll((v) => !v)} className="mt-1 px-2.5 text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--accent)]">
          {all ? 'Show fewer' : `Show all ${matches.length}`}
        </button>
      )}
    </section>
  )
}
