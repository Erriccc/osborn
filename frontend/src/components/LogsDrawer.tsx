'use client'

import React, { useState, useEffect, useRef, useCallback } from 'react'

// ---------------------------------------------------------------------------
// Machine-chip health thresholds — edit these to calibrate live
// ---------------------------------------------------------------------------
// RAM usage tiers (percent of total)
const RAM_AMBER = 70   // >= this → amber
const RAM_RED   = 85   // >= this → red


interface ToolMeta {
  tool: string
  status?: 'running' | 'completed'
  filePath?: string
  fileName?: string
  command?: string
  pattern?: string
  url?: string
  description?: string
  linesAdded?: number
  linesRemoved?: number
  editCount?: number
  diff?: string
  agentRole?: string
}

interface LogMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: Date
  toolName?: string
  toolMeta?: ToolMeta
}

// Role initial(s) avatar used by every role pill.
// Sits inside a small circle; inherits currentColor from the pill's text-* class.
const ProfileAvatar = ({ initials }: { initials: string }) => (
  <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-current/20 shrink-0">
    <span className="text-[9px] font-bold leading-none" aria-hidden="true">{initials}</span>
  </span>
)

// Derive display initials from any role/name string.
// Known built-ins that would otherwise collide are overridden explicitly;
// everything else gets the first two letters (uppercased) of the name, or
// just the first letter when the name is a single character.
function deriveInitials(role: string): string {
  const overrides: Record<string, string> = {
    main:         'M',
    orchestrator: 'M',
    writer:       'W',
    researcher:   'Rs',
    reasoner:     'Rn',
  }
  if (overrides[role]) return overrides[role]
  const clean = role.trim()
  if (clean.length <= 1) return clean.toUpperCase()
  return (clean[0] + clean[1]).toUpperCase()
}

// Map an agentRole to a className and initials for the color-coded avatar+name chip.
// Known roles get their own brand color; any unknown/custom role falls back to a
// neutral slate chip so it still renders correctly instead of breaking or going blank.
function agentPillStyle(role: string | undefined): { className: string; initials: string } | null {
  if (!role) return null
  const colorMap: Record<string, string> = {
    main:         'bg-gray-500/20 text-gray-300 border border-gray-500/30',
    orchestrator: 'bg-gray-500/20 text-gray-400 border border-gray-500/30',
    researcher:   'bg-blue-500/20 text-blue-300 border border-blue-500/30',
    writer:       'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30',
    reasoner:     'bg-violet-500/20 text-violet-300 border border-violet-500/30',
    reviewer:     'bg-rose-500/20 text-rose-300 border border-rose-500/30',
    tester:       'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30',
    planner:      'bg-amber-500/20 text-amber-300 border border-amber-500/30',
  }
  const className = colorMap[role] ?? 'bg-slate-500/20 text-slate-300 border border-slate-500/30'
  return { className, initials: deriveInitials(role) }
}

interface BackgroundFlow {
  agentId: string
  agentType: string
  status: string
  artifact?: string
}

export interface ProcessInfo {
  pid: number
  name: string
  rssMb: number
}

export interface MachineData {
  processes: ProcessInfo[]
  memory: { usedMb: number; totalMb: number; freeMb: number }
}

interface LogsDrawerProps {
  messages: LogMessage[]
  onCircleBack?: (noteText: string) => void
  onLike?: (noteText: string) => void
  onDislike?: (noteText: string) => void
  backgroundFlows?: BackgroundFlow[]
  onStopDispatch?: (agentId: string) => void
  machineData?: MachineData
  agentMemory?: { totalMb: number; usedMb: number; availableMb: number; usedPct: number; processRssMb: number }
  onMachineTabActive?: (active: boolean) => void
  ideState?: 'stopped' | 'starting' | 'running'
  ideUrl?: string
  onEditorOpen?: () => void
  onEditorStop?: () => void
  onEditorRestart?: () => void
  // Live chip data — fed by VoiceRoom's always-on polls (independent of which tab is active)
  machineChipRamPct?: number   // 0-100 integer
  machineChipProcCount?: number // total process count
  ideError?: string | null
}

