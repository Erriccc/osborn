'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useVoiceAssistant,
  BarVisualizer,
  useDataChannel,
  useLocalParticipant,
} from '@livekit/components-react'
import '@livekit/components-styles'
import { MarkdownMessage } from './MarkdownMessage'
import { uploadFile, isSupabaseConfigured, type UploadResult } from '../lib/supabase'

interface VoiceRoomProps {
  token: string
  onDisconnect?: () => void
  onAgentReady?: () => void
  waitingMode?: boolean
  provider?: string
}

// Message parts inspired by AI SDK - supports streaming, tool calls, reasoning
interface MessagePart {
  type: 'text' | 'tool-call' | 'tool-result' | 'reasoning' | 'code'
  content: string
  toolName?: string
  status?: 'pending' | 'running' | 'completed' | 'error'
  language?: string
}

interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: Date
  toolName?: string
  parts?: MessagePart[]
  isStreaming?: boolean
}

interface PermissionRequest {
  toolName: string
  description: string
}

// Streaming indicator dots
function StreamingDots() {
  return (
    <span className="inline-flex gap-1 ml-1">
      <span className="w-1.5 h-1.5 bg-violet-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
      <span className="w-1.5 h-1.5 bg-violet-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
      <span className="w-1.5 h-1.5 bg-violet-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
    </span>
  )
}

// Collapsible reasoning block (AI SDK style)
function ReasoningBlock({ content, isStreaming }: { content: string; isStreaming?: boolean }) {
  const [isExpanded, setIsExpanded] = useState(isStreaming ?? true)

  // Auto-collapse when streaming ends
  useEffect(() => {
    if (!isStreaming && isExpanded) {
      const timer = setTimeout(() => setIsExpanded(false), 1000)
      return () => clearTimeout(timer)
    }
  }, [isStreaming, isExpanded])

  return (
    <div className="mb-2">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-2 text-xs text-violet-400 hover:text-violet-300 transition-colors"
      >
        <svg
          className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        <span className="flex items-center gap-1.5">
          {isStreaming && <span className="w-2 h-2 bg-violet-400 rounded-full animate-pulse" />}
          Reasoning
        </span>
      </button>
      {isExpanded && (
        <div className="mt-2 pl-4 border-l-2 border-violet-500/30">
          <p className="text-xs text-gray-400 italic whitespace-pre-wrap">{content}</p>
        </div>
      )}
    </div>
  )
}

// Tool call visualization (AI SDK style)
function ToolCallBlock({ toolName, status, content }: { toolName: string; status?: string; content?: string }) {
  const statusConfig: Record<string, { color: string; icon: JSX.Element }> = {
    pending: {
      color: 'text-gray-400',
      icon: <span className="w-2 h-2 bg-gray-400 rounded-full" />,
    },
    running: {
      color: 'text-amber-400',
      icon: <span className="w-2 h-2 bg-amber-400 rounded-full animate-pulse" />,
    },
    completed: {
      color: 'text-green-400',
      icon: (
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      ),
    },
    error: {
      color: 'text-red-400',
      icon: (
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      ),
    },
  }

  const { color, icon } = statusConfig[status || 'pending'] || statusConfig.pending

  return (
    <div className="my-2 p-2.5 bg-gray-800/60 rounded-lg border border-gray-700/50">
      <div className={`flex items-center gap-2 text-xs ${color}`}>
        {icon}
        <span className="font-mono font-medium">{toolName}</span>
        {status === 'running' && <StreamingDots />}
      </div>
      {content && (
        <p className="mt-1.5 text-xs text-gray-400 font-mono truncate">{content}</p>
      )}
    </div>
  )
}

