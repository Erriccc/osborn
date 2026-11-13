'use client'

import { useState, useEffect, useRef } from 'react'
import type { BackgroundFlow } from '../LogsDrawer'
import { usePanelExclusive, useViewportClamp } from './shared'

// Plain-language, user-facing one-liners for the built-in sub-agents. The raw
// `description` is a system-prompt instruction full of jargon ("GROUNDED",
// recall store, "tool calls") — a stranger needs the job, not the config.
const AGENT_BLURBS: Record<string, string> = {
  researcher: 'Digs through your code and the web to gather facts and examples.',
  reasoner: 'Thinks through hard problems and writes a plan — it doesn’t edit files.',
  writer: 'Makes the actual code changes — edits files and runs commands.',
  tester: 'Runs the tests and checks that the work holds up.',
  planner: 'Breaks a task into clear, ordered steps.',
  reviewer: 'Reviews the changes for problems before they ship.',
  steward: 'Keeps the code lean: reuses what already exists and checks nothing that depends on it breaks.',
}

// Named agents manager — mirrors the SkillsPopover pattern: first-class header
// button with count badge, opening a popover listing the orchestrator's named
// sub-agents (researcher/reasoner/writer) with role, model, and tool set.
export interface NamedAgent {
  name: string
  description: string
  model: string
  tools: string[]
  custom?: boolean  // true = user-defined (DB row), shadows/extends built-ins
}

export interface UserAgentDraft {
  name: string
  description: string
  prompt: string
  model: string
  tools: string[]
}

