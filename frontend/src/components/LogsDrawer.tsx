'use client'

import React, { useState, useEffect, useRef } from 'react'

interface LogMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: Date
  toolName?: string
}

interface LogsDrawerProps {
  messages: LogMessage[]
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
          <span>Logs</span>
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
          className="max-h-48 overflow-y-auto px-4 py-2 space-y-1 scrollbar-thin scrollbar-thumb-gray-700 scrollbar-track-transparent bg-gray-900/50"
        >
          {messages.length === 0 ? (
            <p className="text-xs text-gray-500 text-center py-2">No logs yet</p>
          ) : (
            messages.map((msg) => (
              <div key={msg.id} className="flex items-start gap-2 text-xs">
                <span className="text-gray-500 shrink-0 font-mono">
                  {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
                {msg.toolName && (
                  <span className="text-amber-400/70 shrink-0">[{msg.toolName}]</span>
                )}
                <span className={`${
                  msg.role === 'system' ? 'text-gray-400' : 'text-gray-300'
                } break-all`}>
                  {msg.content.length > 200 ? msg.content.substring(0, 200) + '...' : msg.content}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