// Map a tool to a { verb, icon } for the review card. Verb is past-tense so
// the log reads like a changelog ("Edited VoiceRoom.tsx", "Ran build").
function toolVisual(tool: string): { verb: string; icon: React.ReactNode } {
  const t = tool.toLowerCase()
  const stroke = { fill: 'none' as const, viewBox: '0 0 24 24', stroke: 'currentColor', strokeWidth: 2 }
  if (t === 'read' || t === 'notebookread') return {
    verb: 'Read',
    icon: <svg className="w-3.5 h-3.5" {...stroke}><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>,
  }
  if (t === 'edit' || t === 'multiedit' || t === 'notebookedit') return {
    verb: 'Edited',
    icon: <svg className="w-3.5 h-3.5" {...stroke}><path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>,
  }
  if (t === 'write') return {
    verb: 'Wrote',
    icon: <svg className="w-3.5 h-3.5" {...stroke}><path strokeLinecap="round" strokeLinejoin="round" d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>,
  }
  if (t === 'bash') return {
    verb: 'Ran',
    icon: <svg className="w-3.5 h-3.5" {...stroke}><path strokeLinecap="round" strokeLinejoin="round" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>,
  }
  if (t === 'grep' || t === 'glob') return {
    verb: 'Searched',
    icon: <svg className="w-3.5 h-3.5" {...stroke}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>,
  }
  if (t === 'webfetch' || t === 'websearch') return {
    verb: t === 'websearch' ? 'Searched' : 'Fetched',
    icon: <svg className="w-3.5 h-3.5" {...stroke}><path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /><path strokeLinecap="round" strokeLinejoin="round" d="M3.6 9h16.8M3.6 15h16.8M12 3a15 15 0 010 18M12 3a15 15 0 000 18" /></svg>,
  }
  return {
    verb: tool,
    icon: <svg className="w-3.5 h-3.5" {...stroke}><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6l4 2" /><circle cx="12" cy="12" r="9" /></svg>,
  }
}

// Render a unified diff (createPatch output) with red/green line coloring,
// like Claude's Edit review. Header lines are dropped; @@ hunks are dimmed.
function DiffView({ diff }: { diff: string }) {
  const lines = diff.split('\n').filter((l) => {
    return !(l.startsWith('Index:') || l.startsWith('===') || l.startsWith('--- ') || l.startsWith('+++ '))
  })
  return (
    <pre className="mt-1.5 max-h-56 max-w-full overflow-x-auto overflow-y-auto rounded-md bg-gray-950/70 border border-gray-800 p-2 text-[10.5px] leading-relaxed font-mono">
      {lines.map((l, i) => {
        const isAdd = l.startsWith('+')
        const isDel = l.startsWith('-')
        const isHunk = l.startsWith('@@')
        return (
          <div
            key={i}
            className={
              isHunk ? 'text-cyan-400/70'
              : isAdd ? 'text-emerald-300 bg-emerald-500/10'
              : isDel ? 'text-red-300 bg-red-500/10'
              : 'text-gray-500'
            }
          >
            {l || ' '}
          </div>
        )
      })}
    </pre>
  )
}

// Body content thresholds for the expand/collapse affordance.
// A preview is shown when content exceeds either limit; tapping reveals the full text.
const BODY_PREVIEW_LINES = 6    // lines — wrap-aware approximate
const BODY_PREVIEW_CHARS = 300  // characters

