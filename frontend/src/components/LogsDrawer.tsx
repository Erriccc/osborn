'use client'

import React, { useState, useEffect, useRef, useCallback } from 'react'

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
  }
  const className = colorMap[role] ?? 'bg-slate-500/20 text-slate-300 border border-slate-500/30'
  return { className, initials: deriveInitials(role) }
}

interface LogsDrawerProps {
  messages: LogMessage[]
  onCircleBack?: (noteText: string) => void
  onLike?: (noteText: string) => void
  onDislike?: (noteText: string) => void
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

function ToolLogCard({ msg, onCircleBack, onLike, onDislike }: { msg: LogMessage; onCircleBack?: (noteText: string) => void; onLike?: (noteText: string) => void; onDislike?: (noteText: string) => void }) {
  const [open, setOpen] = useState(false)
  const [liked, setLiked] = useState(false)
  const [disliked, setDisliked] = useState(false)
  const [bookmarked, setBookmarked] = useState(false)
  const [copied, setCopied] = useState(false)
  const meta = msg.toolMeta!
  const { verb, icon } = toolVisual(meta.tool)
  const running = meta.status === 'running'
  const target = meta.fileName || meta.command || meta.pattern || meta.url || meta.description
  const hasDetail = !!(meta.diff || meta.command || meta.filePath)
  const showStats = (meta.linesAdded ?? 0) > 0 || (meta.linesRemoved ?? 0) > 0
  const pill = agentPillStyle(meta.agentRole)

  function toggleLike() {
    const next = !liked
    setLiked(next)
    if (next) {
      setDisliked(false)
      if (onLike) {
        const detail = meta.command || meta.filePath || meta.description || meta.pattern || meta.url || '(no further detail)'
        const noteText = `[liked] The user liked this step: ${verb} ${target ?? '(unknown)'}. Details: ${detail}. Positive signal — keep doing this kind of thing.`
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
        const noteText = `[disliked] The user flagged this step as not what they wanted: ${verb} ${target ?? '(unknown)'}. Details: ${detailStr}. Acknowledge this naturally, and if it was an edit, OFFER to undo/revert it and ask before doing so — do NOT auto-revert.`
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
      const noteText = `[circle-back] The user flagged this step to revisit after the current main objectives: ${verb} ${target ?? '(unknown)'}. Details: ${detailStr}. Acknowledge this naturally in conversation and try to reflect on WHY they might want to revisit it — don't just log it.`
      onCircleBack(noteText)
    }
  }

  function copyRow() {
    // Header: "[Verb] <target>" — mirrors what the card shows visually
    const header = target ? `[${verb}] ${target}` : `[${verb}]`

    // Detail body — only include sections that have data
    const body: string[] = []
    if (meta.filePath && meta.filePath !== target) body.push(meta.filePath)
    if (meta.command) body.push(meta.command)
    if (meta.description && meta.description !== target) body.push(meta.description)
    if (meta.pattern && meta.pattern !== target) body.push(`Pattern: ${meta.pattern}`)
    if (meta.url && meta.url !== target) body.push(`URL: ${meta.url}`)
    if (meta.diff) body.push(meta.diff)

    const text = body.length > 0 ? `${header}\n\n${body.join('\n\n')}` : header

    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => {})
  }

  return (
    <div className="rounded-lg border border-gray-700/60 bg-gray-800/50 overflow-hidden shadow-sm max-w-full">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          onClick={() => hasDetail && setOpen((v) => !v)}
          className={`flex-1 flex items-center gap-2 text-left min-w-0 ${hasDetail ? 'hover:opacity-80' : ''} transition-opacity`}
        >
          <span className={`shrink-0 ${running ? 'text-amber-400' : 'text-gray-400'}`}>{icon}</span>
          <span className="shrink-0 text-[11px] font-semibold text-gray-200">{verb}</span>
          {target && (
            <span className="min-w-0 truncate font-mono text-[11px] text-amber-300/90">{target}</span>
          )}
          {meta.editCount && meta.editCount > 1 && (
            <span className="shrink-0 text-[10px] text-gray-500">·{meta.editCount} edits</span>
          )}
          {showStats && (
            <span className="shrink-0 flex items-center gap-1 text-[10px] font-mono">
              {(meta.linesAdded ?? 0) > 0 && <span className="text-emerald-400">+{meta.linesAdded}</span>}
              {(meta.linesRemoved ?? 0) > 0 && <span className="text-red-400">-{meta.linesRemoved}</span>}
            </span>
          )}
        </button>

        {/* Right-side controls */}
        <span className="shrink-0 flex items-center gap-1">
          {/* Agent role chip — profile avatar + role name on colored background */}
          {pill && (
            <span title={meta.agentRole} className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium whitespace-nowrap ${pill.className}`}>
              <ProfileAvatar initials={pill.initials} />
              {meta.agentRole}
            </span>
          )}

          {/* Action buttons — always visible */}
          <span className="flex items-center gap-0.5">
            {/* Copy button */}
            <button
              onClick={copyRow}
              title="Copy"
              className="flex items-center justify-center w-8 h-8 rounded transition-colors text-gray-500 hover:text-gray-300 hover:bg-gray-700/50"
            >
              {copied ? (
                <svg className="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              )}
            </button>

            {/* Like/heart button */}
            <button
              onClick={toggleLike}
              title={liked ? 'Unlike' : 'Like'}
              className={`flex items-center justify-center w-8 h-8 rounded transition-colors hover:bg-gray-700/50 ${liked ? 'text-pink-400' : 'text-gray-500 hover:text-pink-400'}`}
            >
              <svg className="w-4 h-4" fill={liked ? 'currentColor' : 'none'} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
              </svg>
            </button>

            {/* Dislike/thumbs-down button */}
            <button
              onClick={toggleDislike}
              title={disliked ? 'Remove dislike' : 'Dislike'}
              className={`flex items-center justify-center w-8 h-8 rounded transition-colors hover:bg-gray-700/50 ${disliked ? 'text-red-400' : 'text-gray-500 hover:text-red-400'}`}
            >
              <svg className="w-4 h-4" fill={disliked ? 'currentColor' : 'none'} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 14H5.236a2 2 0 01-1.789-2.894l3.5-7A2 2 0 018.736 3h4.018a2 2 0 01.485.06l3.76.94m-7 10v5a2 2 0 002 2h.096c.5 0 .905-.405.905-.904 0-.715.211-1.413.608-2.008L17 13V4m-7 10h2m5-10h2a2 2 0 012 2v6a2 2 0 01-2 2h-2.5" />
              </svg>
            </button>

            {/* Bookmark / circle-back button */}
            <button
              onClick={toggleBookmark}
              title={bookmarked ? 'Remove circle-back' : 'Circle back to this'}
              className={`flex items-center justify-center w-8 h-8 rounded transition-colors hover:bg-gray-700/50 ${bookmarked ? 'text-amber-400' : 'text-gray-500 hover:text-amber-400'}`}
            >
              <svg className="w-4 h-4" fill={bookmarked ? 'currentColor' : 'none'} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
              </svg>
            </button>
          </span>

          {running && (
            <svg className="w-3.5 h-3.5 animate-spin text-amber-400/70 ml-0.5" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          )}
          {hasDetail && (
            <button
              onClick={() => setOpen((v) => !v)}
              className="flex items-center justify-center w-6 h-6 rounded hover:bg-gray-700/50 transition-colors"
            >
              <svg className={`w-3.5 h-3.5 text-gray-500 transition-transform ${open ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          )}
        </span>
      </div>
      {open && hasDetail && (
        <div className="px-3 pb-2.5">
          {meta.filePath && (
            <div className="text-[10px] font-mono text-gray-500 break-all">{meta.filePath}</div>
          )}
          {meta.command && !meta.diff && (
            <pre className="mt-1.5 max-h-40 overflow-auto rounded-md bg-gray-950/70 border border-gray-800 p-2 text-[10.5px] leading-relaxed font-mono text-gray-300 whitespace-pre-wrap">{meta.command}</pre>
          )}
          {meta.diff && <DiffView diff={meta.diff} />}
        </div>
      )}
    </div>
  )
}

export function LogsDrawer({ messages, onCircleBack, onLike, onDislike }: LogsDrawerProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [lastSeenCount, setLastSeenCount] = useState(0)
  const [showJumpPill, setShowJumpPill] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const isAtBottomRef = useRef(true)

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
    if (isOpen && scrollRef.current) {
      // Only auto-scroll to the newest entry when the user is already at/near
      // the bottom. If they have scrolled up to read history, leave them there.
      if (isAtBottomRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      } else {
        // New entry arrived while scrolled up — show the jump pill.
        setShowJumpPill(true)
      }
      setLastSeenCount(messages.length)
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

      {/* Collapsible log panel */}
      {isOpen && (
        <div className="relative">
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
            className="max-h-64 overflow-y-auto overflow-x-hidden px-3 py-2 space-y-1 scrollbar-thin scrollbar-thumb-gray-700 scrollbar-track-transparent bg-gray-900/50"
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
        </div>
      )}
    </div>
  )
}