export function AgentsPopover({ agents, activity, disabled, onSaveAgent, onDeleteAgent, removed, onRestoreAgent, requestOpen, hideTrigger }: {
  agents?: NamedAgent[]
  /** Live sub-agent runs — the same flows the Activity drawer's Running tab shows. */
  activity?: BackgroundFlow[]
  disabled?: boolean
  onSaveAgent?: (a: UserAgentDraft) => void
  onDeleteAgent?: (name: string, isCustom: boolean) => void
  removed?: string[]
  onRestoreAgent?: (name: string) => void
  /** Increment to force the panel open (mobile burger sheet rows use this —
      they can't reach internal state). Ignored while disabled. */
  requestOpen?: number
  /** Render panel only, no trigger button (driven purely by requestOpen). */
  hideTrigger?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<UserAgentDraft | null>(null)
  const [deleteArm, setDeleteArm] = useState<string | null>(null)
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
              <span className="text-xs font-semibold text-gray-200">🤖 Named Agents</span>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-gray-500">{working > 0 ? `${working} working · ` : ''}{count} configured</span>
                {onSaveAgent && (
                  <button
                    onClick={() => setEditing(editing ? null : { name: '', description: '', prompt: '', model: 'inherit', tools: [] })}
                    className="text-[10px] text-amber-400 hover:text-amber-300 transition-colors"
                  >{editing ? 'Cancel' : '+ Add'}</button>
                )}
              </div>
            </div>
            <div className="max-h-96 overflow-y-auto p-3 space-y-1.5">
              {editing && (
                <div className="mb-2 p-2 rounded-lg bg-gray-800/50 border border-amber-500/20 space-y-1.5">
                  <input type="text" value={editing.name}
                    onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                    placeholder="agent-name (kebab-case)"
                    className="w-full px-2 py-1 text-xs bg-gray-900 border border-gray-700 rounded text-gray-200 placeholder-gray-600 focus:outline-none focus:border-amber-500" />
                  <input type="text" value={editing.description}
                    onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                    placeholder="When should the orchestrator use this agent?"
                    className="w-full px-2 py-1 text-xs bg-gray-900 border border-gray-700 rounded text-gray-200 placeholder-gray-600 focus:outline-none focus:border-amber-500" />
                  <textarea value={editing.prompt}
                    onChange={(e) => setEditing({ ...editing, prompt: e.target.value })}
                    placeholder="System prompt — the agent's role, workflow, and rules" rows={4}
                    className="w-full px-2 py-1 text-xs bg-gray-900 border border-gray-700 rounded text-gray-200 placeholder-gray-600 focus:outline-none focus:border-amber-500 resize-none font-mono" />
                  <div className="flex gap-1.5">
                    <select value={editing.model}
                      onChange={(e) => setEditing({ ...editing, model: e.target.value })}
                      className="px-2 py-1 text-xs bg-gray-900 border border-gray-700 rounded text-gray-200 focus:outline-none focus:border-amber-500">
                      {['inherit', 'sonnet', 'opus', 'haiku', 'fable'].map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                    <input type="text" value={editing.tools.join(', ')}
                      onChange={(e) => setEditing({ ...editing, tools: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })}
                      placeholder="Tools (comma-sep; empty = inherit all)"
                      className="flex-1 px-2 py-1 text-xs bg-gray-900 border border-gray-700 rounded text-gray-200 placeholder-gray-600 focus:outline-none focus:border-amber-500" />
                  </div>
                  <button
                    onClick={() => { if (editing.name.trim() && editing.description.trim() && editing.prompt.trim()) { onSaveAgent?.(editing); setEditing(null) } }}
                    disabled={!editing.name.trim() || !editing.description.trim() || !editing.prompt.trim()}
                    className="w-full py-1.5 text-xs bg-amber-500/20 text-amber-400 rounded hover:bg-amber-500/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >Save agent (applies next session)</button>
                </div>
              )}
              {agents && agents.length > 0 ? agents.map((a) => { const runs = runsOf(a.name); const live = runs.find((f) => f.status === 'running'); return (
                <div key={a.name} className="p-2 rounded-lg bg-gray-800/50 border border-gray-700/30">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-medium text-gray-200 capitalize flex items-center gap-1.5">
                      {a.name}
                      {a.custom && <span className="px-1 py-px text-[8px] rounded bg-sky-500/15 text-sky-300 border border-sky-500/20 uppercase">custom</span>}
                    </span>
                    <div className="flex items-center gap-2 shrink-0">
                      {live ? <span className="text-[10px] font-semibold text-amber-300 animate-pulse">● working</span>
                        : recentlyFinished(a.name) && <span className="text-[10px] text-emerald-400">✓ finished</span>}
                      <span className="px-1.5 py-0.5 text-[9px] font-semibold rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/20 uppercase tracking-wide">{a.model}</span>
                      {onDeleteAgent && (
                        <button
                          onClick={() => {
                            if (deleteArm === a.name) { onDeleteAgent(a.name, !!a.custom); setDeleteArm(null) }
                            else { setDeleteArm(a.name); setTimeout(() => setDeleteArm(null), 4000) }
                          }}
                          className={`text-[10px] ${deleteArm === a.name ? 'text-red-400 font-semibold' : 'text-gray-500 hover:text-red-400'}`}
                        >{deleteArm === a.name ? 'Confirm?' : 'Remove'}</button>
                      )}
                    </div>
                  </div>
                  <p title={a.description} className="text-[11px] text-gray-500 mt-0.5 leading-snug">{AGENT_BLURBS[a.name?.toLowerCase()] ?? a.description}</p>
                  {live && (live.lastMessage || live.task) && <p className="text-[11px] text-amber-200/80 mt-1 leading-snug line-clamp-2">{live.lastMessage || live.task}</p>}
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {a.tools?.map((t) => (
                      <span key={t} className="px-1.5 py-0.5 text-[9px] rounded bg-gray-900/80 text-gray-400 border border-gray-700/40">{t}</span>
                    ))}
                  </div>
                </div>
              ) }) : (
                <p className="text-[11px] text-gray-500">No named agents reported</p>
              )}
              {/* Removed defaults — never gone forever, one tap to add back */}
              {removed && removed.length > 0 && onRestoreAgent && (
                <div className="pt-2 mt-1 border-t border-gray-800">
                  <h5 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Available to add</h5>
                  {removed.map((name) => (
                    <div key={name} className="flex items-center justify-between px-2 py-1.5 rounded-lg bg-gray-800/30 border border-dashed border-gray-700/40 mb-1">
                      <span className="text-xs text-gray-400 capitalize">{name}</span>
                      <button onClick={() => onRestoreAgent(name)}
                        className="text-[10px] px-2 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/20 hover:bg-amber-500/25 transition-colors">
                        ⤓ Add
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
