'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * NotesRecorder — the dashboard's note CAPTURE control (record-only).
 * Founder consolidation (10-24): the saved-notes list was redundant with the
 * Recent Activity shelf — this section is now JUST the recorder. Record →
 * (pause/resume) → stop → transcribe → confirm (edit + ATTACH files via the
 * same /api/upload pipeline chat uses → stored URLs ride the note) → save →
 * the note lands in Recent Activity. Model: Apple Voice Memos record bar.
 */

type Phase = 'idle' | 'recording' | 'transcribing' | 'confirm'

export default function NotesCard() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<string[]>([])
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedFlash, setSavedFlash] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [paused, setPaused] = useState(false)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const cancelledRef = useRef(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onStart = () => { if (phase === 'idle') start() }
    window.addEventListener('vn:new-note', onStart)
    return () => window.removeEventListener('vn:new-note', onStart)
  }, [phase])

  const cleanup = () => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    recorderRef.current?.stream.getTracks().forEach(t => t.stop())
    recorderRef.current = null
  }

  const start = async () => {
    setError(null); setDraft(''); setAttachments([]); cancelledRef.current = false; setSavedFlash(false)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const rec = new MediaRecorder(stream)
      chunksRef.current = []
      rec.ondataavailable = e => { if (e.data.size) chunksRef.current.push(e.data) }
      rec.onstop = onStopped
      recorderRef.current = rec
      rec.start()
      setSeconds(0); setPaused(false)
      timerRef.current = setInterval(() => setSeconds(s => s + 1), 1000)
      setPhase('recording')
    } catch {
      setError('Microphone unavailable — check browser permissions.')
    }
  }

  const onStopped = async () => {
    cleanup(); setPaused(false)
    if (cancelledRef.current) { setPhase('idle'); return }
    setPhase('transcribing')
    try {
      const type = chunksRef.current[0]?.type || 'audio/webm'
      const blob = new Blob(chunksRef.current, { type })
      const res = await fetch('/api/notes/transcribe', {
        method: 'POST', headers: { 'Content-Type': blob.type || type }, body: blob,
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || 'Transcription failed')
      setDraft(j.text); setPhase('confirm')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Transcription failed'); setPhase('idle')
    }
  }

  const togglePause = () => {
    const rec = recorderRef.current
    if (!rec) return
    if (rec.state === 'recording') { rec.pause(); if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null } }
    else if (rec.state === 'paused') { rec.resume(); timerRef.current = setInterval(() => setSeconds(s => s + 1), 1000) }
    setPaused(rec.state !== 'recording')
  }

  const stop = (discard: boolean) => { cancelledRef.current = discard; recorderRef.current?.stop() }

  const attach = async (file: File) => {
    setUploading(true); setError(null)
    try {
      const fd = new FormData(); fd.append('file', file)
      const res = await fetch('/api/upload', { method: 'POST', body: fd })
      const j = await res.json().catch(() => ({}))
      const url = j.url || j.path || j.publicUrl
      if (!res.ok || !url) throw new Error(j?.error || 'Upload failed')
      setAttachments(prev => [...prev, url].slice(0, 5))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed')
    } finally { setUploading(false); if (fileRef.current) fileRef.current.value = '' }
  }

  const save = async () => {
    const text = draft.trim()
    if (!text) return
    setPhase('idle')
    try {
      const res = await fetch('/api/notes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, attachments }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || 'Could not save')
      setSavedFlash(true); setDraft(''); setAttachments([])
      setTimeout(() => setSavedFlash(false), 2500)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save')
    }
  }

  return (
    <section className="mb-6" style={{ animation: 'fadeSlideIn .45s ease both' }}>
      {phase === 'idle' && (
        <button onClick={start}
          className="w-full sm:w-auto min-h-[44px] px-5 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] flex items-center justify-center gap-2 text-[13.5px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--accent-dim)]/60 transition-all active:scale-[0.99]">
          <svg className="w-4 h-4 text-[var(--accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-14 0m7 7v3m0-3a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
          {savedFlash ? 'Saved — see Recent activity ✓' : 'Record a note'}
        </button>
      )}

      {phase === 'recording' && (
        <div className="flex items-center gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] p-2">
          <span className="relative flex items-center justify-center w-9 h-9 shrink-0 ml-1">
            <span className="absolute inset-0 rounded-full bg-red-500/20 animate-ping" />
            <span className="w-2.5 h-2.5 rounded-full bg-red-500" />
          </span>
          <span className="text-[13.5px] text-[var(--text-primary)] tabular-nums">
            {String(Math.floor(seconds / 60)).padStart(2, '0')}:{String(seconds % 60).padStart(2, '0')}
          </span>
          <button onClick={togglePause}
            className="min-h-[40px] px-3.5 rounded-lg border border-[var(--border-subtle)] text-[13px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button onClick={() => stop(true)}
            className="min-h-[40px] px-3.5 rounded-lg border border-[var(--border-subtle)] text-[13px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">
            Discard
          </button>
          <button onClick={() => stop(false)}
            className="ml-auto min-h-[40px] px-4 rounded-lg bg-[var(--accent)] text-[13px] font-semibold text-[var(--background)] hover:opacity-90 transition-opacity">
            Stop
          </button>
        </div>
      )}

      {phase === 'transcribing' && (
        <div className="flex items-center gap-2 min-h-[44px] px-1 text-[13px] text-[var(--text-secondary)]">
          <span className="w-4 h-4 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
          Transcribing…
        </div>
      )}

      {phase === 'confirm' && (
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] p-3">
          <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={3} autoFocus
            className="w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--background)] p-3 text-[13.5px] text-[var(--text-primary)] leading-relaxed focus:outline-none focus:border-[var(--accent)] resize-y" />
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {attachments.map(u => (
                <span key={u} className="inline-flex items-center gap-1.5 max-w-full rounded-full bg-[var(--surface-2)] px-2.5 py-1 text-[11px] text-[var(--text-secondary)]">
                  <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                  <span className="truncate">{u.split('/').pop()}</span>
                  <button onClick={() => setAttachments(p => p.filter(x => x !== u))} className="shrink-0 text-[var(--text-muted)] hover:text-red-400">✕</button>
                </span>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2 mt-2">
            <input ref={fileRef} type="file" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) attach(f) }} />
            <button onClick={() => fileRef.current?.click()} disabled={uploading || attachments.length >= 5}
              className="min-h-[40px] px-3.5 rounded-lg border border-[var(--border-subtle)] text-[13px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-50">
              {uploading ? 'Uploading…' : '📎 Attach'}
            </button>
            <button onClick={() => { setDraft(''); setAttachments([]); setPhase('idle') }}
              className="min-h-[40px] px-3.5 rounded-lg border border-[var(--border-subtle)] text-[13px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">
              Discard
            </button>
            <button onClick={save}
              className="ml-auto min-h-[40px] px-4 rounded-lg bg-[var(--accent)] text-[13px] font-semibold text-[var(--background)] hover:opacity-90 transition-opacity">
              Save note
            </button>
          </div>
        </div>
      )}

      {error && <p className="mt-2 text-[12.5px] text-red-400">{error}</p>}
    </section>
  )
}
