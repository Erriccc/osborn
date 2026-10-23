'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { createSupabaseBrowser } from '@/lib/supabase-browser'

/**
 * FastBrainChat — a lightweight "talk to this page" chat. Just a text bar and
 * streamed output: no voice, no session, no meeting. It POSTs to
 * /api/content/chat (Fireworks fast brain, grounded in this piece) and streams
 * the reply token-by-token. Signed-in only — anon visitors get a sign-in nudge.
 *
 * This is the on-page conversation: a reader lands from a shared link and can
 * ask questions about the piece right here. For actually REPRODUCING the work,
 * the page's "reproduce this" CTA drops them into a full Voice Native session.
 */

interface Msg { role: 'user' | 'assistant'; content: string }

export default function FastBrainChat({
  itemId,
  title,
  hook,
  body,
}: {
  itemId: string
  title: string | null
  hook: string | null
  body: string | null
}) {
  const [authState, setAuthState] = useState<'checking' | 'in' | 'out'>('checking')
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const trackedTalk = useRef(false)

  useEffect(() => {
    let active = true
    createSupabaseBrowser().auth.getSession()
      .then(({ data }) => { if (active) setAuthState(data.session ? 'in' : 'out') })
      .catch(() => { if (active) setAuthState('out') })
    return () => { active = false }
  }, [])

  // Keep the transcript pinned to the latest message as it streams.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])

  const send = async (e: FormEvent) => {
    e.preventDefault()
    const text = input.trim()
    if (!text || streaming) return

    // First message counts as a "talk" engagement event (best-effort).
    if (!trackedTalk.current) {
      trackedTalk.current = true
      try { createSupabaseBrowser().rpc('content_track', { p_item_id: itemId, p_event: 'talk' }).then(() => {}, () => {}) } catch {}
    }

    setError(null)
    setInput('')
    const next: Msg[] = [...messages, { role: 'user', content: text }]
    setMessages([...next, { role: 'assistant', content: '' }])
    setStreaming(true)

    try {
      const resp = await fetch('/api/content/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: next, context: { title, hook, body } }),
      })

      if (!resp.ok || !resp.body) {
        const j = await resp.json().catch(() => ({}))
        if (resp.status === 401) setAuthState('out')
        throw new Error(j?.error || `Chat failed (${resp.status})`)
      }

      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let acc = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        acc += decoder.decode(value, { stream: true })
        setMessages(prev => {
          const copy = prev.slice()
          copy[copy.length - 1] = { role: 'assistant', content: acc }
          return copy
        })
      }
      if (!acc.trim()) {
        setMessages(prev => prev.slice(0, -1))
        setError('No response — try again.')
      }
    } catch (err) {
      setMessages(prev => (prev[prev.length - 1]?.content ? prev : prev.slice(0, -1)))
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setStreaming(false)
    }
  }

  if (authState === 'out') {
    return (
      <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-6 text-center">
        <p className="text-[14px] text-[var(--text-primary)] font-medium">Talk to this page</p>
        <p className="mt-1 text-[13px] text-[var(--text-secondary)]">
          Sign in to ask questions about this piece and explore it in a quick chat.
        </p>
        <a href="/login"
          className="mt-4 inline-flex items-center gap-2 rounded-xl bg-[var(--accent)] text-[var(--background)] px-4 py-2.5 text-[13px] font-semibold hover:opacity-90 active:scale-[0.98] transition-all">
          Sign in to chat →
        </a>
      </div>
    )
  }

  return (
    <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] overflow-hidden flex flex-col">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border-subtle)]">
        <span className="w-6 h-6 rounded-full bg-[var(--accent-dim)]/20 flex items-center justify-center text-[var(--accent)]">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z" />
          </svg>
        </span>
        <div>
          <p className="text-[13px] font-semibold text-[var(--text-primary)] leading-none">Talk to this page</p>
          <p className="mt-1 text-[11px] text-[var(--text-muted)] leading-none">Quick chat, grounded in the piece above</p>
        </div>
      </div>

      {messages.length > 0 && (
        <div ref={scrollRef} className="max-h-80 overflow-y-auto px-4 py-4 space-y-3">
          {messages.map((m, i) => (
            <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
              <div className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-[13.5px] leading-relaxed whitespace-pre-wrap ${
                m.role === 'user'
                  ? 'bg-[var(--accent)] text-[var(--background)]'
                  : 'bg-[var(--surface-2)] text-[var(--text-secondary)]'
              }`}>
                {m.content || (streaming && i === messages.length - 1
                  ? <span className="inline-flex gap-1 items-center text-[var(--text-muted)]"><Dot /><Dot /><Dot /></span>
                  : '')}
              </div>
            </div>
          ))}
        </div>
      )}

      {error && <p className="px-4 pt-2 text-[12px] text-red-400">{error}</p>}

      <form onSubmit={send} className="flex items-end gap-2 p-3 border-t border-[var(--border-subtle)]">
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          disabled={streaming || authState === 'checking'}
          placeholder={authState === 'checking' ? 'Loading…' : 'Ask about this piece…'}
          className="flex-1 bg-[var(--background)] border border-[var(--border-subtle)] rounded-xl px-3.5 py-2.5 text-[13.5px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-dim)]/60 transition-colors disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={streaming || !input.trim() || authState === 'checking'}
          className="shrink-0 h-[42px] px-4 rounded-xl bg-[var(--accent)] text-[var(--background)] text-[13px] font-semibold hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-40"
        >
          {streaming ? '…' : 'Send'}
        </button>
      </form>
    </div>
  )
}

function Dot() {
  return <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" style={{ animationDuration: '1s' }} />
}
