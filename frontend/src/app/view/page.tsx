'use client'

/**
 * Read-only room view (#383): watch a live session without joining or
 * controlling it. MODEL: the dashboard's header and cards (tokens, type) over
 * the /chat transcript (MessageBubble), with a Running card in the Vercel
 * deploy-log / Linear activity idiom. The page joins with the agent's hidden,
 * subscribe-only `viewer-*` token: it publishes nothing, sends no data and
 * subscribes to no audio. Running tasks come from the agent's status snapshot
 * (polled), the transcript and tool steps from the room's broadcast stream.
 */

import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { MessageBubble } from '@/components/voice/MessageBubble'
import { toolTarget, type ChatMessage } from '@/components/voice/shared'
import { agentReadUrl } from '@/lib/agent-read'
import { sessionMessagesQuery } from '@/lib/chat-url'
import { useDocumentTitle } from '@/lib/use-document-title'
import { applyViewEvent, busyLabel, historyMessages, runTime, viewStep, type RoomViewStatus, type ViewPhase } from '@/lib/room-view'

const POLL_MS = 5000

/** Agent route through the authenticated proxy (cloud) or straight to the local agent. */
function agentPath(path: string): string {
  let local = false
  let url: string | null = null
  try {
    local = localStorage.getItem('osborn-connection-mode') === 'local'
    url = localStorage.getItem('osborn-agent-url')
  } catch { /* storage blocked: cloud */ }
  return local ? agentReadUrl(url || 'http://localhost:8741', path) : `/api/agent/${path}`
}

async function readStatus(withToken: boolean): Promise<RoomViewStatus | null> {
  try {
    const r = await fetch(`${agentPath('view-token')}${withToken ? '' : '?status=1'}`, { cache: 'no-store', signal: AbortSignal.timeout(15000) })
    if (!r.ok) return null
    return (await r.json()) as RoomViewStatus
  } catch { return null }
}

