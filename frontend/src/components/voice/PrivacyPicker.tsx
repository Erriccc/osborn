'use client'

import { HEADER_TAP_TARGET } from '../LogsDrawer'

export type ProjectMode = 'incognito' | 'public'

// The project's privacy mode (#663, #688), saved on the agent per project folder. Incognito (the
// default) files nothing on GitHub; public lets follow-through file items recorded from now on.
// Same row and shape as ApprovalPicker: a chip over a native select, so it shows the mode at a glance.
const MODES: { value: ProjectMode; label: string; hint: string }[] = [
  { value: 'incognito', label: 'Incognito', hint: 'Nothing from this project is filed on GitHub (default)' },
  { value: 'public', label: 'Public', hint: 'Follow-through may file issues in this project’s GitHub repo, for items recorded from now on' },
]

export function PrivacyPicker({ mode, onChange }: { mode: ProjectMode; onChange: (m: ProjectMode) => void }) {
  const current = MODES.find((m) => m.value === mode) ?? MODES[0]
  return (
    <label className={`group relative shrink-0 flex items-center ${HEADER_TAP_TARGET}`} title={current.hint}>
      <span aria-hidden="true" className={`pointer-events-none flex items-center gap-1 rounded-full border group-has-[:focus-visible]:ring-2 group-has-[:focus-visible]:ring-amber-400/60 px-2.5 py-1 text-[11px] font-medium whitespace-nowrap ${mode === 'public' ? 'border-amber-500/60 bg-amber-500/15 text-amber-300' : 'border-gray-700/60 bg-gray-800/60 text-gray-200'}`}>
        <span className="hidden pane-md:inline text-[10px] uppercase tracking-wider text-gray-500">Privacy</span>
        {current.label}
        <svg className="w-3 h-3 shrink-0 opacity-70" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
      </span>
      <select
        aria-label={`Privacy: ${current.label}`}
        value={mode}
        onChange={(e) => onChange(e.target.value as ProjectMode)}
        className="absolute inset-0 w-full h-full opacity-0 text-base cursor-pointer appearance-none"
      >
        {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
      </select>
    </label>
  )
}
