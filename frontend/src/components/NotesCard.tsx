'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * NotesCard — quick voice NOTES on the dashboard. One prominent mic button:
 * tap → record → stop → transcribe (speech-to-text only, no model reply) →
 * the text lands in your notes (saved to the account, synced across devices).
 * Each note is copyable and deletable. Follows the existing card idiom.
 */

interface Note { id: string; text: string; created_at: string }

type Phase = 'idle' | 'recording' | 'transcribing' | 'confirm'

function fmtAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export default function NotesCard() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [draft, setDraft] = useState('')
  const [notes, setNotes] = useState<Note[]>([])
  const [error, setError] = useState<string | null>(null)
  const [seconds, setSeconds] = useState(0)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const cancelledRef = useRef(false)

  const loadNotes = useCallback(() => {
    fetch('/api/notes')
      .then(r => (r.ok ? r.json() : { notes: [] }))
      .then(j => setNotes(j.notes || []))
      .catch(() => {})
  }, [])
  useEffect(() => { loadNotes() }, [loadNotes])

  const cleanupRecording = () => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    recorderRef.current?.stream.getTracks().forEach(t => t.stop())
    recorderRef.current = null
  }

  const start = async () => {
    setError(null); setDraft(''); cancelledRef.current = false
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const rec = new MediaRecorder(stream)
      chunksRef.current = []
      rec.ondataavailable = e => { if (e.data.size) chunksRef.current.push(e.data) }
      rec.onstop = onStopped
      recorderRef.current = rec
      rec.start()
      setSeconds(0)
      timerRef.current = setInterval(() => setSeconds(s => s + 1), 1000)
      setPhase('recording')
    } catch {
      setError('Microphone unavailable — check browser permissions.')
      setPhase('idle')
    }
  }

  const onStopped = async () => {
    cleanupRecording()
    if (cancelledRef.current) { setPhase('idle'); return }
    setPhase('transcribing')
    try {
      const type = recorderRef.current?.mimeType || chunksRef.current[0]?.type || 'audio/webm'
      const blob = new Blob(chunksRef.current, { type })
      const res = await fetch('/api/notes/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': blob.type || type },
        body: blob,
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || 'Transcription failed')
      setDraft(j.text)
      setPhase('confirm')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Transcription failed')
      setPhase('idle')
    }
  }

  const stop = (discard = false) => {
    cancelledRef.current = discard
    recorderRef.current?.stop()
  }

  const save = async () => {
    const text = draft.trim()
    if (!text) return
    setPhase('idle')
    try {
      const res = await fetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || 'Could not save')
      setNotes(prev => [j.note, ...prev])
      setDraft('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save')
    }
  }

  const copy = (n: Note) => {
    navigator.clipboard.writeText(n.text).catch(() => {})
    setCopiedId(n.id)
    setTimeout(() => setCopiedId(null), 1500)
  }

  const remove = async (id: string) => {
    setNotes(prev => prev.filter(n => n.id !== id))
    fetch(`/api/notes?id=${id}`, { method: 'DELETE' }).catch(() => loadNotes())
  }

  return (
    <section className="mb-6 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] p-4" style={{ animation: 'fadeSlideIn .5s ease both' }}>
      <div className="flex items-center gap-2 mb-3">
        <svg className="w-4 h-4 text-[var(--accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
        <h2 className="text-[var(--text-primary)] text-sm font-semibold">Notes</h2>
        <span className="text-[11px] text-[var(--text-muted)]">Speak → text, saved to your account</span>
      </div>

      {/* Record control — one clear primary action (3-6-9 rule) */}
      {phase === 'idle' && (
        <button onClick={start}
          className="w-full min-h-[44px] rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-2)] flex items-center justify-center gap-2 text-[13.5px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--accent-dim)]/50 transition-all active:scale-[0.99]">
          <svg className="w-4 h-4 text-[var(--accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-14 0m7 7v3m0-3a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
          Record a note
        </button>
      )}

      {phase === 'recording' && (
        <div className="flex items-center gap-3">
          <span className="relative flex items-center justify-center w-10 h-10 shrink-0">
            <span className="absolute inset-0 rounded-full bg-red-500/20 animate-ping" />
            <span className="w-3 h-3 rounded-full bg-red-500" />
          </span>
          <span className="text-[13.5px] text-[var(--text-primary)] tabular-nums">
            {String(Math.floor(seconds / 60)).padStart(2, '0')}:{String(seconds % 60).padStart(2, '0')}
          </span>
          <button onClick={() => stop(true)}
            className="ml-auto min-h-[44px] px-4 rounded-lg border border-[var(--border-subtle)] text-[13px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">
            Discard
          </button>
          <button onClick={() => stop(false)}
            className="min-h-[44px] px-4 rounded-lg bg-[var(--accent)] text-[13px] font-semibold text-[var(--background)] hover:opacity-90 transition-opacity">
            Stop
          </button>
        </div>
      )}

      {phase === 'transcribing' && (
        <div className="flex items-center gap-2 min-h-[44px] text-[13px] text-[var(--text-secondary)]">
          <span className="w-4 h-4 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
          Transcribing…
        </div>
      )}

      {phase === 'confirm' && (
        <div>
          <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={3} autoFocus
            className="w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--background)] p-3 text-[13.5px] text-[var(--text-primary)] leading-relaxed focus:outline-none focus:border-[var(--accent)] resize-y" />
          <div className="flex gap-2 mt-2">
            <button onClick={save}
              className="min-h-[44px] px-4 rounded-lg bg-[var(--accent)] text-[13px] font-semibold text-[var(--background)] hover:opacity-90 transition-opacity">
              Save note
            </button>
            <button onClick={() => { setDraft(''); setPhase('idle') }}
              className="min-h-[44px] px-4 rounded-lg border border-[var(--border-subtle)] text-[13px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">
              Discard
            </button>
          </div>
        </div>
      )}

      {error && <p className="mt-2 text-[12.5px] text-red-400">{error}</p>}

      {/* Saved notes — newest first, copy + delete per note */}
      {notes.length > 0 && (
        <ul className={phase === 'idle' ? 'mt-3 space-y-1.5' : 'hidden'}>
          {notes.slice(0, 5).map(n => (
            <li key={n.id} className="group flex items-start gap-2 rounded-lg px-2 py-2 -mx-2 hover:bg-[var(--surface-2)]/40 transition-colors">
              <p className="flex-1 min-w-0 text-[13px] text-[var(--text-secondary)] leading-relaxed line-clamp-2 whitespace-pre-wrap">{n.text}</p>
              <span className="shrink-0 text-[10.5px] text-[var(--text-muted)] mt-0.5">{fmtAgo(n.created_at)}</span>
              <button onClick={() => copy(n)} title="Copy"
                className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--surface-2)] transition-colors">
                {copiedId === n.id ? (
                  <svg className="w-3.5 h-3.5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                ) : (
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                )}
              </button>
              <button onClick={() => remove(n.id)} title="Delete"
                className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-[var(--text-muted)] hover:text-red-400 hover:bg-[var(--surface-2)] transition-colors">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
