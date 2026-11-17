'use client'

import type { ApprovalMode } from './PermissionModal'

// The session's approval mode: the one visible control that replaced the hidden
// auto-approve toggles. NOT persisted: it resets to "Ask me" on every reload.
// Lives in the Activity log row; a native picker on phones, a segmented control above.
const APPROVAL_MODES: { value: ApprovalMode; label: string; hint: string }[] = [
  { value: 'ask', label: 'Ask me', hint: 'Pause and ask before each tool action (default)' },
  { value: 'auto-review', label: 'Auto-review', hint: 'Auto-approve low-risk actions (reading files, in-workspace edits); still ask before anything risky' },
  { value: 'allow-all', label: 'Allow all', hint: 'Approve every tool action for this session (resets on reload)' },
]

export function ApprovalPicker({ mode, onChange }: { mode: ApprovalMode; onChange: (m: ApprovalMode) => void }) {
  return (
    <>
      <label className="sm:hidden shrink-0 flex items-center">
        <span className="sr-only">Approvals</span>
        <select
          value={mode}
          onChange={(e) => onChange(e.target.value as ApprovalMode)}
          className={`rounded-full border px-2.5 py-0.5 text-base font-medium outline-none ${mode === 'allow-all' ? 'border-amber-500/60 bg-amber-500/15 text-amber-300' : 'border-gray-700/60 bg-gray-800/60 text-gray-200'}`}
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
                className={`px-2.5 py-1 rounded-full text-[11px] font-medium whitespace-nowrap transition-colors ${
                  active ? (m.value === 'allow-all' ? 'bg-amber-500/90 text-gray-950' : 'bg-gray-700 text-white') : 'text-gray-400 hover:text-gray-200'
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
