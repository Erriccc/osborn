'use client'

import type { ApprovalMode } from './PermissionModal'

// The session's approval mode: the one visible control that replaced the hidden
// auto-approve toggles. NOT persisted: it resets to "Ask me" on every reload.
// Lives in the Activity log row; a chip over a native picker on phones, a segmented control above.
const APPROVAL_MODES: { value: ApprovalMode; label: string; hint: string }[] = [
  { value: 'ask', label: 'Ask me', hint: 'Pause and ask before each tool action (default)' },
  { value: 'auto-review', label: 'Auto-review', hint: 'Auto-approve low-risk actions (reading files, in-workspace edits); still ask before anything risky' },
  { value: 'allow-all', label: 'Allow all', hint: 'Approve every tool action for this session (resets on reload)' },
]

export function ApprovalPicker({ mode, onChange }: { mode: ApprovalMode; onChange: (m: ApprovalMode) => void }) {
  const current = APPROVAL_MODES.find((m) => m.value === mode) ?? APPROVAL_MODES[0]
  return (
    <>
      {/* Phones: a compact chip over a transparent native select. The select fills
          the 44pt chip and keeps 16px text, so iOS opens its picker without zooming. */}
      <label className="group sm:hidden relative shrink-0 flex items-center min-h-11" title={current.hint}>
        <span aria-hidden="true" className={`pointer-events-none flex items-center gap-1 rounded-full border group-has-[:focus-visible]:ring-2 group-has-[:focus-visible]:ring-amber-400/60 px-2.5 py-1 text-[11px] font-medium whitespace-nowrap ${mode === 'allow-all' ? 'border-amber-500/60 bg-amber-500/15 text-amber-300' : 'border-gray-700/60 bg-gray-800/60 text-gray-200'}`}>
          <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
          {current.label}
          <svg className="w-3 h-3 shrink-0 opacity-70" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
        </span>
        <select
          aria-label={`Approvals: ${current.label}`}
          value={mode}
          onChange={(e) => onChange(e.target.value as ApprovalMode)}
          className="absolute inset-0 w-full h-full opacity-0 text-base cursor-pointer appearance-none"
        >
          {APPROVAL_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
      </label>
      <div role="group" aria-label="Approvals" className="hidden sm:flex shrink-0 items-center gap-1.5">
        <span className="text-[10px] uppercase tracking-wider text-gray-500">Approvals</span>
        <div className="flex items-center gap-0.5 rounded-full bg-gray-800/60 border border-gray-700/50 p-0.5">
          {APPROVAL_MODES.map((m) => {
            const active = mode === m.value
            return (
              <button
                key={m.value}
                type="button"
                onClick={() => onChange(m.value)}
                title={m.hint}
                aria-pressed={active}
                className={`px-2.5 py-1 [@media(pointer:coarse)]:min-h-11 rounded-full text-[11px] font-medium whitespace-nowrap transition-colors ${
                  active ? (m.value === 'allow-all' ? 'bg-amber-500/90 text-gray-950' : 'bg-gray-700 text-ink') : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                {m.label}
              </button>
            )
          })}
        </div>
      </div>
    </>
  )
}
