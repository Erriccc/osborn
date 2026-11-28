'use client'

import type { ReactNode } from 'react'
import type { ApprovalMode } from './PermissionModal'
import { HEADER_TAP_TARGET } from '../LogsDrawer'

// The approval mode: the one visible control that replaced the hidden
// auto-approve toggles. Saved on the agent (#364), so it holds across reloads
// and applies to phone calls too; a call says which mode is on when it starts.
// Lives in the Activity log row; a chip over a native picker on phones, a segmented control above.
const APPROVAL_MODES: { value: ApprovalMode; label: string; hint: string }[] = [
  { value: 'ask', label: 'Ask me', hint: 'Pause and ask before each tool action (default)' },
  { value: 'auto-review', label: 'Auto-review', hint: 'Auto-approve low-risk actions (reading files, in-workspace edits); still ask before anything risky. Applies to phone calls too' },
  { value: 'allow-all', label: 'Allow all', hint: 'Approve every tool action, in the app and on phone calls, until you switch back' },
]

// A mode chip over a transparent native select. The select fills the 44pt chip and keeps 16px text, so iOS
// opens its picker without zooming; `warn` is the mode shown in amber. Shared with PrivacyPicker.
export function ModeChip<T extends string>({ modes, mode, onChange, name, warn, icon, className = '' }: {
  modes: { value: T; label: string; hint: string }[]; mode: T; onChange: (m: T) => void; name: string; warn: T; icon: ReactNode; className?: string
}) {
  const current = modes.find((m) => m.value === mode) ?? modes[0]
  return (
    <label className={`group ${className} relative shrink-0 flex items-center ${HEADER_TAP_TARGET}`} title={current.hint}>
      <span aria-hidden="true" className={`pointer-events-none flex items-center gap-1 rounded-full border group-has-[:focus-visible]:ring-2 group-has-[:focus-visible]:ring-amber-400/60 px-2.5 py-1 text-[11px] font-medium whitespace-nowrap ${mode === warn ? 'border-amber-500/60 bg-amber-500/15 text-amber-300' : 'border-gray-700/60 bg-gray-800/60 text-gray-200'}`}>
        {icon}
        {current.label}
        <svg className="w-3 h-3 shrink-0 opacity-70" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
      </span>
      <select
        aria-label={`${name}: ${current.label}`}
        value={mode}
        onChange={(e) => onChange(e.target.value as T)}
        className="absolute inset-0 w-full h-full opacity-0 text-base cursor-pointer appearance-none"
      >
        {modes.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
      </select>
    </label>
  )
}

export function ApprovalPicker({ mode, onChange }: { mode: ApprovalMode; onChange: (m: ApprovalMode) => void }) {
  return (
    <>
      {/* A narrow chat column (phones, or Rooms and Outputs open): a compact chip over a transparent native select. */}
      <ModeChip modes={APPROVAL_MODES} mode={mode} onChange={onChange} name="Approvals" warn="allow-all" className="pane-md:hidden"
        icon={<svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>} />
      <div role="group" aria-label="Approvals" className="hidden pane-md:flex shrink-0 items-center gap-1.5">
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
