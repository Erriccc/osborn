'use client'

import { useState, useEffect } from 'react'
import { usePanelExclusive, useViewportClamp } from './shared'
import { SkillStore, type SkillInfo } from '../AgentStore'

// Shared skills panel — the single source of truth for the skills UI. Mounted
// in TWO places: the first-class header SkillsPopover (primary, high-visibility)
// and the ControlMenu Tools tab (kept for muscle memory).
interface SkillsPanelProps {
  skills?: SkillInfo[]
  onAddSkill?: (name: string, content: string) => void
  onViewSkill?: (folder: string) => void
  onRemoveSkill?: (folder: string) => void
  onForkSkill?: (folder: string, newName: string) => void
  onInstallFromCatalog?: (name: string, url: string) => void
  showAddSkill?: boolean
  setShowAddSkill?: (v: boolean) => void
  newSkillName?: string
  setNewSkillName?: (v: string) => void
  newSkillContent?: string
  setNewSkillContent?: (v: string) => void
}

export function SkillsPanel({
  skills,
  onAddSkill,
  onViewSkill,
  onRemoveSkill,
  onForkSkill,
  onInstallFromCatalog,
  showAddSkill,
  setShowAddSkill,
  newSkillName,
  setNewSkillName,
  newSkillContent,
  setNewSkillContent,
}: SkillsPanelProps) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <h4 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Skills</h4>
        <button
          onClick={() => setShowAddSkill?.(!showAddSkill)}
          className="text-[10px] text-amber-400 hover:text-amber-300 transition-colors"
        >
          {showAddSkill ? 'Cancel' : '+ Add'}
        </button>
      </div>
      {showAddSkill && (
        <div className="mb-2 p-2 rounded-lg bg-gray-800/50 border border-gray-700/30 space-y-2">
          <input
            type="text"
            value={newSkillName || ''}
            onChange={(e) => setNewSkillName?.(e.target.value)}
            placeholder="Skill name (e.g. deploy-check)"
            className="w-full px-2 py-1 text-xs bg-gray-900 border border-gray-700 rounded text-gray-200 placeholder-gray-600 focus:outline-none focus:border-amber-500"
          />
          <textarea
            value={newSkillContent || ''}
            onChange={(e) => setNewSkillContent?.(e.target.value)}
            placeholder="# Skill: Name&#10;&#10;Description...&#10;&#10;## When to use&#10;...&#10;&#10;## How to execute&#10;..."
            rows={5}
            className="w-full px-2 py-1 text-xs bg-gray-900 border border-gray-700 rounded text-gray-200 placeholder-gray-600 focus:outline-none focus:border-amber-500 resize-none font-mono"
          />
          <button
            onClick={() => {
              if (newSkillName?.trim() && newSkillContent?.trim()) {
                onAddSkill?.(newSkillName.trim(), newSkillContent.trim())
              }
            }}
            disabled={!newSkillName?.trim() || !newSkillContent?.trim()}
            className="w-full py-1.5 text-xs bg-amber-500/20 text-amber-400 rounded hover:bg-amber-500/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Save Skill
          </button>
        </div>
      )}
      {skills && skills.length > 0 ? (
        <SkillStore skills={skills} onView={onViewSkill} onFork={onForkSkill} onRemove={onRemoveSkill} />
      ) : (
        <p className="text-[11px] text-gray-500">No skills installed</p>
      )}
      {/* Catalog: one-tap official skills */}
      {skills && !skills.some((sk) => /voice-e2e|browser-screen-recorder/i.test(sk.folder || sk.name)) && (
        <button
          onClick={() => onInstallFromCatalog?.('browser-screen-recorder', '/api/browser-screen-recorder')}
          className="mt-2 w-full py-1.5 text-[11px] rounded-lg bg-gray-800/70 border border-amber-500/20 text-amber-400 hover:bg-gray-800 transition-colors"
        >
          ⤓ Install Browser Screen Recorder skill (official)
        </button>
      )}
    </div>
  )
}

// First-class Skills button — promotes skills out of the buried menu into the
// header: sparkle icon + live count badge, opens a dedicated popover.
export function SkillsPopover(props: SkillsPanelProps & { disabled?: boolean; requestOpen?: number; hideTrigger?: boolean }) {
  const [open, setOpen] = useState(false)
  const count = props.skills?.length ?? 0
  // Esc closes the popover (outside-click already closes via the backdrop).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  usePanelExclusive('skills', open, setOpen)
  const popRef = useViewportClamp(open)
  useEffect(() => {
    if (props.requestOpen && !props.disabled) setOpen(true)
  }, [props.requestOpen, props.disabled])
  return (
    <div className="relative">
      {!props.hideTrigger && (
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={props.disabled}
        aria-label="Skills"
        data-testid="skills-button"
        title="Skills"
        className={`relative flex items-center gap-1.5 px-2 py-1.5 rounded-lg transition-all border ${
          props.disabled
            ? 'bg-gray-800/30 text-gray-600 border-transparent cursor-not-allowed'
            : open
              ? 'bg-amber-500/20 text-amber-300 border-amber-500/40 shadow-[0_0_12px_rgba(245,158,11,0.25)]'
              : 'border-transparent text-gray-400 hover:text-amber-300 hover:bg-gray-800/60'
        }`}
      >
        {/* Sparkles icon */}
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z" />
        </svg>
        <span className="hidden md:inline text-xs font-medium">Skills</span>
        {count > 0 && (
          <span className="min-w-[16px] h-4 px-1 flex items-center justify-center text-[9px] font-bold rounded-full bg-amber-500/25 text-amber-300 border border-amber-500/30">
            {count}
          </span>
        )}
      </button>
      )}
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          {/* Mobile: viewport-anchored (button-anchored panels jut off-screen
              when the trigger sits mid-header — user screenshot 2026-08-01);
              sm+: anchored under the button as before. */}
          <div ref={popRef} className="fixed inset-x-0 bottom-0 max-h-[78vh] overflow-y-auto sm:overflow-hidden sm:absolute sm:inset-x-auto sm:bottom-auto sm:left-auto sm:right-0 sm:top-full sm:mt-2 sm:max-h-none sm:w-[min(26rem,calc(100vw-1.5rem))] z-50 bg-gray-900 border border-gray-700/60 rounded-t-2xl sm:rounded-xl shadow-2xl pb-[env(safe-area-inset-bottom)] sm:pb-0">
            <div className="px-3 py-2 border-b border-gray-800 flex items-center justify-between">
              <span className="text-xs font-semibold text-gray-200">✨ Skills</span>
              <span className="text-[10px] text-gray-500">{count} installed</span>
            </div>
            <div className="max-h-96 overflow-y-auto p-3">
              <SkillsPanel {...props} />
            </div>
          </div>
        </>
      )}
    </div>
  )
}
