'use client'

import { ModeChip } from './ApprovalPicker'

export type ProjectMode = 'incognito' | 'public'

// The project's privacy mode (#663, #688), saved on the agent per project folder. Incognito (the
// default) files nothing on GitHub; public lets follow-through file items recorded from now on.
const MODES: { value: ProjectMode; label: string; hint: string }[] = [
  { value: 'incognito', label: 'Incognito', hint: 'Nothing from this project is filed on GitHub (default)' },
  { value: 'public', label: 'Public', hint: 'Follow-through may file issues in this project’s GitHub repo, for items recorded from now on' },
]

export function PrivacyPicker({ mode, onChange }: { mode: ProjectMode; onChange: (m: ProjectMode) => void }) {
  return (
    <ModeChip modes={MODES} mode={mode} onChange={onChange} name="Privacy" warn="public"
      icon={<span className="hidden pane-md:inline text-[10px] uppercase tracking-wider text-gray-500">Privacy</span>} />
  )
}
