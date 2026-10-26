'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * UnifiedCreate — the dashboard's single CREATE control.
 * MODEL: Notion's "+ New ▾" — one compact primary action with a menu of
 * create targets (session / note / project). Replaces the old full-width
 * "New conversation" button (founder: "way too long… takes up space").
 * 'New note' dispatches `vn:new-note` (NotesCard listens and starts
 * recording); 'New project' opens the rail's naming input.
 */
export default function UnifiedCreate({
  onNewSession,
  onNewProject,
}: {
  onNewSession: () => void
  onNewProject: () => void
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const fire = (fn: () => void) => { setOpen(false); fn() }

  return (
    <div ref={wrapRef} className="relative mb-5 flex w-full sm:w-auto">
      <button
        onClick={() => fire(onNewSession)}
        className="flex-1 sm:flex-none min-h-[44px] px-5 rounded-lg font-semibold text-[14px] tracking-[-0.01em] transition-all duration-150 active:scale-[0.99] flex items-center justify-center gap-2"
        style={{ background: 'var(--accent)', color: 'var(--background)' }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
        New session
      </button>
      <button
        onClick={() => setOpen(v => !v)}
        aria-label="More create options"
        aria-haspopup="menu" aria-expanded={open}
        className="min-h-[44px] px-3 rounded-r-lg -ml-px font-semibold text-[13px] transition-colors border border-[var(--accent)]/40"
        style={{ background: 'color-mix(in oklab, var(--accent) 14%, var(--surface))', color: 'var(--accent)' }}>
        ▾
      </button>
      {open && (
        <div role="menu" className="absolute top-full left-0 mt-2 w-56 max-w-[calc(100vw-1.5rem)] rounded-xl bg-[var(--surface)] border border-[var(--border-subtle)] shadow-2xl overflow-hidden z-50 py-1">
          <button role="menuitem" onClick={() => fire(onNewSession)}
            className="w-full text-left px-4 min-h-[44px] flex items-center gap-3 text-[13.5px] text-[var(--text-secondary)] hover:bg-[var(--surface-2)]/50 hover:text-[var(--text-primary)] transition-colors">
            <SVG kind="session" /> New session
          </button>
          <button role="menuitem" onClick={() => fire(() => window.dispatchEvent(new CustomEvent('vn:new-note')))}
            className="w-full text-left px-4 min-h-[44px] flex items-center gap-3 text-[13.5px] text-[var(--text-secondary)] hover:bg-[var(--surface-2)]/50 hover:text-[var(--text-primary)] transition-colors">
            <SVG kind="note" /> New note
          </button>
          <button role="menuitem" onClick={() => fire(onNewProject)}
            className="w-full text-left px-4 min-h-[44px] flex items-center gap-3 text-[13.5px] text-[var(--text-secondary)] hover:bg-[var(--surface-2)]/50 hover:text-[var(--text-primary)] transition-colors">
            <SVG kind="project" /> New project
          </button>
        </div>
      )}
    </div>
  )
}

function SVG({ kind }: { kind: 'session' | 'note' | 'project' }) {
  const c = 'w-4 h-4 text-[var(--accent)] shrink-0'
  if (kind === 'session') return <svg className={c} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z" /></svg>
  if (kind === 'note') return <svg className={c} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-14 0m7 7v3m0-3a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
  return <svg className={c} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>
}
