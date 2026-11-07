'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { MessageBubble } from './MessageBubble'
import type { ChatMessage, SpeakingChunk } from './shared'

// Suggestion prompts (AI SDK style)
const SUGGESTIONS = [
  { icon: '📁', text: 'What files are in this project?' },
  { icon: '🔧', text: 'Fix the TypeScript errors' },
  { icon: '📝', text: 'Explain this codebase' },
  { icon: '🧪', text: 'Run the tests' },
]

export function ChatPanel({
  messages,
  onSuggestionClick,
  activeResearch,
  speakingChunk,
  onCopy,
  onLike,
  onIgnore,
  onReplay,
  likedIds,
}: {
  messages: ChatMessage[]
  onSuggestionClick?: (text: string) => void
  activeResearch?: { taskId: string; task: string; toolCount: number } | null
  speakingChunk?: SpeakingChunk | null
  onCopy?: (msg: ChatMessage) => void
  onLike?: (msg: ChatMessage) => void
  onIgnore?: (msg: ChatMessage) => void
  onReplay?: (msg: ChatMessage) => void
  likedIds?: Set<string>
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const isAtBottomRef = useRef(true)
  const [showJumpPill, setShowJumpPill] = useState(false)
  const [showSpeakingPill, setShowSpeakingPill] = useState(false)
  const showSpeakingPillRef = useRef(false)
  const speakingElRef = useRef<HTMLElement | null>(null)

  // Track whether the user is near the bottom of the scroll container.
  // We update this synchronously on every scroll event so the auto-scroll
  // effect below can decide whether to snap without an extra render cycle.
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    isAtBottomRef.current = isAtBottom
    if (isAtBottom) setShowJumpPill(false)
    // Dismiss speaking pill if the user has scrolled the highlighted bubble into view
    if (speakingElRef.current && showSpeakingPillRef.current) {
      const containerRect = el.getBoundingClientRect()
      const elRect = speakingElRef.current.getBoundingClientRect()
      if (elRect.top >= containerRect.top && elRect.bottom <= containerRect.bottom) {
        setShowSpeakingPill(false)
      }
    }
  }, [])

  useEffect(() => {
    // Only auto-scroll when the user is already at (or very near) the bottom.
    // If they have scrolled up to read history, leave them there.
    if (scrollRef.current && isAtBottomRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    } else if (!isAtBottomRef.current) {
      // New content arrived while scrolled up — show the jump pill.
      setShowJumpPill(true)
    }
  }, [messages, activeResearch])

  // Show "scroll to speaking" pill when the highlighted span is off-screen
  useEffect(() => {
    if (!speakingChunk) {
      showSpeakingPillRef.current = false
      setShowSpeakingPill(false)
      speakingElRef.current = null
      return
    }
    const container = scrollRef.current
    if (!container) return
    // Find the bubble by messageId (scoped to avoid grabbing the wrong bubble)
    const msgEl = container.querySelector(`[data-message-id="${speakingChunk.messageId}"]`) as HTMLElement | null
    speakingElRef.current = msgEl
    if (!msgEl) {
      showSpeakingPillRef.current = false
      setShowSpeakingPill(false)
      return
    }
    const containerRect = container.getBoundingClientRect()
    const elRect = msgEl.getBoundingClientRect()
    const isVisible = elRect.top >= containerRect.top && elRect.bottom <= containerRect.bottom
    showSpeakingPillRef.current = !isVisible
    setShowSpeakingPill(!isVisible)
  }, [speakingChunk])

  return (
    <div className="flex-1 relative min-h-0">
      {showJumpPill && (
        <button
          onClick={() => {
            if (scrollRef.current) {
              scrollRef.current.scrollTop = scrollRef.current.scrollHeight
            }
            isAtBottomRef.current = true
            setShowJumpPill(false)
          }}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 min-h-9 px-3.5 py-1.5 rounded-full bg-amber-500/90 hover:bg-amber-400/90 text-gray-900 text-xs font-semibold shadow-lg backdrop-blur-sm transition-colors"
        >
          Jump to latest
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      )}
      {showSpeakingPill && (
        <button
          onClick={() => {
            // Nudge only — does NOT force-scroll, does NOT set isAtBottomRef
            speakingElRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
          }}
          className="absolute top-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 min-h-9 px-3.5 py-1.5 rounded-full bg-amber-500/80 hover:bg-amber-400/80 text-gray-900 text-xs font-semibold shadow-lg backdrop-blur-sm transition-colors"
        >
          Now speaking
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
          </svg>
        </button>
      )}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto overflow-x-hidden px-3 sm:px-4 py-3 scrollbar-thin scrollbar-thumb-gray-700 scrollbar-track-transparent"
      >
      {messages.length === 0 && !activeResearch && (
        <div className="flex flex-col items-center justify-center h-full text-center px-4">
          {/* Logo / Icon */}
          <div className="relative mb-6">
            <div className="absolute inset-0 rounded-full bg-amber-500/20 blur-xl" />
            <div className="relative w-20 h-20 rounded-full bg-gradient-to-br from-amber-500 to-amber-600 flex items-center justify-center shadow-lg">
              <svg className="w-10 h-10 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
            </div>
          </div>

          {/* Welcome text */}
          <h2 className="text-xl font-semibold text-white mb-2">
            Hi! I'm Osborn
          </h2>
          <p className="text-gray-400 text-sm mb-6 max-w-xs">
            Your AI coding assistant. Speak or type to get started.
          </p>

          {/* Suggestions grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-sm">
            {SUGGESTIONS.map((suggestion, idx) => (
              <button
                key={idx}
                onClick={() => onSuggestionClick?.(suggestion.text)}
                className="flex items-center gap-2 p-3 bg-gray-800/50 hover:bg-gray-700/50 border border-gray-700/50 hover:border-amber-500/30 rounded-xl transition-all text-left group"
              >
                <span className="text-lg">{suggestion.icon}</span>
                <span className="text-xs text-gray-300 group-hover:text-white transition-colors line-clamp-2">
                  {suggestion.text}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
      {/* Reading column — full width on phone/tablet, centered 3xl at lg+ so
          lines stop running 180 chars on wide monitors (Slack/Claude width). */}
      <div className="w-full lg:max-w-3xl lg:mx-auto space-y-1">
      {(() => {
        const shown = messages.filter(m => m.category !== 'log')
        return shown.map((msg, i) => {
          // Slack-style grouping: show the avatar + sender name only on the
          // FIRST message of a run from the same sender (same role + kind).
          // System notices and fast-brain log lines never group.
          const prev = shown[i - 1]
          const kind = (m: ChatMessage) => m.role === 'system' ? 'system' : m.toolName === 'fast-brain' ? 'fast' : m.role
          const grouped = !!prev && prev.role !== 'system' && msg.role !== 'system'
            && msg.toolName !== 'fast-brain' && prev.toolName !== 'fast-brain'
            && kind(prev) === kind(msg)
          return (
            <MessageBubble
              key={msg.id}
              message={msg}
              grouped={grouped}
              speakingChunk={speakingChunk}
              onCopy={() => onCopy?.(msg)}
              onLike={() => onLike?.(msg)}
              onIgnore={() => onIgnore?.(msg)}
              onReplay={() => onReplay?.(msg)}
              isLiked={likedIds?.has(msg.id)}
            />
          )
        })
      })()}
      </div>
      {/* Inline research tracking spinner */}
      {activeResearch && (
        <div className="flex items-start gap-3 px-2">
          <div className="w-8 h-8 rounded-full bg-amber-500/20 flex items-center justify-center shrink-0 mt-0.5">
            <svg className="w-4 h-4 text-amber-400 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-gray-300">
              Researching: <span className="text-amber-300">{activeResearch.task}</span>
            </p>
            <p className="text-xs text-gray-500 mt-0.5">
              {activeResearch.toolCount} tool{activeResearch.toolCount !== 1 ? 's' : ''} used
            </p>
          </div>
        </div>
      )}
    </div>
    </div>
  )
}