// Parse message content to extract reasoning/thinking blocks
function parseMessageParts(content: string): MessagePart[] {
  // Safety check - if content is empty or undefined, return empty array
  if (!content || typeof content !== 'string') {
    console.warn('⚠️ parseMessageParts: empty or invalid content')
    return []
  }

  const parts: MessagePart[] = []
  let remainingContent = content.trim()

  // Only extract reasoning blocks if they have explicit "Reasoning:" or "Thinking:" labels
  const reasoningMatch = remainingContent.match(/\*\*(Reasoning|Thinking|Planning):\*\*\s*\n+([\s\S]*?)(?=\n\n\*\*|$)/i)
  if (reasoningMatch && reasoningMatch[2]?.trim()) {
    parts.push({ type: 'reasoning', content: reasoningMatch[2].trim() })
    remainingContent = remainingContent.replace(reasoningMatch[0], '').trim()
  }

  // Strip ONLY lines that are purely bold headers (like "**Some Header**\n")
  // Keep content on the same line as headers
  remainingContent = remainingContent
    .split('\n')
    .map(line => {
      // If line is ONLY a bold header with nothing else, remove it
      const isBoldOnlyLine = /^\s*\*\*[^*]+\*\*\s*$/.test(line)
      return isBoldOnlyLine ? '' : line
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n') // Collapse multiple newlines
    .trim()

  // Always include remaining content as text
  if (remainingContent) {
    parts.push({ type: 'text', content: remainingContent })
  }

  // Final safety: if we have no parts but original content existed, use it
  if (parts.length === 0 && content.trim()) {
    parts.push({ type: 'text', content: content.trim() })
  }

  return parts
}

// Modern chat message bubble with parts support
function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'

  // Debug: log message being rendered
  console.log(`🎨 Rendering MessageBubble: role=${message.role}, contentLength=${message.content?.length}, content="${message.content?.substring(0, 60)}..."`)

  // Parse content into parts for assistant messages
  const parts = useMemo(() => {
    if (message.role === 'assistant' && !message.parts) {
      const parsed = parseMessageParts(message.content)
      // Debug: log what we parsed
      console.log(`🔍 Parsed assistant message: "${message.content?.substring(0, 50)}..." → ${parsed.length} parts:`, parsed.map(p => ({ type: p.type, len: p.content?.length, preview: p.content?.substring(0, 30) })))
      return parsed
    }
    return message.parts || [{ type: 'text' as const, content: message.content }]
  }, [message])

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} group`}>
      {/* Avatar for assistant */}
      {!isUser && !isSystem && (
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center mr-2 mt-1 shrink-0 shadow-lg">
          <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
        </div>
      )}

      <div
        className={`max-w-[80%] rounded-2xl px-4 py-2.5 shadow-md transition-all ${
          isUser
            ? 'bg-gradient-to-r from-blue-500 to-blue-600 text-white rounded-br-md'
            : isSystem
            ? 'bg-amber-500/10 text-amber-200 border border-amber-500/30 rounded-bl-md'
            : 'bg-gray-800/80 text-gray-100 border border-gray-700/50 rounded-bl-md backdrop-blur-sm'
        } ${message.isStreaming ? 'ring-2 ring-violet-500/30' : ''}`}
      >
        {/* Tool name badge */}
        {message.toolName && (
          <ToolCallBlock
            toolName={message.toolName}
            status={message.isStreaming ? 'running' : 'completed'}
          />
        )}

        {/* Render parts */}
        {message.role === 'assistant' ? (
          <div className="space-y-2">
            {parts.length > 0 ? (
              parts.map((part, idx) => {
                if (part.type === 'reasoning') {
                  return <ReasoningBlock key={idx} content={part.content} isStreaming={message.isStreaming} />
                }
                if (part.type === 'tool-call') {
                  return <ToolCallBlock key={idx} toolName={part.toolName || 'tool'} status={part.status} content={part.content} />
                }
                // Ensure we have content to render
                if (part.content && part.content.trim()) {
                  // Debug: log what we're rendering
                  console.log(`🖼️ Rendering text part with content: "${part.content.substring(0, 50)}..."`)
                  // Check if content has markdown formatting
                  const hasMarkdown = /[*#`\[\]]/.test(part.content)
                  if (hasMarkdown) {
                    return <MarkdownMessage key={idx} content={part.content} />
                  }
                  // Simple text - render directly without Markdown processing
                  return (
                    <p key={idx} className="text-sm leading-relaxed whitespace-pre-wrap text-gray-100">
                      {part.content}
                    </p>
                  )
                }
                return null
              })
            ) : (
              // Fallback: render raw content if parts parsing failed
              <p className="text-sm leading-relaxed whitespace-pre-wrap">{message.content}</p>
            )}
            {/* Extra fallback: if all parts were empty, show raw content */}
            {parts.length > 0 && parts.every(p => !p.content?.trim()) && message.content?.trim() && (
              <p className="text-sm leading-relaxed whitespace-pre-wrap">{message.content}</p>
            )}
            {message.isStreaming && <StreamingDots />}
          </div>
        ) : (
          <p className="text-sm leading-relaxed whitespace-pre-wrap">{message.content}</p>
        )}

        {/* Timestamp */}
        <div className="flex items-center gap-2 mt-1.5">
          <p className="text-[10px] opacity-40 select-none">
            {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </p>
          {message.isStreaming && (
            <span className="text-[10px] text-violet-400">streaming</span>
          )}
        </div>
      </div>

      {/* Avatar for user */}
      {isUser && (
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-cyan-500 flex items-center justify-center ml-2 mt-1 shrink-0 shadow-lg">
          <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
          </svg>
        </div>
      )}
    </div>
  )
}