function ToolLogCard({ msg, onCircleBack, onLike, onDislike }: { msg: LogMessage; onCircleBack?: (noteText: string) => void; onLike?: (noteText: string) => void; onDislike?: (noteText: string) => void }) {
  const [detailOpen, setDetailOpen] = useState(false)
  const [bodyExpanded, setBodyExpanded] = useState(false)
  const [liked, setLiked] = useState(false)
  const [disliked, setDisliked] = useState(false)
  const [bookmarked, setBookmarked] = useState(false)
  const [copied, setCopied] = useState(false)
  const meta = msg.toolMeta!
  const { verb, icon } = toolVisual(meta.tool)
  const running = meta.status === 'running'

  // The primary display target: prefer the human-readable name/description,
  // fall back to command/pattern/url. Used in the card body and copy payload.
  const displayName = meta.fileName || meta.description || meta.pattern || meta.url || meta.command
  const hasDetail = !!(meta.diff || meta.filePath)
  const showStats = (meta.linesAdded ?? 0) > 0 || (meta.linesRemoved ?? 0) > 0
  const pill = agentPillStyle(meta.agentRole)

  // Build the readable body text that goes into the card body.
  // Priority: command (for bash/grep/etc.) > filePath > displayName fallback.
  // The body is what the user actually cares about reading.
  const bodyLines: string[] = []
  if (meta.filePath) bodyLines.push(meta.filePath)
  if (meta.command && meta.command !== meta.filePath) bodyLines.push(meta.command)
  else if (!meta.command && displayName && displayName !== meta.filePath) bodyLines.push(displayName)
  const bodyText = bodyLines.join('\n')

  // Decide if we need a "show more" affordance for the body text.
  // We use a simple heuristic: line count or character count exceeds thresholds.
  const bodyLineCount = bodyText.split('\n').length
  const bodyNeedsExpand = bodyText.length > BODY_PREVIEW_CHARS || bodyLineCount > BODY_PREVIEW_LINES
  const bodyPreview = bodyNeedsExpand
    ? bodyText.split('\n').slice(0, BODY_PREVIEW_LINES).join('\n').substring(0, BODY_PREVIEW_CHARS)
    : bodyText
  const shownBody = bodyExpanded ? bodyText : bodyPreview

  function toggleLike() {
    const next = !liked
    setLiked(next)
    if (next) {
      setDisliked(false)
      if (onLike) {
        const detail = meta.command || meta.filePath || meta.description || meta.pattern || meta.url || '(no further detail)'
        const noteText = `[liked] The user liked this step: ${verb} ${displayName ?? '(unknown)'}. Details: ${detail}. Positive signal — keep doing this kind of thing.`
        onLike(noteText)
      }
    }
  }

  function toggleDislike() {
    const next = !disliked
    setDisliked(next)
    if (next) {
      setLiked(false)
      if (onDislike) {
        const detail: string[] = []
        if (meta.command) detail.push(meta.command)
        if (meta.filePath) detail.push(meta.filePath)
        if (meta.description) detail.push(meta.description)
        if (meta.diff) detail.push(meta.diff.substring(0, 500))
        const detailStr = detail.length > 0 ? detail.join(' | ') : '(no further detail)'
        const noteText = `[disliked] The user flagged this step as not what they wanted: ${verb} ${displayName ?? '(unknown)'}. Details: ${detailStr}. Acknowledge this naturally, and if it was an edit, OFFER to undo/revert it and ask before doing so — do NOT auto-revert.`
        onDislike(noteText)
      }
    }
  }

  function toggleBookmark() {
    const next = !bookmarked
    setBookmarked(next)
    if (next && onCircleBack) {
      const detail: string[] = []
      if (meta.filePath) detail.push(meta.filePath)
      if (meta.command) detail.push(meta.command)
      if (meta.description) detail.push(meta.description)
      if (meta.pattern) detail.push(`Pattern: ${meta.pattern}`)
      if (meta.url) detail.push(`URL: ${meta.url}`)
      const detailStr = detail.length > 0 ? detail.join(' | ') : '(no further detail)'
      const noteText = `[circle-back] The user flagged this step to revisit after the current main objectives: ${verb} ${displayName ?? '(unknown)'}. Details: ${detailStr}. Acknowledge this naturally in conversation and try to reflect on WHY they might want to revisit it — don't just log it.`
      onCircleBack(noteText)
    }
  }

  function copyRow() {
    const header = displayName ? `[${verb}] ${displayName}` : `[${verb}]`
    const body: string[] = []
    if (meta.filePath && meta.filePath !== displayName) body.push(meta.filePath)
    if (meta.command) body.push(meta.command)
    if (meta.description && meta.description !== displayName) body.push(meta.description)
    if (meta.pattern && meta.pattern !== displayName) body.push(`Pattern: ${meta.pattern}`)
    if (meta.url && meta.url !== displayName) body.push(`URL: ${meta.url}`)
    if (meta.diff) body.push(meta.diff)
    const text = body.length > 0 ? `${header}\n\n${body.join('\n\n')}` : header
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => {})
  }

  return (
    <div className="rounded-xl border border-gray-700/50 bg-gray-800/60 shadow-sm overflow-hidden max-w-full">

      {/* ── CARD HEADER: who did this + when ───────────────────────────── */}
      <div className="flex items-center gap-2 px-3 pt-3 pb-1.5">
        {/* Tool icon + verb — left side; amber tint when running */}
        <span className={`shrink-0 ${running ? 'text-amber-400' : 'text-gray-400'}`}>{icon}</span>
        <span className="text-[11px] font-semibold text-gray-300 shrink-0">{verb}</span>
        {running && (
          <svg className="w-3 h-3 animate-spin text-amber-400/70 shrink-0" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        )}

        {/* Spacer */}
        <span className="flex-1" />

        {/* Agent role chip — right side */}
        {pill && (
          <span title={meta.agentRole} className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium whitespace-nowrap shrink-0 ${pill.className}`}>
            <ProfileAvatar initials={pill.initials} />
            {meta.agentRole}
          </span>
        )}

        {/* Timestamp — right-most */}
        <span className="text-[10px] text-gray-500 tabular-nums shrink-0">
          {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>

      {/* ── CARD BODY: readable content — the main event ───────────────── */}
      <div className="px-3 pb-2">
        {/* Primary display name (filename, URL, description) shown as a label if it differs from the body */}
        {displayName && displayName !== meta.command && displayName !== meta.filePath && (
          <div className="text-[11px] text-amber-300/90 font-medium mb-1 break-all leading-snug">
            {displayName}
          </div>
        )}

        {/* Body: command / filePath — the substantive content */}
        {bodyText ? (
          <div>
            <pre className={`font-mono text-[11px] leading-relaxed text-gray-200 whitespace-pre-wrap break-all ${!bodyExpanded && bodyNeedsExpand ? 'line-clamp-6' : ''}`}>
              {shownBody}
            </pre>
            {bodyNeedsExpand && (
              <button
                onClick={() => setBodyExpanded((v) => !v)}
                className="mt-0.5 text-[10px] text-violet-400 hover:text-violet-300 transition-colors"
              >
                {bodyExpanded ? 'Show less' : 'Show more'}
              </button>
            )}
          </div>
        ) : null}

        {/* Diff stats inline with body */}
        {showStats && (
          <div className="flex items-center gap-1.5 mt-1 text-[10px] font-mono">
            {(meta.linesAdded ?? 0) > 0 && <span className="text-emerald-400">+{meta.linesAdded}</span>}
            {(meta.linesRemoved ?? 0) > 0 && <span className="text-red-400">-{meta.linesRemoved}</span>}
            {meta.editCount && meta.editCount > 1 && (
              <span className="text-gray-500">{meta.editCount} edits</span>
            )}
          </div>
        )}
        {/* Edit count alone (no stat lines) */}
        {!showStats && meta.editCount && meta.editCount > 1 && (
          <div className="mt-0.5 text-[10px] text-gray-500">{meta.editCount} edits</div>
        )}
      </div>

      {/* ── DIFF / DETAIL BLOCK: collapsible, shown below body ─────────── */}
      {detailOpen && hasDetail && (
        <div className="px-3 pb-2.5 border-t border-gray-700/30 pt-2">
          {meta.filePath && !bodyText.includes(meta.filePath) && (
            <div className="text-[10px] font-mono text-gray-500 break-all mb-1">{meta.filePath}</div>
          )}
          {meta.diff && <DiffView diff={meta.diff} />}
        </div>
      )}

      {/* ── ACTIONS ROW: secondary, tucked bottom-right ─────────────────── */}
      <div className="flex items-center justify-end gap-0 px-2 pb-1.5 pt-0">
        {/* Expand diff/detail chevron — only when there is a diff or filePath detail beyond what body already shows */}
        {hasDetail && (
          <button
            onClick={() => setDetailOpen((v) => !v)}
            title={detailOpen ? 'Collapse detail' : 'Expand diff / detail'}
            className="flex items-center justify-center w-7 h-7 rounded transition-colors text-gray-600 hover:text-gray-400 hover:bg-gray-700/40"
          >
            <svg className={`w-3 h-3 transition-transform ${detailOpen ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        )}

        {/* Copy */}
        <button
          onClick={copyRow}
          title="Copy"
          className="flex items-center justify-center w-7 h-7 rounded transition-colors text-gray-600 hover:text-gray-300 hover:bg-gray-700/40"
        >
          {copied ? (
            <svg className="w-3 h-3 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          ) : (
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          )}
        </button>

        {/* Like */}
        <button
          onClick={toggleLike}
          title={liked ? 'Unlike' : 'Like'}
          className={`flex items-center justify-center w-7 h-7 rounded transition-colors hover:bg-gray-700/40 ${liked ? 'text-pink-400' : 'text-gray-600 hover:text-pink-400'}`}
        >
          <svg className="w-3 h-3" fill={liked ? 'currentColor' : 'none'} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
          </svg>
        </button>

        {/* Dislike */}
        <button
          onClick={toggleDislike}
          title={disliked ? 'Remove dislike' : 'Dislike'}
          className={`flex items-center justify-center w-7 h-7 rounded transition-colors hover:bg-gray-700/40 ${disliked ? 'text-red-400' : 'text-gray-600 hover:text-red-400'}`}
        >
          <svg className="w-3 h-3" fill={disliked ? 'currentColor' : 'none'} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10 14H5.236a2 2 0 01-1.789-2.894l3.5-7A2 2 0 018.736 3h4.018a2 2 0 01.485.06l3.76.94m-7 10v5a2 2 0 002 2h.096c.5 0 .905-.405.905-.904 0-.715.211-1.413.608-2.008L17 13V4m-7 10h2m5-10h2a2 2 0 012 2v6a2 2 0 01-2 2h-2.5" />
          </svg>
        </button>

        {/* Bookmark / circle-back */}
        <button
          onClick={toggleBookmark}
          title={bookmarked ? 'Remove circle-back' : 'Circle back to this'}
          className={`flex items-center justify-center w-7 h-7 rounded transition-colors hover:bg-gray-700/40 ${bookmarked ? 'text-amber-400' : 'text-gray-600 hover:text-amber-400'}`}
        >
          <svg className="w-3 h-3" fill={bookmarked ? 'currentColor' : 'none'} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
          </svg>
        </button>
      </div>
    </div>
  )
}

