'use client'

import Link from 'next/link'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * CompletionCard — a single passive "completion with proof" card in the
 * dashboard COMPLETIONS stream (dashboard-as-feed, phase 1). It never barges
 * in: no toast, no modal, no auto-focus — it just sits in the vertical feed.
 * Two sources render through the same card:
 *   - `brief`   — a `content_items` row: type pill + title + hook + collapsed
 *                 markdown proof + "Open in library" link.
 *   - `session` — a finished session: kind pill + cleaned title + "Resume" link.
 * Card markup is lifted from LibraryBriefs.tsx so the feed matches the existing
 * dark theme exactly.
 */

export interface Completion {
  /** Stable, source-prefixed id (`brief:<id>` / `session:<id>`). */
  id: string
  kind: 'brief' | 'session'
  /** ISO time used for recency sort + the "new since last visit" dot. */
  at: string
  title: string
  /** Pill label — brief content type (raw) or session kind (Chat/Meeting/Task). */
  typeLabel?: string | null
  // brief-only
  status?: string | null
  hook?: string | null
  body?: string | null
  // session-only
  sessionId?: string
  cwd?: string
}

const TYPE_LABEL: Record<string, string> = {
  blog: 'Blog', x_thread: 'X thread', linkedin: 'LinkedIn', short: 'Short script',
  newsletter: 'Newsletter', note: 'Note', source: 'Session brief', text_post: 'Post',
}

// Render at most this much of the body in the feed preview — it's clamped
// visually too, but slicing keeps a 50KB brief from mounting in full.
const PREVIEW_CHARS = 1200

function ago(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export default function CompletionCard({
  item,
  isNew,
  onResume,
}: {
  item: Completion
  isNew?: boolean
  onResume?: (sessionId: string, cwd?: string) => void
}) {
  const published = item.status === 'published'
  const body = (item.body || '').replace(/<!--[\s\S]*?-->/g, '').trim()
  const preview = body.slice(0, PREVIEW_CHARS)
  const pillLabel = item.kind === 'brief'
    ? (item.typeLabel ? (TYPE_LABEL[item.typeLabel] || item.typeLabel) : 'Brief')
    : (item.typeLabel || 'Session')

  const resume = () => { if (item.sessionId && onResume) onResume(item.sessionId, item.cwd) }

  return (
    <article className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-5 hover:border-[var(--accent-dim)]/40 transition-colors">
      <header className="flex items-center gap-2 mb-1.5">
        <span className="text-[10.5px] font-medium px-2 py-0.5 rounded-full shrink-0"
          style={{
            background: published ? 'color-mix(in oklab, #22c55e 14%, transparent)' : 'var(--surface-2)',
            color: published ? '#4ade80' : 'var(--text-muted)',
          }}>
          {pillLabel}
        </span>
        {published && (
          <span className="inline-flex items-center gap-1 text-[10.5px] text-emerald-400/90">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> Public
          </span>
        )}
        {isNew && (
          <span className="inline-flex items-center gap-1 text-[10.5px] text-[var(--accent)]" title="New since your last visit">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)]" /> New
          </span>
        )}
        <time className="ml-auto text-[11px] text-[var(--text-muted)]">{ago(item.at)}</time>
      </header>

      {item.kind === 'brief' ? (
        <Link href="/library" className="block group">
          <h3 className="font-display text-[16px] font-medium text-[var(--text-primary)] leading-snug group-hover:text-[var(--accent)] transition-colors">
            {item.title}
          </h3>
        </Link>
      ) : (
        <button type="button" onClick={resume} className="block w-full text-left group">
          <h3 className="font-display text-[16px] font-medium text-[var(--text-primary)] leading-snug group-hover:text-[var(--accent)] transition-colors">
            {item.title}
          </h3>
        </button>
      )}

      {item.hook && (
        <p className="text-[13px] text-[var(--text-secondary)] italic leading-relaxed mt-1">{item.hook}</p>
      )}

      {item.kind === 'brief' && preview && (
        <div className="relative mt-3 max-h-[220px] overflow-hidden">
          <div className="prose-osborn text-[12.5px] leading-relaxed">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{preview}</ReactMarkdown>
          </div>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-[var(--surface)] to-transparent" />
        </div>
      )}

      <div className="mt-3">
        {item.kind === 'brief' ? (
          <Link href="/library" className="text-[12px] font-medium text-[var(--accent)] hover:opacity-80 transition-opacity">
            Open in library →
          </Link>
        ) : (
          <button type="button" onClick={resume}
            className="inline-flex items-center gap-1 text-[12px] font-medium text-[var(--accent)] hover:opacity-80 transition-opacity">
            Resume session
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
          </button>
        )}
      </div>
    </article>
  )
}
