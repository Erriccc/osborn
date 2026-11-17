'use client'

// Recents: the dashboard's conversation list, modelled on the left sidebar of
// Claude's app (docs/design-direction.md): a quiet section label, a search when
// the list is long, and one plain row per session (title, time), newest first.
// Dashboard tokens only; it sits above Projects in the left column.

import { useMemo, useState } from 'react'
import { sessionDisplayTitle, sessionActivityTime } from '@/lib/sessions'
import { sessionMatchesQuery, type SessionListItem } from '@/lib/session-list'

const SHOWN = 8

export default function RecentsList<T extends SessionListItem>({ sessions, onOpen, formatDate }: {
  /** Already prepared and sorted newest first (prepareSessions). */
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
          return (
            <li key={s.sessionId}>
              <button
                onClick={() => onOpen(s)}
                title={sessionDisplayTitle(s)}
                className="group flex w-full items-baseline gap-3 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--surface-2)]/60"
              >
                <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]">{sessionDisplayTitle(s)}</span>
                {t && <span className="shrink-0 font-mono text-[10.5px] text-[var(--text-muted)]">{formatDate(t)}</span>}
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