const DRAWER_MIN_HEIGHT = 120
const DRAWER_DEFAULT_HEIGHT = 256

// ---------------------------------------------------------------------------
// MachineChipBadge — compact RAM% + process-count badge for the Machine tab chip.
// Color tier = worst of RAM and process signals.
// Pulses in red state only, static in amber, calm in green/absent.
// ---------------------------------------------------------------------------
type HealthTier = 'green' | 'amber' | 'red'

function ramTier(pct: number): HealthTier {
  if (pct >= RAM_RED) return 'red'
  if (pct >= RAM_AMBER) return 'amber'
  return 'green'
}


const TIER_DOT_CLASS: Record<HealthTier, string> = {
  green: 'bg-emerald-400',
  amber: 'bg-amber-400',
  red:   'bg-red-500 animate-pulse',
}

const TIER_TEXT_CLASS: Record<HealthTier, string> = {
  green: 'text-emerald-400',
  amber: 'text-amber-400',
  red:   'text-red-400',
}

function MachineChipBadge({ ramPct, procCount }: { ramPct: number; procCount: number }) {
  const tier = ramTier(ramPct)
  return (
    <span className={`inline-flex items-center gap-1 ml-1 px-1.5 py-0.5 rounded-full bg-gray-800 border border-gray-700/70 text-[9px] font-semibold leading-none tabular-nums ${TIER_TEXT_CLASS[tier]}`}>
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${TIER_DOT_CLASS[tier]}`} />
      {ramPct}%
      <span className="text-gray-500 font-normal">·</span>
      {procCount}p
    </span>
  )
}

export function LogsDrawer({ messages, onCircleBack, onLike, onDislike, backgroundFlows, onStopDispatch, machineData, agentMemory, onMachineTabActive, ideState = 'stopped', ideUrl, onEditorOpen, onEditorStop, onEditorRestart, machineChipRamPct, machineChipProcCount, ideError }: LogsDrawerProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<'log' | 'running' | 'machine'>('log')
  const [lastSeenCount, setLastSeenCount] = useState(0)
  const [showJumpPill, setShowJumpPill] = useState(false)
  const [drawerHeight, setDrawerHeight] = useState(DRAWER_DEFAULT_HEIGHT)
  const scrollRef = useRef<HTMLDivElement>(null)
  const isAtBottomRef = useRef(true)
  const dragStartRef = useRef<{ y: number; height: number } | null>(null)

  const handleDragHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    dragStartRef.current = { y: e.clientY, height: drawerHeight }
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
  }

  const handleDragHandlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStartRef.current) return
    // Dragging UP (negative delta) grows the drawer; dragging DOWN shrinks it
    const delta = dragStartRef.current.y - e.clientY
    const newHeight = dragStartRef.current.height + delta
    const maxHeight = window.innerHeight * 0.8
    setDrawerHeight(Math.max(DRAWER_MIN_HEIGHT, Math.min(maxHeight, newHeight)))
  }

  const handleDragHandlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    dragStartRef.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
  }

  // Notify parent when Machine tab becomes active so it can start/stop polling
  useEffect(() => {
    onMachineTabActive?.(isOpen && activeTab === 'machine')
  }, [isOpen, activeTab, onMachineTabActive])

  const unreadCount = messages.length - lastSeenCount

  // Track whether the user is near the bottom so auto-scroll doesn't yank them
  // back while they are reading earlier entries.
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    isAtBottomRef.current = isAtBottom
    if (isAtBottom) setShowJumpPill(false)
  }, [])

  useEffect(() => {
    if (isOpen) {
      setLastSeenCount(messages.length)
      if (scrollRef.current) {
        // Only auto-scroll to the newest entry when the user is already at/near
        // the bottom. If they have scrolled up to read history, leave them there.
        if (isAtBottomRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight
        } else {
          // New entry arrived while scrolled up — show the jump pill.
          setShowJumpPill(true)
        }
      }
    }
  }, [messages, isOpen])

  return (
    <div className="border-t border-gray-700/50">
      {/* Toggle button */}
      <button
        onClick={() => {
          setIsOpen(!isOpen)
          if (!isOpen) setLastSeenCount(messages.length)
        }}
        className="w-full flex items-center justify-between px-4 py-2 text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-800/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <svg className={`w-3 h-3 transition-transform ${isOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
          <span>Activity log</span>
        </div>
        {unreadCount > 0 && !isOpen && (
          <span className="bg-violet-500/20 text-violet-300 px-1.5 py-0.5 rounded-full text-[10px]">
            {unreadCount}
          </span>
        )}
      </button>

      {/* Collapsible panel with two tabs: Log and Running */}
      {isOpen && (
        <div className="relative">
          {/* Drag handle — grab this to resize the drawer height (Log tab only) */}
          <div
            onPointerDown={handleDragHandlePointerDown}
            onPointerMove={handleDragHandlePointerMove}
            onPointerUp={handleDragHandlePointerUp}
            onPointerCancel={handleDragHandlePointerUp}
            className="flex items-center justify-center w-full h-3 cursor-ns-resize select-none touch-none bg-transparent hover:bg-gray-700/30 transition-colors"
            title="Drag to resize"
            aria-label="Resize activity log"
          >
            <div className="w-8 h-1 rounded-full bg-gray-600/60" />
          </div>

          {/* Tab switcher */}
          {(() => {
            const runningCount = (backgroundFlows ?? []).filter((f) => f.status === 'running').length
            return (
              <div className="flex items-center gap-0 px-3 pt-1 pb-0 border-b border-gray-700/50">
                <button
                  onClick={() => setActiveTab('log')}
                  className={`px-3 py-1.5 text-xs font-medium rounded-t transition-colors ${
                    activeTab === 'log'
                      ? 'text-gray-200 border-b-2 border-violet-400 bg-transparent'
                      : 'text-gray-500 hover:text-gray-300 border-b-2 border-transparent'
                  }`}
                >
                  Log
                </button>
                <button
                  onClick={() => setActiveTab('running')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-t transition-colors ${
                    activeTab === 'running'
                      ? 'text-gray-200 border-b-2 border-violet-400 bg-transparent'
                      : 'text-gray-500 hover:text-gray-300 border-b-2 border-transparent'
                  }`}
                >
                  Running
                  {runningCount > 0 ? (
                    <span className="inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-amber-500/80 text-gray-900 text-[9px] font-bold leading-none">
                      {runningCount}
                    </span>
                  ) : (backgroundFlows ?? []).length > 0 ? (
                    <span className="inline-flex items-center justify-center w-1.5 h-1.5 rounded-full bg-gray-600" />
                  ) : null}
                </button>
                <button
                  onClick={() => setActiveTab('machine')}
                  className={`flex items-center px-3 py-1.5 text-xs font-medium rounded-t transition-colors ${
                    activeTab === 'machine'
                      ? 'text-gray-200 border-b-2 border-violet-400 bg-transparent'
                      : 'text-gray-500 hover:text-gray-300 border-b-2 border-transparent'
                  }`}
                >
                  Machine
                  {typeof machineChipRamPct === 'number' && typeof machineChipProcCount === 'number' && (
                    <MachineChipBadge ramPct={machineChipRamPct} procCount={machineChipProcCount} />
                  )}
                </button>
              </div>
            )
          })()}

          {/* Log tab content */}
          {activeTab === 'log' && (
            <>
              {showJumpPill && (
                <button
                  onClick={() => {
                    if (scrollRef.current) {
                      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
                    }
                    isAtBottomRef.current = true
                    setShowJumpPill(false)
                  }}
                  className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-500/90 hover:bg-amber-400/90 text-gray-900 text-xs font-semibold shadow-lg backdrop-blur-sm transition-colors"
                >
                  Jump to latest
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
              )}
              <div
                ref={scrollRef}
                onScroll={handleScroll}
                className="overflow-y-auto overflow-x-hidden px-3 py-2 space-y-2 scrollbar-thin scrollbar-thumb-gray-700 scrollbar-track-transparent bg-gray-900/50"
                style={{ height: drawerHeight }}
              >
                {messages.length === 0 ? (
                  <p className="text-xs text-gray-500 text-center py-2">No activity yet</p>
                ) : (
                  messages.map((msg) =>
                    msg.toolMeta ? (
                      <ToolLogCard key={msg.id} msg={msg} onCircleBack={onCircleBack} onLike={onLike} onDislike={onDislike} />
                    ) : (
                      <div key={msg.id} className="flex items-start gap-2 text-xs px-1">
                        <span className="text-gray-500 shrink-0 font-mono">
                          {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        </span>
                        {msg.toolName && <span className="text-amber-400/70 shrink-0">[{msg.toolName}]</span>}
                        <span className={`${msg.role === 'system' ? 'text-gray-400' : 'text-gray-300'} break-all`}>
                          {msg.content.length > 200 ? msg.content.substring(0, 200) + '...' : msg.content}
                        </span>
                      </div>
                    )
                  )
                )}
              </div>
            </>
          )}

          {/* Running tab content */}
          {activeTab === 'running' && (
            <div
              className="overflow-y-auto overflow-x-hidden px-3 py-2 space-y-1 scrollbar-thin scrollbar-thumb-gray-700 scrollbar-track-transparent bg-gray-900/50"
              style={{ height: drawerHeight }}
            >
              {(() => {
                const flows = backgroundFlows ?? []
                if (flows.length === 0) {
                  return <p className="text-xs text-gray-500 text-center py-2">No background flows</p>
                }
                // Sort: running flows first, completed after
                const sorted = [...flows].sort((a, b) => {
                  if (a.status === 'running' && b.status !== 'running') return -1
                  if (a.status !== 'running' && b.status === 'running') return 1
                  return 0
                })
                return sorted.map((flow) => {
                  const pill = agentPillStyle(flow.agentType)
                  const initials = pill?.initials ?? deriveInitials(flow.agentType)
                  const pillClass = pill?.className ?? 'bg-slate-500/20 text-slate-300 border border-slate-500/30'
                  const isRunning = flow.status === 'running'
                  return (
                    <div
                      key={flow.agentId}
                      className="flex items-center gap-2 rounded-md border border-gray-700/50 bg-gray-800/40 px-2.5 py-1.5"
                    >
                      {/* Agent chip */}
                      <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium whitespace-nowrap shrink-0 ${pillClass}`}>
                        <ProfileAvatar initials={initials} />
                        {flow.agentType}
                      </span>

                      {/* Status */}
                      <span className={`text-[11px] shrink-0 ${isRunning ? 'text-amber-400' : 'text-emerald-400'}`}>
                        {isRunning ? 'running' : 'done'}
                      </span>

                      {/* Truncated artifact — first ~60 chars */}
                      {flow.artifact && (
                        <span className="min-w-0 truncate text-[11px] text-gray-400 flex-1" title={flow.artifact}>
                          {flow.artifact}
                        </span>
                      )}

                      {/* Spacer when no artifact */}
                      {!flow.artifact && <span className="flex-1" />}

                      {/* Stop button — only when running */}
                      {isRunning && (
                        <button
                          onClick={() => onStopDispatch?.(flow.agentId)}
                          title="Stop this flow"
                          className="shrink-0 flex items-center justify-center w-6 h-6 rounded hover:bg-red-500/20 text-gray-500 hover:text-red-400 transition-colors"
                        >
                          <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                            <rect x="6" y="6" width="12" height="12" rx="1" />
                          </svg>
                        </button>
                      )}
                    </div>
                  )
                })
              })()}
            </div>
          )}

          {/* Machine tab content — memory bar + process list (view-only) */}
          {activeTab === 'machine' && (
            <div
              className="overflow-y-auto overflow-x-hidden px-3 py-2 space-y-2 scrollbar-thin scrollbar-thumb-gray-700 scrollbar-track-transparent bg-gray-900/50"
              style={{ height: drawerHeight }}
            >
              {/* Editor row — Codespaces-style status row with lifecycle controls */}
              {(() => {
                const isRunning = ideState === 'running'
                const isStarting = ideState === 'starting'
                const dotColor = isRunning ? 'bg-emerald-400' : isStarting ? 'bg-amber-400 animate-pulse' : 'bg-gray-600'
                const stateLabel = isRunning ? 'Running' : isStarting ? 'Starting…' : 'Stopped'
                const stateLabelColor = isRunning ? 'text-emerald-400' : isStarting ? 'text-amber-400' : 'text-gray-500'
                return (
                  <div className="flex items-center gap-2 rounded-md border border-gray-700/50 bg-gray-800/40 px-2.5 py-2">
                    {/* Status dot */}
                    <span className={`shrink-0 w-2 h-2 rounded-full ${dotColor}`} />
                    {/* Code icon */}
                    <svg className="shrink-0 w-3.5 h-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
                    </svg>
                    {/* Label */}
                    <span className="text-[11px] text-gray-300 font-medium flex-1">Code editor</span>
                    {/* State text */}
                    <span className={`text-[11px] tabular-nums shrink-0 ${stateLabelColor}`}>{stateLabel}</span>
                    {/* Controls */}
                    <span className="flex items-center gap-0.5 shrink-0">
                      {/* Open — starts if stopped, opens URL if running */}
                      <button
                        onClick={onEditorOpen}
                        title={isRunning ? 'Open editor in new tab' : 'Start editor'}
                        disabled={isStarting}
                        className="flex items-center justify-center w-6 h-6 rounded transition-colors text-gray-500 hover:text-gray-200 hover:bg-gray-700/50 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                        </svg>
                      </button>
                      {/* Stop — only when running or starting */}
                      {(isRunning || isStarting) && (
                        <button
                          onClick={onEditorStop}
                          title="Stop editor"
                          className="flex items-center justify-center w-6 h-6 rounded transition-colors text-gray-500 hover:text-red-400 hover:bg-red-500/10"
                        >
                          <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                            <rect x="6" y="6" width="12" height="12" rx="1" />
                          </svg>
                        </button>
                      )}
                      {/* Restart — only when running */}
                      {isRunning && (
                        <button
                          onClick={onEditorRestart}
                          title="Restart editor"
                          className="flex items-center justify-center w-6 h-6 rounded transition-colors text-gray-500 hover:text-amber-400 hover:bg-amber-500/10"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                          </svg>
                        </button>
                      )}
                    </span>
                  </div>
                )
              })()}

              {/* Editor error — shown when ideError is a non-empty string */}
              {ideError && (
                <div className="text-xs text-red-400 px-1 -mt-1">{ideError}</div>
              )}

              {/* Memory bar — prefers the richer agentMemory from /health poll;
                  falls back to memory object carried in the process_list event. */}
              {(() => {
                const mem = agentMemory ?? (machineData?.memory
                  ? { usedMb: machineData.memory.usedMb, totalMb: machineData.memory.totalMb, availableMb: machineData.memory.freeMb, usedPct: Math.round((machineData.memory.usedMb / Math.max(machineData.memory.totalMb, 1)) * 100), processRssMb: 0 }
                  : undefined)
                if (!mem) {
                  return <p className="text-xs text-gray-500 text-center py-2">Waiting for data…</p>
                }
                const barColor = mem.usedPct >= 85 ? 'bg-red-500' : mem.usedPct >= 75 ? 'bg-amber-400' : 'bg-emerald-400'
                const textColor = mem.usedPct >= 85 ? 'text-red-400' : mem.usedPct >= 75 ? 'text-amber-400' : 'text-emerald-400'
                return (
                  <div className="rounded-md border border-gray-700/50 bg-gray-800/40 px-3 py-2 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-gray-400 font-medium">RAM</span>
                      <span className={`text-[11px] font-semibold tabular-nums ${textColor}`}>
                        {mem.usedMb} / {mem.totalMb} MB ({mem.usedPct}%)
                      </span>
                    </div>
                    <div className="w-full h-2 rounded-full bg-gray-700/70 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-700 ${barColor}`}
                        style={{ width: `${Math.min(mem.usedPct, 100)}%` }}
                      />
                    </div>
                    <div className="text-[10px] text-gray-500">
                      Free: {mem.availableMb} MB
                      {mem.processRssMb > 0 && <span className="ml-2">Agent RSS: {mem.processRssMb} MB</span>}
                    </div>
                  </div>
                )
              })()}

              {/* Process list */}
              {!machineData && (
                <p className="text-xs text-gray-500 text-center py-1">Loading processes…</p>
              )}
              {machineData && machineData.processes.length === 0 && (
                <p className="text-xs text-gray-500 text-center py-1">No processes found</p>
              )}
              {machineData && machineData.processes.length > 0 && (() => {
                const maxRss = machineData.processes[0].rssMb || 1
                return (
                  <div className="space-y-0.5">
                    {/* Header row */}
                    <div className="flex items-center gap-2 px-2 py-0.5 text-[10px] text-gray-500 font-medium uppercase tracking-wide">
                      <span className="flex-1">Process</span>
                      <span className="w-10 text-right tabular-nums">PID</span>
                      <span className="w-12 text-right tabular-nums">RSS MB</span>
                      {/* TODO: add kill button per row here once deferred kill feature lands */}
                    </div>
                    {machineData.processes.map((proc) => (
                      <div
                        key={proc.pid}
                        className="flex items-center gap-2 rounded px-2 py-1 hover:bg-gray-800/60 transition-colors"
                      >
                        {/* Proportional bar behind the row — thin stripe on the left */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            {/* Mini proportion bar */}
                            <div className="w-16 h-1 rounded-full bg-gray-700/50 overflow-hidden shrink-0">
                              <div
                                className="h-full rounded-full bg-violet-500/60"
                                style={{ width: `${Math.min((proc.rssMb / maxRss) * 100, 100)}%` }}
                              />
                            </div>
                            <span className="truncate text-[11px] text-gray-300 font-mono" title={proc.name}>
                              {proc.name}
                            </span>
                          </div>
                        </div>
                        <span className="w-10 text-right text-[10px] text-gray-500 tabular-nums shrink-0">
                          {proc.pid}
                        </span>
                        <span className="w-12 text-right text-[11px] text-gray-400 tabular-nums shrink-0">
                          {proc.rssMb}
                        </span>
                        {/* TODO: kill button goes here (deferred fast-follow) */}
                      </div>
                    ))}
                  </div>
                )
              })()}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