// Suggestion prompts (AI SDK style)
const SUGGESTIONS = [
  { icon: '📁', text: 'What files are in this project?' },
  { icon: '🔧', text: 'Fix the TypeScript errors' },
  { icon: '📝', text: 'Explain this codebase' },
  { icon: '🧪', text: 'Run the tests' },
]

function ChatPanel({
  messages,
  onSuggestionClick,
}: {
  messages: ChatMessage[]
  onSuggestionClick?: (text: string) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto px-4 py-4 space-y-4 scrollbar-thin scrollbar-thumb-gray-700 scrollbar-track-transparent"
    >
      {messages.length === 0 && (
        <div className="flex flex-col items-center justify-center h-full text-center px-4">
          {/* Logo / Icon */}
          <div className="relative mb-6">
            <div className="absolute inset-0 rounded-full bg-violet-500/20 blur-xl" />
            <div className="relative w-20 h-20 rounded-full bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center shadow-lg">
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
          <div className="grid grid-cols-2 gap-2 w-full max-w-sm">
            {SUGGESTIONS.map((suggestion, idx) => (
              <button
                key={idx}
                onClick={() => onSuggestionClick?.(suggestion.text)}
                className="flex items-center gap-2 p-3 bg-gray-800/50 hover:bg-gray-700/50 border border-gray-700/50 hover:border-violet-500/30 rounded-xl transition-all text-left group"
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
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}
    </div>
  )
}

interface AttachedFile {
  file: File
  preview?: string
  type: 'image' | 'file'
  uploadStatus?: 'pending' | 'uploading' | 'uploaded' | 'error'
  uploadedUrl?: string
  uploadError?: string
}

function TextInput({
  onSend,
  attachedFiles,
  onAttachFile,
  onRemoveFile,
}: {
  onSend: (text: string, files?: AttachedFile[]) => void
  attachedFiles: AttachedFile[]
  onAttachFile: (files: FileList) => void
  onRemoveFile: (index: number) => void
}) {
  const [text, setText] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (text.trim() || attachedFiles.length > 0) {
      onSend(text.trim(), attachedFiles.length > 0 ? attachedFiles : undefined)
      setText('')
    }
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onAttachFile(e.target.files)
    }
    e.target.value = ''
  }

  return (
    <div className="border-t border-gray-800/50 bg-gray-900/50 backdrop-blur-sm">
      {/* Attached files preview */}
      {attachedFiles.length > 0 && (
        <div className="flex gap-2 p-3 pb-0 overflow-x-auto">
          {attachedFiles.map((af, idx) => (
            <div key={idx} className="relative group shrink-0">
              {af.type === 'image' && af.preview ? (
                <img
                  src={af.preview}
                  alt={af.file.name}
                  className={`h-14 w-14 object-cover rounded-lg border shadow-md ${
                    af.uploadStatus === 'uploaded' ? 'border-green-500' :
                    af.uploadStatus === 'uploading' ? 'border-yellow-500 animate-pulse' :
                    af.uploadStatus === 'error' ? 'border-red-500' : 'border-gray-700'
                  }`}
                />
              ) : (
                <div className={`h-14 w-14 bg-gray-800 rounded-lg border flex items-center justify-center shadow-md ${
                  af.uploadStatus === 'uploaded' ? 'border-green-500' :
                  af.uploadStatus === 'uploading' ? 'border-yellow-500 animate-pulse' :
                  af.uploadStatus === 'error' ? 'border-red-500' : 'border-gray-700'
                }`}>
                  <svg className="w-6 h-6 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                </div>
              )}
              {/* Upload status indicator */}
              {af.uploadStatus === 'uploading' && (
                <div className="absolute inset-0 bg-black/50 rounded-lg flex items-center justify-center">
                  <svg className="w-5 h-5 text-white animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                </div>
              )}
              {af.uploadStatus === 'uploaded' && (
                <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-green-500 rounded-full flex items-center justify-center">
                  <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
              )}
              {af.uploadStatus === 'error' && (
                <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-red-500 rounded-full flex items-center justify-center" title={af.uploadError}>
                  <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </div>
              )}
              <button
                onClick={() => onRemoveFile(idx)}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-500 rounded-full text-white text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-md hover:bg-red-600"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex items-center gap-2 p-3">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,.pdf,.txt,.md,.json,.ts,.tsx,.js,.jsx,.py,.go,.rs,.java,.c,.cpp,.h"
          onChange={handleFileSelect}
          className="hidden"
        />

        {/* Attach button */}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="p-2.5 text-gray-400 hover:text-gray-200 hover:bg-gray-800 rounded-xl transition-all"
          title="Attach file"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
          </svg>
        </button>

        {/* Text input */}
        <div className="flex-1 relative">
          <input
            ref={inputRef}
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type a message..."
            className="w-full bg-gray-800/50 text-white px-4 py-2.5 rounded-xl border border-gray-700/50 focus:border-violet-500/50 focus:ring-2 focus:ring-violet-500/20 focus:outline-none transition-all placeholder:text-gray-500"
          />
        </div>

        {/* Send button */}
        <button
          type="submit"
          disabled={!text.trim() && attachedFiles.length === 0}
          className="p-2.5 bg-gradient-to-r from-violet-500 to-purple-600 hover:from-violet-600 hover:to-purple-700 disabled:from-gray-700 disabled:to-gray-700 disabled:cursor-not-allowed rounded-xl transition-all shadow-lg disabled:shadow-none"
        >
          <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
          </svg>
        </button>
      </form>
    </div>
  )
}

function PermissionModal({
  permission,
  onRespond,
}: {
  permission: PermissionRequest
  onRespond: (response: 'allow' | 'deny' | 'always_allow') => void
}) {
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 rounded-2xl p-6 max-w-md w-full border border-gray-700/50 shadow-2xl">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center">
            <svg className="w-5 h-5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <div>
            <h3 className="text-lg font-semibold text-white">Permission Required</h3>
            <p className="text-gray-400 text-sm">Claude needs your approval</p>
          </div>
        </div>

        <div className="mb-5">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs text-gray-500 uppercase tracking-wide">Tool</span>
            <span className="px-2 py-0.5 bg-violet-500/20 text-violet-300 text-sm font-mono rounded-md">
              {permission.toolName}
            </span>
          </div>
          <div className="bg-gray-800/50 rounded-xl p-3 border border-gray-700/50">
            <p className="text-gray-300 text-sm font-mono leading-relaxed">
              {permission.description}
            </p>
          </div>
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => onRespond('deny')}
            className="flex-1 px-4 py-2.5 bg-gray-800 hover:bg-gray-700 rounded-xl transition-colors text-gray-300 font-medium border border-gray-700"
          >
            Deny
          </button>
          <button
            onClick={() => onRespond('allow')}
            className="flex-1 px-4 py-2.5 bg-green-600 hover:bg-green-500 rounded-xl transition-colors text-white font-medium shadow-lg shadow-green-500/20"
          >
            Allow
          </button>
          <button
            onClick={() => onRespond('always_allow')}
            className="flex-1 px-4 py-2.5 bg-gradient-to-r from-violet-500 to-purple-600 hover:from-violet-600 hover:to-purple-700 rounded-xl transition-all text-white font-medium shadow-lg shadow-violet-500/20"
          >
            Always
          </button>
        </div>

        <p className="text-gray-500 text-xs mt-4 text-center">
          You can also respond by voice: "allow", "deny", or "always allow"
        </p>
      </div>
    </div>
  )
}

// Modern status indicator
function StatusIndicator({ state, isMuted }: { state: string; isMuted: boolean }) {
  const config: Record<string, { gradient: string; icon: JSX.Element; label: string; pulse?: boolean }> = {
    listening: {
      gradient: 'from-green-400 to-emerald-500',
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
        </svg>
      ),
      label: 'Listening',
      pulse: true,
    },
    thinking: {
      gradient: 'from-amber-400 to-orange-500',
      icon: (
        <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
      ),
      label: 'Thinking',
    },
    speaking: {
      gradient: 'from-blue-400 to-cyan-500',
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
        </svg>
      ),
      label: 'Speaking',
    },
    idle: {
      gradient: 'from-gray-400 to-gray-500',
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ),
      label: 'Ready',
    },
  }

  const { gradient, icon, label, pulse } = config[state] || config.idle

  return (
    <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full bg-gradient-to-r ${gradient} shadow-lg`}>
      <span className={pulse ? 'animate-pulse' : ''}>{icon}</span>
      <span className="text-sm font-medium text-white">{label}</span>
      {isMuted && (
        <span className="text-xs bg-red-500/30 px-1.5 py-0.5 rounded text-red-200">Muted</span>
      )}
    </div>
  )
}

// Voice visualizer with modern design
type AgentState = 'disconnected' | 'connecting' | 'initializing' | 'listening' | 'thinking' | 'speaking'

function VoiceVisualizer({ state, audioTrack }: { state: string; audioTrack: any }) {
  // Map state to valid AgentState for BarVisualizer
  const visualizerState: AgentState = ['listening', 'thinking', 'speaking'].includes(state)
    ? (state as AgentState)
    : 'disconnected'

  return (
    <div className="relative">
      {/* Glow effect */}
      <div className={`absolute inset-0 rounded-2xl blur-xl transition-opacity duration-300 ${
        state === 'speaking' ? 'bg-blue-500/30 opacity-100' :
        state === 'listening' ? 'bg-green-500/20 opacity-100' : 'opacity-0'
      }`} />

      {/* Visualizer container */}
      <div className="relative h-16 w-32 bg-gray-800/50 rounded-2xl border border-gray-700/50 flex items-center justify-center overflow-hidden backdrop-blur-sm">
        <BarVisualizer
          state={visualizerState}
          trackRef={audioTrack}
          barCount={7}
          options={{ minHeight: 4 }}
        />
      </div>
    </div>
  )
}

// Inner component with LiveKit hooks
function VoiceRoomInner({
  onDisconnect,
  onAgentReady,
  waitingMode,
}: {
  onDisconnect?: () => void
  onAgentReady?: () => void
  waitingMode?: boolean
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null)
  const [agentConnected, setAgentConnected] = useState(false)
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([])
  const [agentState, setAgentState] = useState<string>('idle')
  const [isMuted, setIsMuted] = useState(false)

  const { localParticipant } = useLocalParticipant()

  const toggleMute = useCallback(async () => {
    if (localParticipant) {
      const newMuted = !isMuted
      await localParticipant.setMicrophoneEnabled(!newMuted)
      setIsMuted(newMuted)
    }
  }, [localParticipant, isMuted])

  const handleAttachFile = useCallback(async (files: FileList) => {
    const newFiles: AttachedFile[] = Array.from(files).map((file) => {
      const isImage = file.type.startsWith('image/')
      return {
        file,
        type: isImage ? 'image' : 'file',
        preview: isImage ? URL.createObjectURL(file) : undefined,
        uploadStatus: 'pending' as const,
      }
    })

    // Add files immediately with pending status
    setAttachedFiles((prev) => [...prev, ...newFiles])

    // Upload to Supabase if configured
    if (isSupabaseConfigured()) {
      for (let i = 0; i < newFiles.length; i++) {
        const fileToUpload = newFiles[i]
        const fileIndex = i

        // Update status to uploading
        setAttachedFiles((prev) => prev.map((f, idx) =>
          idx === prev.length - newFiles.length + fileIndex
            ? { ...f, uploadStatus: 'uploading' as const }
            : f
        ))

        try {
          const result = await uploadFile(fileToUpload.file, fileToUpload.type === 'image' ? 'images' : 'files')

          setAttachedFiles((prev) => prev.map((f, idx) =>
            idx === prev.length - newFiles.length + fileIndex
              ? {
                  ...f,
                  uploadStatus: result.success ? 'uploaded' as const : 'error' as const,
                  uploadedUrl: result.url,
                  uploadError: result.error,
                }
              : f
          ))
        } catch (err) {
          setAttachedFiles((prev) => prev.map((f, idx) =>
            idx === prev.length - newFiles.length + fileIndex
              ? { ...f, uploadStatus: 'error' as const, uploadError: (err as Error).message }
              : f
          ))
        }
      }
    }
  }, [])

  const handleRemoveFile = useCallback((index: number) => {
    setAttachedFiles((prev) => {
      const file = prev[index]
      if (file.preview) URL.revokeObjectURL(file.preview)
      return prev.filter((_, i) => i !== index)
    })
  }, [])

  const { state, audioTrack } = useVoiceAssistant()

  useEffect(() => {
    if (state === 'listening' || state === 'speaking' || state === 'thinking') {
      if (!agentConnected) {
        setAgentConnected(true)
        onAgentReady?.()
      }
    }
  }, [state, agentConnected, onAgentReady])

  const { send: sendToAgent } = useDataChannel('user-input')

  // Track recent messages to prevent duplicates (keep last 5 per role)
  const recentMessagesRef = useRef<{ user: string[]; assistant: string[]; system: string[] }>({
    user: [],
    assistant: [],
    system: [],
  })

  // Stable refs for callbacks to avoid re-subscription issues
  const onAgentReadyRef = useRef(onAgentReady)
  onAgentReadyRef.current = onAgentReady

  const addMessageRef = useRef<(role: ChatMessage['role'], content: string, toolName?: string) => void>()

  // addMessage function with duplicate detection
  addMessageRef.current = useCallback((role: ChatMessage['role'], content: string, toolName?: string) => {
    console.log(`📥 addMessage called: role=${role}, contentLength=${content?.length}, content="${content?.substring(0, 80)}..."`)

    // Safety check
    if (!content || typeof content !== 'string') {
      console.error(`❌ addMessage: invalid content for ${role}:`, content)
      return
    }

    // Normalize content for comparison (trim, normalize whitespace)
    const normalizedContent = content.trim().replace(/\s+/g, ' ')

    // Check if this exact content was sent recently (within last 5 messages of this role)
    const recentOfRole = recentMessagesRef.current[role]
    if (recentOfRole.includes(normalizedContent)) {
      console.log(`⏭️ Skipping duplicate ${role} message: "${normalizedContent.substring(0, 50)}..."`)
      return
    }

    // Add to recent messages and trim to last 5
    recentOfRole.push(normalizedContent)
    if (recentOfRole.length > 5) {
      recentOfRole.shift()
    }

    const newMessage = {
      id: `${Date.now()}-${Math.random()}`,
      role,
      content,
      timestamp: new Date(),
      toolName,
    }
    console.log(`✅ Adding ${role} message to state:`, newMessage)
    setMessages((prev) => [...prev, newMessage])
  }, [])

  // Handle incoming data messages via callback (more reliable than using message property)
  // The callback fires for EVERY message, while the message property only holds the last one
  const handleDataMessage = useCallback((msg: { payload: Uint8Array }) => {
    try {
      const data = JSON.parse(new TextDecoder().decode(msg.payload))
      console.log('📨 Received data message:', data.type, data)

      if (data.type === 'agent_ready') {
        setAgentConnected(true)
        onAgentReadyRef.current?.()
      } else if (data.type === 'agent_state') {
        setAgentState(data.state)
      } else if (data.type === 'user_transcript') {
        if (data.text && data.text.trim()) {
          console.log('👤 Adding user message:', data.text.substring(0, 50))
          addMessageRef.current?.('user', data.text)
        }
      } else if (data.type === 'assistant_response') {
        console.log('🤖 RAW assistant_response:', {
          hasText: !!data.text,
          textType: typeof data.text,
          textLength: data.text?.length,
          textPreview: data.text?.substring(0, 100),
          source: data.source,
          fullData: data
        })
        if (data.text && data.text.trim()) {
          console.log('🤖 Adding assistant message:', data.text.substring(0, 50), `[source: ${data.source || 'unknown'}]`)
          addMessageRef.current?.('assistant', data.text)
        } else {
          console.warn('⚠️ assistant_response had empty or invalid text:', data)
        }
      } else if (data.type === 'system') {
        // System messages from agent (task info, etc.)
        if (data.text && data.text.trim()) {
          console.log('⚙️ Adding system message:', data.text.substring(0, 50))
          addMessageRef.current?.('system', data.text)
        }
      } else if (data.type === 'tool_use') {
        addMessageRef.current?.('system', `Using ${data.tool}: ${data.description || ''}`, data.tool)
      } else if (data.type === 'permission_request') {
        setPendingPermission({
          toolName: data.toolName,
          description: data.description,
        })
      } else if (data.type === 'permission_response') {
        setPendingPermission(null)
      } else if (data.type === 'status_update') {
        // Status updates from background tasks
        if (data.summary && data.summary.trim()) {
          console.log('📊 Status update:', data.summary.substring(0, 50))
          // Only show meaningful status updates, not "No active tasks"
          if (!data.summary.includes('No active tasks')) {
            addMessageRef.current?.('system', data.summary)
          }
        }
      } else {
        console.log('❓ Unknown message type:', data.type)
      }
    } catch (e) {
      console.error('❌ Failed to parse data message:', e)
    }
  }, [])

  // Subscribe to data channel with callback - this fires for EVERY message
  useDataChannel('osborn-updates', handleDataMessage)

  // Compress image to fit within data channel limits
  const compressImage = async (file: File, maxSize: number = 40000): Promise<string> => {
    return new Promise((resolve) => {
      const img = new Image()
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')!

      img.onload = () => {
        // Start with original size, reduce until under maxSize
        let quality = 0.8
        let scale = 1
        const maxDimension = 800 // Max width/height

        // Scale down if too large
        if (img.width > maxDimension || img.height > maxDimension) {
          scale = maxDimension / Math.max(img.width, img.height)
        }

        canvas.width = img.width * scale
        canvas.height = img.height * scale
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)

        // Try to get under maxSize by reducing quality
        let base64 = canvas.toDataURL('image/jpeg', quality)
        while (base64.length > maxSize && quality > 0.1) {
          quality -= 0.1
          base64 = canvas.toDataURL('image/jpeg', quality)
        }

        // If still too large, scale down more
        while (base64.length > maxSize && scale > 0.2) {
          scale -= 0.1
          canvas.width = img.width * scale
          canvas.height = img.height * scale
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
          base64 = canvas.toDataURL('image/jpeg', 0.6)
        }

        resolve(base64)
      }

      img.src = URL.createObjectURL(file)
    })
  }

  const handleSendText = useCallback(async (text: string, files?: AttachedFile[]) => {
    let content = text
    const fileData: { name: string; type: string; content: string; url?: string }[] = []

    if (files && files.length > 0) {
      for (const af of files) {
        const isText = !af.file.type.startsWith('image/')

        // Use uploaded URL if available (Supabase), otherwise fall back to base64/text
        if (af.uploadedUrl) {
          fileData.push({
            name: af.file.name,
            type: af.type,
            content: '',  // Empty content since we have URL
            url: af.uploadedUrl,
          })
          content += `\n\n[${af.type === 'image' ? 'Image' : 'File'}: ${af.file.name}](${af.uploadedUrl})`
          console.log(`📤 Using uploaded URL: ${af.uploadedUrl}`)
        } else if (isText) {
          const textContent = await af.file.text()
          const truncatedContent = textContent.length > 10000
            ? textContent.substring(0, 10000) + '\n...[truncated]'
            : textContent
          fileData.push({ name: af.file.name, type: 'text', content: truncatedContent })
          content += `\n\n[File: ${af.file.name}]\n${truncatedContent.substring(0, 2000)}${truncatedContent.length > 2000 ? '...(truncated)' : ''}`
        } else {
          // Compress image if no URL available
          const base64 = await compressImage(af.file, 40000)
          fileData.push({ name: af.file.name, type: 'image', content: base64 })
          content += `\n\n[Image attached: ${af.file.name}]`
          console.log(`📷 Compressed image to ${base64.length} bytes`)
        }
      }
      setAttachedFiles([])
    }

    addMessageRef.current?.('user', content)

    // Build payload
    const payloadObj = {
      type: 'user_text',
      content: text,
      files: fileData.length > 0 ? fileData : undefined,
    }
    const payloadStr = JSON.stringify(payloadObj)

    // Send via data channel
    if (payloadStr.length > 60000) {
      console.warn(`⚠️ Payload too large (${payloadStr.length} bytes), sending text only`)
      addMessageRef.current?.('system', 'File too large. Please configure Supabase for file uploads.')
      const smallPayload = JSON.stringify({ type: 'user_text', content: text })
      const encoder = new TextEncoder()
      sendToAgent(encoder.encode(smallPayload), { reliable: true })
    } else {
      const encoder = new TextEncoder()
      sendToAgent(encoder.encode(payloadStr), { reliable: true })
    }
  }, [sendToAgent])

  const handlePermissionResponse = useCallback((response: 'allow' | 'deny' | 'always_allow') => {
    const toolName = pendingPermission?.toolName || 'tool'
    setPendingPermission(null)
    addMessageRef.current?.('system', `Permission ${response}: ${toolName}`)

    const encoder = new TextEncoder()
    const payload = encoder.encode(JSON.stringify({
      type: 'permission_response',
      response,
    }))
    sendToAgent(payload, { reliable: true })
  }, [sendToAgent, pendingPermission])

  if (waitingMode) {
    return (
      <div className="w-full p-6 text-center">
        <div className="flex flex-col items-center gap-3">
          <div className="relative">
            <div className="w-3 h-3 bg-violet-500 rounded-full animate-ping absolute" />
            <div className="w-3 h-3 bg-violet-500 rounded-full" />
          </div>
          <span className="text-gray-400 text-sm">Connecting to agent...</span>
        </div>
      </div>
    )
  }

  return (
    <>
      {pendingPermission && (
        <PermissionModal
          permission={pendingPermission}
          onRespond={handlePermissionResponse}
        />
      )}

      <div className="w-full max-w-2xl h-[85vh] flex flex-col bg-gradient-to-b from-gray-900 to-gray-950 rounded-2xl overflow-hidden border border-gray-800/50 shadow-2xl">
        {/* Header */}
        <div className="p-4 border-b border-gray-800/50 bg-gray-900/50 backdrop-blur-sm">
          <div className="flex items-center gap-4">
            {/* Visualizer */}
            <VoiceVisualizer state={state} audioTrack={audioTrack} />

            {/* Status */}
            <StatusIndicator state={agentState !== 'idle' ? agentState : state} isMuted={isMuted} />

            {/* Spacer */}
            <div className="flex-1" />

            {/* Controls */}
            <div className="flex items-center gap-2">
              {/* Mute button */}
              <button
                onClick={toggleMute}
                className={`p-2.5 rounded-xl transition-all ${
                  isMuted
                    ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30 ring-2 ring-red-500/50'
                    : 'bg-gray-800/50 text-gray-400 hover:bg-gray-700/50 hover:text-gray-200'
                }`}
                title={isMuted ? 'Unmute' : 'Mute'}
              >
                {isMuted ? (
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                  </svg>
                )}
              </button>

              {/* End button */}
              {onDisconnect && (
                <button
                  onClick={onDisconnect}
                  className="px-4 py-2.5 text-sm bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded-xl transition-all border border-red-500/30 hover:border-red-500/50 font-medium"
                >
                  End Session
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Chat */}
        <ChatPanel
          messages={messages}
          onSuggestionClick={(text) => handleSendText(text)}
        />

        {/* Input */}
        <TextInput
          onSend={handleSendText}
          attachedFiles={attachedFiles}
          onAttachFile={handleAttachFile}
          onRemoveFile={handleRemoveFile}
        />
      </div>
    </>
  )
}

export default function VoiceRoom({
  token,
  onDisconnect,
  onAgentReady,
  waitingMode,
  provider,
}: VoiceRoomProps) {
  const livekitUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL || 'wss://your-project.livekit.cloud'
  const enableVideo = provider === 'gemini'

  return (
    <LiveKitRoom
      token={token}
      serverUrl={livekitUrl}
      connect={true}
      audio={true}
      video={enableVideo}
      className="w-full flex justify-center"
      onDisconnected={onDisconnect}
    >
      <RoomAudioRenderer />
      <VoiceRoomInner
        onDisconnect={onDisconnect}
        onAgentReady={onAgentReady}
        waitingMode={waitingMode}
      />
    </LiveKitRoom>
  )
}
