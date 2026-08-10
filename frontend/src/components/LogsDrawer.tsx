'use client'

import React, { useState, useEffect, useRef } from 'react'

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
}

interface LogMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: Date
  toolName?: string
  toolMeta?: ToolMeta
}

interface LogsDrawerProps {
  messages: LogMessage[]
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
    <pre className="mt-1.5 max-h-56 overflow-auto rounded-md bg-gray-950/70 border border-gray-800 p-2 text-[10.5px] leading-relaxed font-mono">
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

function ToolLogCard({ msg }: { msg: LogMessage }) {
  const [open, setOpen] = useState(false)
  const meta = msg.toolMeta!
  const { verb, icon } = toolVisual(meta.tool)
  const running = meta.status === 'running'
  const target = meta.fileName || meta.command || meta.pattern || meta.url || meta.description
  const hasDetail = !!(meta.diff || meta.command || meta.filePath)
  const showStats = (meta.linesAdded ?? 0) > 0 || (meta.linesRemoved ?? 0) > 0

  return (
    <div className="rounded-lg border border-gray-800/70 bg-gray-900/40 overflow-hidden">
      <button
        onClick={() => hasDetail && setOpen((v) => !v)}
        className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left ${hasDetail ? 'hover:bg-gray-800/40' : ''} transition-colors`}
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
        <span className="ml-auto shrink-0 flex items-center gap-1.5">
          {running && (
            <svg className="w-3 h-3 animate-spin text-amber-400/70" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          )}
          {hasDetail && (
            <svg className={`w-3 h-3 text-gray-500 transition-transform ${open ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          )}
        </span>
      </button>
      {open && hasDetail && (
        <div className="px-2.5 pb-2">
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

export function LogsDrawer({ messages }: LogsDrawerProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [lastSeenCount, setLastSeenCount] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)

  const unreadCount = messages.length - lastSeenCount

  useEffect(() => {
    if (isOpen && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
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
        <div
          ref={scrollRef}
          className="max-h-64 overflow-y-auto px-3 py-2 space-y-1 scrollbar-thin scrollbar-thumb-gray-700 scrollbar-track-transparent bg-gray-900/50"
        >
          {messages.length === 0 ? (
            <p className="text-xs text-gray-500 text-center py-2">No activity yet</p>
          ) : (
            messages.map((msg) =>
              msg.toolMeta ? (
                <ToolLogCard key={msg.id} msg={msg} />
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
      )}
    </div>
  )
}
