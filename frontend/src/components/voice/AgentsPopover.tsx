'use client'

import { useState, useEffect, useRef } from 'react'
import type { BackgroundFlow } from '../LogsDrawer'
import { AgentStore, type NamedAgent, type RolesData } from '../AgentStore'
import type { UserAgentDraft, UserAgentRow } from '@/lib/user-agents'
import { usePanelExclusive, useViewportClamp } from './shared'

// Agents button + popover. The panel body is the shared AgentStore (same
// surface as Settings → Agents & Skills) with live run status per agent.
export function AgentsPopover({ agents, roles, yours, activity, disabled, onSaveAgent, onDeleteAgent, onSetAgentEnabled, requestOpen, hideTrigger }: {
  agents?: NamedAgent[]
  roles?: RolesData | null
  yours?: UserAgentRow[] | null
  /** Live sub-agent runs — the same flows the Activity drawer's Running tab shows. */
  activity?: BackgroundFlow[]
  disabled?: boolean
  onSaveAgent?: (a: UserAgentDraft) => void
  onDeleteAgent?: (name: string) => void
  onSetAgentEnabled?: (name: string, enabled: boolean) => void
  /** Increment to force the panel open (mobile burger sheet rows use this —
      they can't reach internal state). Ignored while disabled. */
  requestOpen?: number
  /** Render panel only, no trigger button (driven purely by requestOpen). */
  hideTrigger?: boolean
}) {
  const [open, setOpen] = useState(false)
  const count = agents?.length ?? 0
  const runsOf = (name: string) => (activity ?? []).filter((f) => f.agentType?.toLowerCase() === name.toLowerCase())
  const isWorking = (name: string) => runsOf(name).some((f) => f.status === 'running')
  const working = (agents ?? []).filter((a) => isWorking(a.name)).length
  // "finished" only for a run that ended in the last 10 minutes (flows stay listed all session).
  const finishedAt = useRef(new Map<string, number>())
  const wasWorking = useRef(new Set<string>())
  for (const a of agents ?? []) {
    if (isWorking(a.name)) wasWorking.current.add(a.name)
    else if (wasWorking.current.delete(a.name)) finishedAt.current.set(a.name, Date.now())
  }
  const recentlyFinished = (name: string) => Date.now() - (finishedAt.current.get(name) ?? 0) < 600000
  // Esc closes the popover (outside-click already closes via the backdrop).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  usePanelExclusive('agents', open, setOpen)
  const popRef = useViewportClamp(open)
  useEffect(() => {
    if (requestOpen && !disabled) setOpen(true)
  }, [requestOpen, disabled])
  return (
    <div className="relative">
      {!hideTrigger && (
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-label="Agents"
        data-testid="agents-button"
        title="Named agents"
        className={`relative flex items-center gap-1.5 px-2 py-1.5 rounded-lg transition-all border ${
          disabled
            ? 'bg-gray-800/30 text-gray-600 border-transparent cursor-not-allowed'
            : open
              ? 'bg-amber-500/20 text-amber-300 border-amber-500/40 shadow-[0_0_12px_rgba(245,158,11,0.25)]'
              : 'border-transparent text-gray-400 hover:text-amber-300 hover:bg-gray-800/60'
        }`}
      >
        {/* Users/agents icon */}
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
        </svg>
        <span className="hidden md:inline text-xs font-medium">Agents</span>
        {working > 0 && <span aria-label={`${working} working`} className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-amber-400 animate-pulse" />}
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
              <span className="text-xs font-semibold text-gray-200">🤖 Agents</span>
              <span className="text-[10px] text-gray-500">{working > 0 ? `${working} working · ` : ''}{count} active</span>
            </div>
            <div className="max-h-[28rem] overflow-y-auto p-3">
              <AgentStore agents={agents ?? []} yours={yours ?? null} roles={roles} browseHref="/settings?section=agents&browse=1"
                onSave={onSaveAgent} onDelete={onDeleteAgent} onSetEnabled={onSetAgentEnabled}
                status={(name) => {
                  const live = runsOf(name).find((f) => f.status === 'running')
                  if (live) return <span title={live.lastMessage || live.task} className="text-[10px] font-semibold normal-case text-amber-300 animate-pulse">● working</span>
                  return recentlyFinished(name) ? <span className="text-[10px] normal-case text-emerald-400">✓ finished</span> : null
                }} />
            </div>
          </div>
        </>
      )}
    </div>
  )
}