function RoomView() {
  useDocumentTitle('Watching')
  const params = useSearchParams()
  const wanted = params.get('session')
  const cwd = params.get('workingDirectory')
  const [phase, setPhase] = useState<ViewPhase>('loading')
  const [status, setStatus] = useState<RoomViewStatus | null>(null)
  const [rows, setRows] = useState<ChatMessage[]>([])
  const [history, setHistory] = useState<ChatMessage[]>([])
  const [connected, setConnected] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const endRef = useRef<HTMLDivElement>(null)

  // Status poll (viewStep decides). The join reads the status once more with a token.
  useEffect(() => {
    let cancelled = false
    let room: { disconnect: () => Promise<void> | void } | null = null
    let joinedRoom: string | null = null
    let joining = false
    let seen = false
    const leave = () => { try { room?.disconnect() } catch { /* ignore */ } room = null; joinedRoom = null; setConnected(false) }

    const join = async () => {
      joining = true
      try {
        const s = await readStatus(true)
        if (cancelled || viewStep(s, { wanted, seen: true, joinedRoom: null }).phase !== 'watching' || !s?.token || !s.url || !s.room) return
        const lk = await import('livekit-client')
        if (cancelled) return
        const r = new lk.Room({ adaptiveStream: false, dynacast: false })
        r.on(lk.RoomEvent.DataReceived, (payload: Uint8Array, _p?: unknown, _k?: unknown, topic?: string) => {
          if (topic && topic !== 'osborn-updates') return
          try { setRows((prev) => applyViewEvent(prev, JSON.parse(new TextDecoder().decode(payload)))) } catch { /* not JSON */ }
        })
        r.on(lk.RoomEvent.Disconnected, () => { if (room === r) { room = null; joinedRoom = null } setConnected(false) })
        await r.connect(s.url, s.token, { autoSubscribe: false })
        if (cancelled) { r.disconnect(); return }
        room = r
        joinedRoom = s.room
        setConnected(true)
      } catch { setConnected(false) } finally { joining = false }
    }

    const tick = async () => {
      const s = await readStatus(false)
      if (cancelled) return
      const step = viewStep(s, { wanted, seen, joinedRoom })
      if (step.leave) leave()
      setPhase(step.phase)
      if (step.phase !== 'watching') {
        if (seen) setStatus((prev) => (prev ? { ...prev, tasks: [], busy: {} } : prev))
        return
      }
      seen = true
      setStatus(s)
      if (step.join && !joining) void join()
    }

    tick()
    const id = setInterval(tick, POLL_MS)
    return () => { cancelled = true; clearInterval(id); leave() }
  }, [wanted])

  // Recent history so the view does not start blank.
  useEffect(() => {
    const id = status?.sessionId
    if (!id || history.length) return
    fetch(`${agentPath('session-messages')}${sessionMessagesQuery(id, cwd, 30)}`, { signal: AbortSignal.timeout(10000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (Array.isArray(d?.messages)) setHistory(historyMessages(d.messages)) })
      .catch(() => {})
  }, [status?.sessionId, cwd, history.length])

  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id) }, [])
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [rows.length])

  const tasks = status?.tasks ?? []
  const busy = busyLabel(status?.busy)
  const live = phase === 'watching'
  // History can land after the first live turns; a stored turn already shown live is not repeated.
  const feed = useMemo(() => {
    const seenLive = new Set(rows.map((r) => `${r.role}:${r.content}`))
    return [...history.filter((h) => !seenLive.has(`${h.role}:${h.content}`)), ...rows]
  }, [history, rows])

  return (
    <main className="min-h-screen bg-[var(--background)] flex flex-col">
      <header className="sticky top-0 z-40 border-b border-[var(--border-subtle)] bg-background/80 backdrop-blur-md pt-[env(safe-area-inset-top)]">
        <div className="max-w-3xl mx-auto px-4 h-12 flex items-center gap-3">
          <Link href="/dashboard" className="-ml-1 flex items-center gap-1 rounded-lg px-1 py-1 text-[13px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">
            <svg aria-hidden="true" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
            <span className="hidden sm:inline">Dashboard</span>
          </Link>
          <h1 className="font-display text-[16px] font-semibold tracking-tight text-[var(--text-primary)]">Watching</h1>
          <div className="ml-auto flex items-center gap-2 min-w-0">
            {status?.phoneCall && live && (
              <span className="shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium text-[var(--text-secondary)] bg-[var(--surface-2)]">On a call</span>
            )}
            <span className="shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium text-[var(--text-secondary)] border border-[var(--border-subtle)]">Read-only</span>
            <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] text-[var(--text-secondary)]">
              <span className={`w-1.5 h-1.5 rounded-full ${live && connected ? 'bg-[var(--voice-speaking)]' : live ? 'bg-[var(--accent)] animate-pulse' : 'bg-[var(--text-muted)]'}`} aria-hidden="true" />
              {live ? (status?.since ? runTime(now - status.since) : 'Live') : phase === 'ended' ? 'Ended' : phase === 'lost' ? 'Offline' : '—'}
            </span>
          </div>
        </div>
      </header>

      <div className="flex-1 w-full max-w-3xl mx-auto px-4 py-5 flex flex-col gap-5">
        {phase === 'loading' && <p className="text-[13px] text-[var(--text-secondary)]">Looking for the live session…</p>}
        {phase === 'unreachable' && <Notice text="Could not reach your machine." />}
        {phase === 'not-live' && <Notice text="This session is not live right now. Open it from the dashboard to continue it." />}
        {phase === 'ended' && <Notice text="The session has ended or moved on. What it did is below." />}
        {phase === 'lost' && <Notice text="Lost contact with your machine. Trying again…" />}

        {(live || phase === 'ended' || phase === 'lost') && (
          <section aria-label="Running" className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] p-1.5">
            <h2 className="px-2.5 pt-2 pb-1 text-[10.5px] font-medium uppercase tracking-wider text-[var(--text-secondary)]">Running</h2>
            {busy && live && (
              <div className="flex items-center gap-2 px-2.5 py-2 text-[13px] text-[var(--text-primary)]">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--voice-thinking)] animate-pulse" aria-hidden="true" />
                {busy}
              </div>
            )}
            {tasks.length === 0 && !(busy && live) ? (
              <p className="px-2.5 py-2 text-[13px] text-[var(--text-secondary)]">Nothing running right now.</p>
            ) : (
              <ul className="space-y-px">
                {tasks.map((t) => (
                  <li key={t.taskId} className="flex min-h-[40px] items-center gap-2 sm:gap-3 rounded-lg px-2.5 py-2">
                    <span className="w-1.5 h-1.5 shrink-0 rounded-full bg-[var(--accent)] animate-pulse" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate text-[13.5px] text-text-primary/90">{t.description || t.subagentType || 'Background task'}</span>
                    {t.subagentType && <span className="hidden sm:inline shrink-0 rounded-full px-2 py-0.5 text-[10.5px] text-[var(--text-secondary)] bg-[var(--surface-2)]">{t.subagentType}</span>}
                    {t.startedAt ? <span className="shrink-0 min-w-14 text-right font-mono text-[10.5px] text-[var(--text-secondary)]">{runTime(now - t.startedAt)}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {(live || phase === 'ended' || phase === 'lost') && (
          <section aria-label="Activity" className="flex flex-col gap-1">
            <h2 className="px-0.5 pb-1 text-sm font-semibold text-[var(--text-primary)]">Activity</h2>
            {feed.length === 0 ? (
              <p className="px-0.5 text-[13px] text-[var(--text-secondary)]">Nothing yet. New messages and steps appear here as they happen.</p>
            ) : feed.map((m, i) => m.toolMeta ? (
              <div key={m.id} className="flex min-w-0 items-center gap-2 py-1 font-mono text-[11.5px] text-[var(--text-secondary)]">
                <span className={`w-1.5 h-1.5 shrink-0 rounded-full ${m.toolMeta.status === 'running' ? 'bg-[var(--accent)] animate-pulse' : 'bg-[var(--text-muted)]'}`} aria-hidden="true" />
                <span className="shrink-0 text-[var(--text-primary)]">{m.toolMeta.tool}</span>
                <span className="min-w-0 truncate">{toolTarget(m.toolMeta) || m.toolMeta.description}</span>
              </div>
            ) : (
              <MessageBubble key={m.id} message={m} grouped={i > 0 && feed[i - 1].role === m.role && !feed[i - 1].toolMeta} />
            ))}
            <div ref={endRef} />
          </section>
        )}
      </div>
    </main>
  )
}

function Notice({ text }: { text: string }) {
  return <p role="status" className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] px-3.5 py-3 text-[13px] text-[var(--text-secondary)]">{text}</p>
}

export default function ViewPage() {
  return (
    <Suspense fallback={<main className="min-h-screen bg-[var(--background)]" />}>
      <RoomView />
    </Suspense>
  )
}
