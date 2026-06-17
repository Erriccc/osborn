'use client'

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  useVoiceAssistant,
  BarVisualizer,
  useDataChannel,
  useLocalParticipant,
  useRoomContext,
} from '@livekit/components-react'
import { RoomEvent, ConnectionState, Track } from 'livekit-client'
import '@livekit/components-styles'
import { MarkdownMessage } from './MarkdownMessage'
import { LogsDrawer } from './LogsDrawer'
import { FilesExplorerModal } from './FilesExplorerModal'
import { uploadFile, isSupabaseConfigured, type UploadResult } from '../lib/supabase'
import { formatTime, groupSessionsByDate } from '@/lib/sessions'
import { useChatSession } from './ChatSessionProvider'

// Public props for VoiceRoom. All session-level state (token, disconnect
// handler, agent-ready callback, auth callback, preSelectedSessionId,
// provider) now lives in ChatSessionProvider and is read via
// useChatSession() inside the default export below. Only truly
// UI-local flags remain as props.
interface VoiceRoomProps {
  waitingMode?: boolean
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
  category?: 'chat' | 'log'
}

interface PermissionRequest {
  toolName: string
  description: string
  input?: Record<string, unknown>
  riskLevel?: 'low' | 'medium' | 'high'
  diff?: string
}

// Helper to determine tool risk level
function getToolRiskLevel(toolName: string): 'low' | 'medium' | 'high' {
  const highRisk = ['Bash', 'Write', 'Edit', 'NotebookEdit']
  const mediumRisk = ['WebFetch', 'Task', 'KillShell']
  if (highRisk.includes(toolName)) return 'high'
  if (mediumRisk.includes(toolName)) return 'medium'
  return 'low'
}

// Session info from backend
interface SessionInfo {
  sessionId: string
  timestamp: string
  lastMessage?: string
  messageCount: number
}

// MCP server status from backend
interface McpServerStatus {
  serverKey: string
  name: string
  description: string
  category: 'code' | 'web' | 'data' | 'utility'
  transport: 'stdio' | 'http' | 'sse'
  enabled: boolean
  available: boolean
  missingEnvVars?: string[]
  source: 'catalog' | 'config'
}

// Generated file tracking (plans + research artifacts)
interface GeneratedFile {
  filePath: string
  fileName: string
  content?: string
  // Supabase Storage URL. When present, the agent uploaded this file to
  // Supabase rather than sending inline content — fetch from this URL to
  // render. Keeps the LiveKit data channel healthy for large artifacts
  // (resume PDFs, search indexes) that would otherwise corrupt the
  // publisher peer connection.
  url?: string
  type: 'plan' | 'diagram' | 'notes' | 'image' | 'summary' | 'html' | 'other'
  source: 'plan' | 'research'  // .claude/plans/ vs .osborn/sessions/
  updatedAt: Date
  isImage?: boolean
  mimeType?: string
  // Set when the agent had to fall back to inline delivery and truncated
  // the payload. Frontend can show a "truncated — N KB original" hint.
  truncated?: boolean
  originalSize?: number
}

// Streaming indicator dots
function StreamingDots() {
  return (
    <span className="inline-flex gap-1 ml-1">
      <span className="w-1.5 h-1.5 bg-amber-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
      <span className="w-1.5 h-1.5 bg-amber-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
      <span className="w-1.5 h-1.5 bg-amber-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
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
        className="flex items-center gap-2 text-xs text-amber-400 hover:text-amber-300 transition-colors"
      >
        <svg
          className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        <span className="flex items-center gap-1.5">
          {isStreaming && <span className="w-2 h-2 bg-amber-400 rounded-full animate-pulse" />}
          Reasoning
        </span>
      </button>
      {isExpanded && (
        <div className="mt-2 pl-4 border-l-2 border-amber-500/30">
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

  // Collapse excessive newlines but preserve bold headers for markdown rendering
  remainingContent = remainingContent
    .replace(/\n{3,}/g, '\n\n')
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

// Render text content with inline image support
function MessageContent({ content }: { content: string }) {
  const IMAGE_EXTS = /\.(png|jpg|jpeg|gif|webp|svg|bmp)$/i
  // Match [Image: name](url) and [File: name](url)
  const attachRegex = /\[(?:Image|File):\s*([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g

  const parts: { type: 'text' | 'image' | 'file'; text?: string; url?: string; name?: string }[] = []
  let lastIndex = 0
  let match

  attachRegex.lastIndex = 0
  while ((match = attachRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', text: content.slice(lastIndex, match.index) })
    }
    const name = match[1]
    const url = match[2]
    const isImage = IMAGE_EXTS.test(name) || IMAGE_EXTS.test(url)
    parts.push({ type: isImage ? 'image' : 'file', url, name })
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < content.length) {
    parts.push({ type: 'text', text: content.slice(lastIndex) })
  }

  if (parts.length === 0 || (parts.length === 1 && parts[0].type === 'text')) {
    return <p className="text-sm leading-relaxed whitespace-pre-wrap">{content}</p>
  }

  return (
    <div className="space-y-2">
      {parts.map((p, i) => {
        if (p.type === 'image') {
          return (
            <div key={i} className="rounded-lg overflow-hidden">
              <img src={p.url} alt={p.name || 'Image'}
                className="max-w-full max-h-64 sm:max-h-80 rounded-lg object-contain cursor-pointer hover:opacity-90 transition-opacity"
                onClick={() => window.open(p.url, '_blank')} loading="lazy" />
              {p.name && <p className="text-[10px] text-gray-500 mt-1 truncate">{p.name}</p>}
            </div>
          )
        }
        if (p.type === 'file') {
          return (
            <a key={i} href={p.url} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-2.5 p-2.5 rounded-xl bg-gray-800/60 border border-gray-700/50 hover:bg-gray-700/50 transition-colors group">
              <div className="w-9 h-9 rounded-lg bg-amber-500/20 flex items-center justify-center shrink-0">
                <svg className="w-4 h-4 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-gray-200 truncate group-hover:text-white transition-colors">{p.name || 'File'}</p>
                <p className="text-[10px] text-gray-500">Click to open</p>
              </div>
              <svg className="w-4 h-4 text-gray-500 group-hover:text-gray-300 transition-colors shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </a>
          )
        }
        const text = p.text?.trim()
        if (!text) return null
        return <p key={i} className="text-sm leading-relaxed whitespace-pre-wrap">{text}</p>
      })}
    </div>
  )
}

// Modern chat message bubble with parts support
const MessageBubble = React.memo(function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'

  // Parse content into parts for assistant messages
  const parts = useMemo(() => {
    if (message.role === 'assistant' && !message.parts) {
      const parsed = parseMessageParts(message.content)
      return parsed
    }
    return message.parts || [{ type: 'text' as const, content: message.content }]
  }, [message])

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} group`}>
      {/* Avatar for assistant — hidden on mobile to save space */}
      {!isUser && !isSystem && (
        <div className="hidden sm:flex w-8 h-8 rounded-full bg-gradient-to-br from-amber-500 to-amber-600 items-center justify-center mr-2 mt-1 shrink-0 shadow-lg">
          {message.toolName === 'fast-brain' ? (
            <span className="text-sm">&#9889;</span>
          ) : (
            <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          )}
        </div>
      )}

      <div
        className={`max-w-[92%] sm:max-w-[80%] rounded-2xl px-3 sm:px-4 py-2 sm:py-2.5 shadow-md transition-all ${
          isUser
            ? 'bg-gradient-to-r from-amber-500 to-amber-600 text-white rounded-br-md'
            : isSystem
            ? 'bg-amber-500/10 text-amber-200 border border-amber-500/30 rounded-bl-md'
            : message.toolName === 'fast-brain'
            ? 'bg-amber-900/30 text-amber-100 border border-amber-500/30 rounded-bl-md backdrop-blur-sm'
            : 'bg-gray-800/80 text-gray-100 border border-gray-700/50 rounded-bl-md backdrop-blur-sm'
        } ${message.isStreaming ? 'ring-2 ring-amber-500/30' : ''}`}
      >
        {/* Tool name badge — skip for fast-brain (has its own label in content) */}
        {message.toolName && message.toolName !== 'fast-brain' && (
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
                  // Check if content has markdown formatting (including tables with |)
                  const hasMarkdown = /[*#`\[\]|]/.test(part.content) || /^-{3,}$/m.test(part.content)
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
          <MessageContent content={message.content} />
        )}

        {/* Timestamp */}
        <div className="flex items-center gap-2 mt-1.5">
          <p className="text-[10px] opacity-40 select-none">
            {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </p>
          {message.isStreaming && (
            <span className="text-[10px] text-amber-400">streaming</span>
          )}
        </div>
      </div>

      {/* Avatar for user — hidden on mobile */}
      {isUser && (
        <div className="hidden sm:flex w-8 h-8 rounded-full bg-gradient-to-br from-amber-500 to-yellow-500 items-center justify-center ml-2 mt-1 shrink-0 shadow-lg">
          <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
          </svg>
        </div>
      )}
    </div>
  )
})

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
  activeResearch,
}: {
  messages: ChatMessage[]
  onSuggestionClick?: (text: string) => void
  activeResearch?: { taskId: string; task: string; toolCount: number } | null
}) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, activeResearch])

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto px-2 sm:px-4 py-3 sm:py-4 space-y-3 sm:space-y-4 scrollbar-thin scrollbar-thumb-gray-700 scrollbar-track-transparent"
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
      {messages.filter(m => m.category !== 'log').map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}
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

      <form onSubmit={handleSubmit} className="flex items-center gap-1.5 sm:gap-2 p-2 sm:p-3">
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
            className="w-full bg-gray-800/50 text-white px-4 py-2.5 rounded-xl border border-gray-700/50 focus:border-amber-500/50 focus:ring-2 focus:ring-amber-500/20 focus:outline-none transition-all placeholder:text-gray-500"
          />
        </div>

        {/* Send button */}
        <button
          type="submit"
          disabled={!text.trim() && attachedFiles.length === 0}
          className="p-2.5 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 disabled:from-gray-700 disabled:to-gray-700 disabled:cursor-not-allowed rounded-xl transition-all shadow-lg disabled:shadow-none"
        >
          <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
          </svg>
        </button>
      </form>
    </div>
  )
}

// Unified Control Menu - Combines mode toggle, session history, tools, and settings
function ControlMenu({
  sessions,
  currentSessionId,
  onLoadSessions,
  onResumeSession,
  onContinueSession,
  isLoadingSessions,
  disabled,
  mcpServers,
  onMcpToggle,
  onLoadMcpStatus,
  skills,
  onAddSkill,
  showAddSkill,
  setShowAddSkill,
  newSkillName,
  setNewSkillName,
  newSkillContent,
  setNewSkillContent,
}: {
  sessions: SessionInfo[]
  currentSessionId?: string | null
  onLoadSessions: () => void
  onResumeSession: (sessionId: string) => void
  onContinueSession: () => void
  isLoadingSessions?: boolean
  disabled?: boolean
  mcpServers?: McpServerStatus[]
  onMcpToggle?: (serverKey: string, enabled: boolean) => void
  onLoadMcpStatus?: () => void
  skills?: { name: string; description: string }[]
  onAddSkill?: (name: string, content: string) => void
  showAddSkill?: boolean
  setShowAddSkill?: (show: boolean) => void
  newSkillName?: string
  setNewSkillName?: (name: string) => void
  newSkillContent?: string
  setNewSkillContent?: (content: string) => void
}) {
  const [isOpen, setIsOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<'history' | 'tools'>('history')
  const [showSwitchConfirm, setShowSwitchConfirm] = useState(false)
  const [pendingSwitchSessionId, setPendingSwitchSessionId] = useState<string | null>(null)

  const enabledMcpCount = (mcpServers || []).filter(s => s.enabled).length
  const skillCount = (skills || []).length
  const toolsBadgeCount = enabledMcpCount + skillCount

  // Load data when tabs are opened
  const handleTabChange = (tab: 'history' | 'tools') => {
    setActiveTab(tab)
    if (tab === 'history' && sessions.length === 0) {
      onLoadSessions()
    }
    if (tab === 'tools') {
      onLoadMcpStatus?.()
    }
  }

  return (
    <div className="relative flex items-center gap-2">
      {/* Research mode indicator - always visible */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        disabled={disabled}
        className={`flex items-center gap-1.5 px-2 py-1 rounded-lg border transition-all text-xs bg-amber-500/10 border-amber-500/30 text-amber-400 ${disabled ? 'opacity-50 cursor-not-allowed' : 'hover:opacity-80'}`}
        title="Open settings"
      >
        <span className="font-medium">Research</span>
        <svg className={`w-3 h-3 transition-transform ${isOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Dropdown menu */}
      {isOpen && (
        <div className="absolute top-10 left-0 w-72 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl z-[100] overflow-hidden">
          {/* Tabs */}
          <div className="flex border-b border-gray-700">
            <button
              onClick={() => handleTabChange('history')}
              className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${
                activeTab === 'history'
                  ? 'text-amber-400 border-b-2 border-amber-400 bg-amber-500/10'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              History
            </button>
            <button
              onClick={() => handleTabChange('tools')}
              className={`flex-1 px-3 py-2 text-xs font-medium transition-colors relative ${
                activeTab === 'tools'
                  ? 'text-amber-400 border-b-2 border-amber-400 bg-amber-500/10'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              Tools
              {toolsBadgeCount > 0 && (
                <span className="ml-1 px-1.5 py-0.5 text-[10px] font-bold rounded-full bg-green-500/20 text-green-400">
                  {toolsBadgeCount}
                </span>
              )}
            </button>
          </div>

          {/* History Tab */}
          {activeTab === 'history' && (
            <div className="max-h-96 overflow-y-auto">
              <div className="p-2 border-b border-gray-800">
                <button
                  onClick={() => {
                    onContinueSession()
                    setIsOpen(false)
                  }}
                  className="w-full py-2 text-xs bg-amber-500/20 text-amber-400 rounded-lg hover:bg-amber-500/30 transition-colors"
                >
                  Continue Last Session
                </button>
              </div>
              <div className="p-2">
                {isLoadingSessions ? (
                  <div className="flex items-center justify-center py-4 text-gray-500 text-xs">
                    <svg className="w-4 h-4 animate-spin mr-2" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Loading...
                  </div>
                ) : sessions.length === 0 ? (
                  <p className="text-center py-4 text-gray-500 text-xs">No previous sessions</p>
                ) : (
                  <div className="space-y-1">
                    {sessions.map((session) => (
                      <button
                        key={session.sessionId}
                        onClick={() => {
                          if (currentSessionId && currentSessionId !== session.sessionId) {
                            // Show confirmation for mid-conversation switch
                            setPendingSwitchSessionId(session.sessionId)
                            setShowSwitchConfirm(true)
                          } else {
                            onResumeSession(session.sessionId)
                            setIsOpen(false)
                          }
                        }}
                        className={`w-full text-left p-2 rounded-lg transition-colors text-xs ${
                          currentSessionId === session.sessionId
                            ? 'bg-amber-500/20 border border-amber-500/30'
                            : 'hover:bg-gray-800'
                        }`}
                      >
                        <div className="flex items-center justify-between mb-0.5">
                          <span className="text-gray-400">{formatTime(session.timestamp)}</span>
                          <span className="text-gray-500">{session.messageCount} msgs</span>
                        </div>
                        <p className="text-gray-300 truncate">
                          {session.lastMessage || 'No preview'}
                        </p>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Tools Tab */}
          {activeTab === 'tools' && (
            <div className="max-h-96 overflow-y-auto p-3 space-y-3">
              {/* Skills Section */}
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
                  <div className="space-y-1">
                    {skills.map((skill) => (
                      <div
                        key={skill.name}
                        className="p-2 rounded-lg bg-gray-800/50 border border-gray-700/30"
                      >
                        <span className="text-sm font-medium text-gray-200">{skill.name}</span>
                        {skill.description && (
                          <p className="text-[11px] text-gray-500 truncate">{skill.description}</p>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-[11px] text-gray-500">No skills installed</p>
                )}
              </div>

              {/* MCP Servers Section */}
              {(!mcpServers || mcpServers.length === 0) ? (
                <p className="text-center py-4 text-gray-500 text-xs">No MCP tools available</p>
              ) : (
                <>
                  {/* Group by category */}
                  {(['code', 'web', 'data', 'utility'] as const).map(category => {
                    const serversInCategory = mcpServers.filter(s => s.category === category)
                    if (serversInCategory.length === 0) return null
                    const categoryLabels: Record<string, string> = {
                      code: 'Code', web: 'Web', data: 'Data', utility: 'Utility',
                    }
                    return (
                      <div key={category}>
                        <h4 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
                          {categoryLabels[category]}
                        </h4>
                        <div className="space-y-1">
                          {serversInCategory.map(server => (
                            <div
                              key={server.serverKey}
                              className="flex items-center justify-between p-2 rounded-lg bg-gray-800/50 border border-gray-700/30"
                            >
                              <div className="flex-1 min-w-0 mr-2">
                                <div className="flex items-center gap-1.5">
                                  <span className="text-sm font-medium text-gray-200">{server.name}</span>
                                  {server.source === 'config' && (
                                    <span className="text-[9px] px-1 py-0.5 rounded bg-gray-700 text-gray-400">custom</span>
                                  )}
                                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                                    server.transport === 'stdio' ? 'bg-gray-700 text-gray-400' : 'bg-emerald-900/50 text-emerald-400'
                                  }`}>
                                    {server.transport === 'stdio' ? 'local' : 'cloud'}
                                  </span>
                                </div>
                                <p className="text-[11px] text-gray-500 truncate">{server.description}</p>
                                {!server.available && server.missingEnvVars && (
                                  <p className="text-[10px] text-amber-400 mt-0.5">
                                    Missing: {server.missingEnvVars.join(', ')}
                                  </p>
                                )}
                              </div>
                              <button
                                onClick={() => onMcpToggle?.(server.serverKey, !server.enabled)}
                                disabled={!server.available}
                                className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${
                                  !server.available
                                    ? 'bg-gray-700 cursor-not-allowed opacity-50'
                                    : server.enabled
                                    ? 'bg-green-500'
                                    : 'bg-gray-600 hover:bg-gray-500'
                                }`}
                                title={!server.available ? `Missing env vars: ${server.missingEnvVars?.join(', ')}` : server.enabled ? 'Disable' : 'Enable'}
                              >
                                <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                                  server.enabled ? 'translate-x-4' : 'translate-x-0'
                                }`} />
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )
                  })}
                  <p className="text-[10px] text-gray-600 text-center pt-1">
                    Changes apply on next message
                  </p>
                </>
              )}
            </div>
          )}

          {/* Switch confirmation dialog */}
          {showSwitchConfirm && (
            <div className="absolute inset-0 bg-black/80 flex items-center justify-center rounded-lg z-10">
              <div className="bg-gray-800 p-4 rounded-lg text-center">
                <p className="text-sm text-white mb-3">Switch to this session?</p>
                <p className="text-xs text-gray-400 mb-4">Current context will be saved.</p>
                <div className="flex gap-2 justify-center">
                  <button
                    onClick={() => setShowSwitchConfirm(false)}
                    className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-sm"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      if (pendingSwitchSessionId) {
                        onResumeSession(pendingSwitchSessionId)
                      }
                      setShowSwitchConfirm(false)
                      setIsOpen(false)
                    }}
                    className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 rounded text-sm"
                  >
                    Switch
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
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
  const riskColors = {
    low: 'text-green-400 bg-green-500/10 border-green-500/30',
    medium: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/30',
    high: 'text-red-400 bg-red-500/10 border-red-500/30',
  }
  const riskLevel = permission.riskLevel || 'medium'
  const [showFullDiff, setShowFullDiff] = useState(false)

  // Extract key details from input for display
  const getInputDetails = () => {
    const input = permission.input
    if (!input) return null

    if (permission.toolName === 'Bash' && input.command) {
      return { label: 'Command', value: String(input.command) }
    }
    if ((permission.toolName === 'Write' || permission.toolName === 'Edit') && input.file_path) {
      return { label: 'File', value: String(input.file_path) }
    }
    if (permission.toolName === 'WebFetch' && input.url) {
      return { label: 'URL', value: String(input.url) }
    }
    if (permission.toolName === 'Grep' && input.pattern) {
      return { label: 'Pattern', value: String(input.pattern) }
    }
    return null
  }

  const inputDetails = getInputDetails()

  console.log(`🔍 [modal] rendering PermissionModal: diff=${permission.diff ? `✅ ${permission.diff.length} chars` : '❌ NONE'}`)

  // Parse diff to extract line numbers from @@ headers
  const parseDiffLines = (diff: string) => {
    const lines = diff.split('\n')
    let oldLine = 0
    let newLine = 0
    return lines.map((line) => {
      const hunkMatch = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)/)
      if (hunkMatch) {
        oldLine = parseInt(hunkMatch[1])
        newLine = parseInt(hunkMatch[2])
        return { line, type: 'hunk' as const, num: '' }
      }
      if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('Index:') || line.startsWith('===')) {
        return { line, type: 'meta' as const, num: '' }
      }
      if (line.startsWith('+')) {
        const n = newLine++
        return { line, type: 'add' as const, num: String(n) }
      }
      if (line.startsWith('-')) {
        const n = oldLine++
        return { line, type: 'del' as const, num: String(n) }
      }
      oldLine++
      newLine++
      return { line, type: 'ctx' as const, num: String(newLine - 1) }
    })
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-end sm:items-start justify-center z-50 sm:p-4 sm:pt-8">
      <div className="bg-gray-900 sm:rounded-2xl p-4 sm:p-6 max-w-2xl w-full border-t sm:border border-gray-700/50 shadow-2xl max-h-[85vh] sm:max-h-[90vh] flex flex-col rounded-t-2xl">
        {/* Header */}
        <div className="flex items-center gap-3 mb-4 shrink-0">
          <div className="w-9 h-9 rounded-full bg-amber-500/20 flex items-center justify-center shrink-0">
            <svg className="w-4 h-4 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-semibold text-white">Permission Required</h3>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="px-1.5 py-0.5 bg-amber-500/20 text-amber-300 text-xs font-mono rounded">
                {permission.toolName}
              </span>
              <span className={`px-1.5 py-0.5 text-[10px] font-semibold rounded border ${riskColors[riskLevel]}`}>
                {riskLevel.toUpperCase()}
              </span>
            </div>
          </div>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto min-h-0 space-y-3 mb-4">
          {/* Description */}
          <div className="bg-gray-800/50 rounded-xl p-3 border border-gray-700/50">
            <p className="text-gray-300 text-sm leading-relaxed">{permission.description}</p>
            {inputDetails && !permission.description.includes(inputDetails.value) && (
              <div className="mt-2 pt-2 border-t border-gray-700/50">
                <span className="text-[10px] text-gray-500 uppercase tracking-wider">{inputDetails.label}</span>
                <code className="block mt-1 text-xs text-amber-300 bg-gray-900 p-2 rounded-lg overflow-x-auto whitespace-nowrap">
                  {inputDetails.value}
                </code>
              </div>
            )}
          </div>

          {/* Diff viewer with line numbers */}
          {permission.diff && (() => {
            const parsed = parseDiffLines(permission.diff!)
            const COLLAPSED = 12
            const hasMore = parsed.length > COLLAPSED
            const visible = showFullDiff ? parsed : parsed.slice(0, COLLAPSED)
            const lineColors = {
              meta: 'text-gray-500',
              hunk: 'text-cyan-400 bg-cyan-950/30',
              add: 'text-green-400 bg-green-950/40',
              del: 'text-red-400 bg-red-950/40',
              ctx: 'text-gray-400',
            }
            return (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[10px] text-gray-500 uppercase tracking-wider font-medium">Changes</span>
                  <span className="text-[10px] text-gray-600">{parsed.filter(p => p.type === 'add').length} additions, {parsed.filter(p => p.type === 'del').length} deletions</span>
                </div>
                <div className={`rounded-xl border border-gray-700/50 bg-gray-950 font-mono text-[11px] sm:text-xs overflow-x-auto ${showFullDiff ? 'max-h-80 overflow-y-auto' : ''}`}>
                  <div className="min-w-max">
                  {visible.map((p, i) => (
                    <div key={i} className={`flex ${lineColors[p.type]} border-b border-gray-800/30 last:border-0`}>
                      {/* Line number gutter */}
                      <span className="w-10 sm:w-12 shrink-0 text-right pr-2 py-px text-gray-600 select-none border-r border-gray-800/50 bg-gray-900/50 sticky left-0">
                        {p.num}
                      </span>
                      {/* Code content */}
                      <span className="px-2 sm:px-3 py-px whitespace-pre">{p.line}</span>
                    </div>
                  ))}
                  </div>
                </div>
                {hasMore && (
                  <button
                    onClick={() => setShowFullDiff(v => !v)}
                    className="mt-2 w-full py-1.5 text-xs text-gray-400 hover:text-gray-200 bg-gray-800/50 hover:bg-gray-800 rounded-lg transition-colors flex items-center justify-center gap-1.5"
                  >
                    <svg className={`w-3 h-3 transition-transform ${showFullDiff ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                    {showFullDiff ? 'Collapse' : `Show ${parsed.length - COLLAPSED} more lines`}
                  </button>
                )}
              </div>
            )
          })()}
        </div>

        {/* Action buttons — sticky at bottom */}
        <div className="shrink-0 space-y-3">
          <div className="flex gap-2">
            <button onClick={() => onRespond('deny')}
              className="flex-1 px-3 py-2.5 bg-gray-800 hover:bg-gray-700 rounded-xl transition-colors text-gray-300 text-sm font-medium border border-gray-700">
              Deny
            </button>
            <button onClick={() => onRespond('allow')}
              className="flex-1 px-3 py-2.5 bg-green-600 hover:bg-green-500 rounded-xl transition-colors text-white text-sm font-medium shadow-lg shadow-green-500/20">
              Allow
            </button>
            <button onClick={() => onRespond('always_allow')}
              className="flex-1 px-3 py-2.5 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 rounded-xl transition-all text-white text-sm font-medium shadow-lg shadow-amber-500/20">
              Always
            </button>
          </div>
          <p className="text-gray-600 text-[10px] text-center">
            Or say "allow", "deny", or "always allow"
          </p>
        </div>
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
      gradient: 'from-amber-400 to-yellow-500',
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
    <>
      {/* Desktop: full visualizer */}
      <div className="relative hidden sm:block">
        <div className={`absolute inset-0 rounded-2xl blur-xl transition-opacity duration-300 ${
          state === 'speaking' ? 'bg-amber-500/30 opacity-100' :
          state === 'listening' ? 'bg-green-500/20 opacity-100' : 'opacity-0'
        }`} />
        <div className="relative h-16 w-32 bg-gray-800/50 rounded-2xl border border-gray-700/50 flex items-center justify-center overflow-hidden backdrop-blur-sm">
          <BarVisualizer
            state={visualizerState}
            trackRef={audioTrack}
            barCount={7}
            options={{ minHeight: 4 }}
          />
        </div>
      </div>
      {/* Mobile: compact mini visualizer */}
      <div className="relative sm:hidden">
        <div className="relative h-8 w-16 bg-gray-800/50 rounded-xl border border-gray-700/50 flex items-center justify-center overflow-hidden">
          <BarVisualizer
            state={visualizerState}
            trackRef={audioTrack}
            barCount={4}
            options={{ minHeight: 2 }}
          />
        </div>
      </div>
    </>
  )
}

// Inner component with LiveKit hooks
function VoiceRoomInner({
  onDisconnect,
  onAgentReady,
  onAuthRequired,
  onVoiceActivity,
  waitingMode,
  preSelectedSessionId,
  agentUrl,
}: {
  onDisconnect?: () => void
  onAgentReady?: () => void
  onAuthRequired?: () => void
  onVoiceActivity?: () => void
  waitingMode?: boolean
  preSelectedSessionId?: string | null
  agentUrl?: string
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null)
  // YOLO toggle: when enabled, the frontend intercepts every incoming
  // permission_request and sends back an immediate allow without showing
  // the modal. Persisted to localStorage so it survives reloads. Default
  // OFF. Applied at the data-channel handler in handleDataMessage (see the
  // permission_request branch below) — the agent still emits requests, we
  // just auto-respond.
  const [autoApprovePermissions, setAutoApprovePermissions] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem('osborn-auto-approve-permissions') === 'true'
  })
  useEffect(() => {
    if (typeof window === 'undefined') return
    localStorage.setItem('osborn-auto-approve-permissions', String(autoApprovePermissions))
  }, [autoApprovePermissions])
  // Mirror the toggle into a ref so the data-channel handler can read the
  // latest value without listing autoApprovePermissions in its dependency
  // array (which would re-subscribe the room on every toggle flip and
  // momentarily drop incoming messages).
  const autoApprovePermissionsRef = useRef(autoApprovePermissions)
  useEffect(() => { autoApprovePermissionsRef.current = autoApprovePermissions }, [autoApprovePermissions])
  const [claudeAuthUrl, setClaudeAuthUrl] = useState<string | null>(null)
  const [claudeAuthStatus, setClaudeAuthStatus] = useState<'none' | 'required' | 'waiting' | 'waiting_code' | 'submitting' | 'complete' | 'error'>('none')
  const [claudeAuthCode, setClaudeAuthCode] = useState('')
  const [agentConnected, setAgentConnected] = useState(false)
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([])
  const [agentState, setAgentState] = useState<string>('idle')
  const [isMuted, setIsMuted] = useState(false)
  // Session management state
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  const [isLoadingSessions, setIsLoadingSessions] = useState(false)
  // Auto-resume prompt state
  const [showResumePrompt, setShowResumePrompt] = useState(false)
  const [recentSessionId, setRecentSessionId] = useState<string | null>(null)
  // Session gate: tracks whether user has chosen a session (or fresh start) before voice begins
  const [sessionGateCompleted, setSessionGateCompleted] = useState(false)
  // Copy feedback state for "Copy All Messages" button
  const [copyFeedback, setCopyFeedback] = useState(false)
  // Generated files state (plans + research artifacts)
  const [generatedFiles, setGeneratedFiles] = useState<GeneratedFile[]>([])
  const [showFilesPanel, setShowFilesPanel] = useState(false)
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null)
  const [fileCopyFeedback, setFileCopyFeedback] = useState<string | null>(null)
  const [isFilesModalOpen, setIsFilesModalOpen] = useState(false) // Default closed — opens via button (desktop only)
  // MCP server state
  const [mcpServers, setMcpServers] = useState<McpServerStatus[]>([])
  // Skills state
  const [skills, setSkills] = useState<{ name: string; description: string }[]>([])
  const [showAddSkill, setShowAddSkill] = useState(false)
  const [showMobileMenu, setShowMobileMenu] = useState(false)
  const [newSkillName, setNewSkillName] = useState('')
  const [newSkillContent, setNewSkillContent] = useState('')
  // Research tracking state
  const [activeResearch, setActiveResearch] = useState<{ taskId: string; task: string; toolCount: number } | null>(null)
  // Meeting state (Recall.ai)
  const [meetingBotId, setMeetingBotId] = useState<string | null>(null)
  const [meetingStatus, setMeetingStatus] = useState<'idle' | 'joining' | 'joined' | 'error'>('idle')
  const [meetingError, setMeetingError] = useState<string | null>(null)
  // Meeting TODOs panel — fed by the agent writing meeting-todos.md in the
  // workspace. `research_artifact_updated` already fires automatically when
  // any file under /osb/ is written, and `get_research_artifact` returns the
  // content. We just slice the `notes` file matching name `meeting-todos.md`.
  const [meetingTodosContent, setMeetingTodosContent] = useState<string | null>(null)
  const [meetingTodosUpdatedAt, setMeetingTodosUpdatedAt] = useState<number | null>(null)
  // Compaction status indicator — full lifecycle visualization
  // Compaction is a ~1-3 minute server-side process. Earlier UX used a tiny pill
  // that animated only for the brief moment between started/complete; users
  // missed it entirely. New UX: keep a prominent panel visible for the entire
  // window, with a rolling list of stages so the user sees real progress.
  const [compactionStatus, setCompactionStatus] = useState<'idle' | 'compacting' | 'complete'>('idle')
  const [compactionStages, setCompactionStages] = useState<Array<{ stage: string; detail?: string; ts: number }>>([])
  const [compactionSkills, setCompactionSkills] = useState<string[]>([])
  const [compactionStartedAt, setCompactionStartedAt] = useState<number | null>(null)

  // Derived: currently selected file for preview
  const selectedFile = useMemo(() => {
    return generatedFiles.find(f => f.filePath === selectedFilePath) || generatedFiles[0] || null
  }, [generatedFiles, selectedFilePath])

  const { localParticipant } = useLocalParticipant()

  const toggleMute = useCallback(async () => {
    if (localParticipant) {
      const newMuted = !isMuted
      await localParticipant.setMicrophoneEnabled(!newMuted)
      setIsMuted(newMuted)
    }
  }, [localParticipant, isMuted])

  // Copy all messages to clipboard with timestamps
  const handleCopyAllMessages = useCallback(async () => {
    if (messages.length === 0) return

    const formattedText = messages
      .map(msg => {
        const role = msg.role === 'user' ? 'You' : msg.role === 'assistant' ? 'Osborn' : 'System'
        const time = msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        return `[${time}] ${role}:\n${msg.content}`
      })
      .join('\n\n---\n\n')

    try {
      await navigator.clipboard.writeText(formattedText)
      setCopyFeedback(true)
      setTimeout(() => setCopyFeedback(false), 1500)
    } catch (err) {
      console.error('Failed to copy messages:', err)
    }
  }, [messages])

  // Copy single generated file
  const handleCopyFile = useCallback(async (filePath: string) => {
    const file = generatedFiles.find(f => f.filePath === filePath)
    if (!file?.content) return
    try {
      await navigator.clipboard.writeText(file.content)
      setFileCopyFeedback(filePath)
      setTimeout(() => setFileCopyFeedback(null), 1500)
    } catch (err) {
      console.error('Failed to copy file:', err)
    }
  }, [generatedFiles])

  // Copy all generated files
  const handleCopyAllFiles = useCallback(async () => {
    const allContent = generatedFiles
      .filter(f => f.content && !f.isImage)
      .map(f => `# ${f.fileName}\n\n${f.content}`)
      .join('\n\n---\n\n')
    if (!allContent) return
    try {
      await navigator.clipboard.writeText(allContent)
      setFileCopyFeedback('all')
      setTimeout(() => setFileCopyFeedback(null), 1500)
    } catch (err) {
      console.error('Failed to copy files:', err)
    }
  }, [generatedFiles])

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

          if (!result.success) {
            console.error('Upload failed:', result.error)
            addMessageRef.current?.('system', `Upload failed: ${result.error || 'Unknown error'}. Check Supabase Dashboard → Storage → osborn-storage bucket policies.`)
          }

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
  const room = useRoomContext()

  useEffect(() => {
    if (state === 'listening' || state === 'speaking' || state === 'thinking') {
      if (!agentConnected) {
        setAgentConnected(true)
        onAgentReady?.()
      }
    }
  }, [state, agentConnected, onAgentReady])

  // ============================================================
  // 0.9.68 — Audio + room instrumentation
  //
  // Captures every LiveKit RoomEvent + audio track lifecycle event so we can
  // correlate frontend-side audio drops with backend TTS abort cascades.
  // Each line is JSON-serializable for easy grep + tooling.
  // ============================================================
  useEffect(() => {
    if (!room) return
    const log = (event: string, data: Record<string, unknown> = {}) => {
      console.log(`[FE-AUDIO] ${event}`, JSON.stringify({ t: new Date().toISOString(), agentState: state, sid: room.name, ...data }))
    }
    log('mount', { sid: room.name, connectionState: room.state, canPlayback: room.canPlaybackAudio })

    const onConnected = () => log('RoomConnected', { sid: room.name })
    const onDisconnected = (reason: unknown) => log('RoomDisconnected', { reason: String(reason) })
    const onReconnecting = () => log('RoomReconnecting')
    const onReconnected = () => log('RoomReconnected')
    const onConnState = (s: ConnectionState) => log('ConnectionStateChanged', { state: s })
    const onTrackSubscribed = (track: any, pub: any, participant: any) => {
      const isAgent = !participant.isLocal
      const isAudio = track.kind === Track.Kind.Audio
      if (isAgent && isAudio) {
        log('AgentAudioTrackSubscribed', { src: track.source, sid: pub?.trackSid, participant: participant.identity })
        const onMuted = () => log('AgentAudioTrackMuted_LIVE', { sid: pub?.trackSid })
        const onUnmuted = () => log('AgentAudioTrackUnmuted_LIVE', { sid: pub?.trackSid })
        const onEnded = () => log('AgentAudioTrackEnded', { sid: pub?.trackSid })
        track.on?.('muted', onMuted)
        track.on?.('unmuted', onUnmuted)
        track.on?.('ended', onEnded)
      } else {
        log('TrackSubscribed', { kind: track.kind, participant: participant.identity })
      }
    }
    const onTrackUnsubscribed = (track: any, pub: any, participant: any) =>
      log('TrackUnsubscribed', { kind: track.kind, participant: participant.identity, sid: pub?.trackSid })
    const onTrackMuted = (pub: any, participant: any) =>
      log('TrackMuted', { kind: pub?.kind, participant: participant.identity, sid: pub?.trackSid, isLocal: participant.isLocal })
    const onTrackUnmuted = (pub: any, participant: any) =>
      log('TrackUnmuted', { kind: pub?.kind, participant: participant.identity, sid: pub?.trackSid, isLocal: participant.isLocal })
    const onActiveSpeakers = (speakers: any[]) =>
      log('ActiveSpeakersChanged', { count: speakers.length, identities: speakers.map(s => s.identity) })
    const onConnQuality = (q: any, p: any) =>
      log('ConnectionQualityChanged', { participant: p.identity, quality: q })
    const onAudioPlayback = () =>
      log('AudioPlaybackStatusChanged', { canPlay: room.canPlaybackAudio })
    const onMediaDevicesError = (err: Error) =>
      log('MediaDevicesError', { err: err.message })
    const onParticipantConnected = (p: any) =>
      log('ParticipantConnected', { identity: p.identity, isAgent: !p.isLocal })
    const onParticipantDisconnected = (p: any) =>
      log('ParticipantDisconnected', { identity: p.identity, isAgent: !p.isLocal })

    room.on(RoomEvent.Connected, onConnected)
    room.on(RoomEvent.Disconnected, onDisconnected)
    room.on(RoomEvent.Reconnecting, onReconnecting)
    room.on(RoomEvent.Reconnected, onReconnected)
    room.on(RoomEvent.ConnectionStateChanged, onConnState)
    room.on(RoomEvent.TrackSubscribed, onTrackSubscribed)
    room.on(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed)
    room.on(RoomEvent.TrackMuted, onTrackMuted)
    room.on(RoomEvent.TrackUnmuted, onTrackUnmuted)
    room.on(RoomEvent.ActiveSpeakersChanged, onActiveSpeakers)
    room.on(RoomEvent.ConnectionQualityChanged, onConnQuality)
    room.on(RoomEvent.AudioPlaybackStatusChanged, onAudioPlayback)
    room.on(RoomEvent.MediaDevicesError, onMediaDevicesError)
    room.on(RoomEvent.ParticipantConnected, onParticipantConnected)
    room.on(RoomEvent.ParticipantDisconnected, onParticipantDisconnected)

    return () => {
      room.off(RoomEvent.Connected, onConnected)
      room.off(RoomEvent.Disconnected, onDisconnected)
      room.off(RoomEvent.Reconnecting, onReconnecting)
      room.off(RoomEvent.Reconnected, onReconnected)
      room.off(RoomEvent.ConnectionStateChanged, onConnState)
      room.off(RoomEvent.TrackSubscribed, onTrackSubscribed)
      room.off(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed)
      room.off(RoomEvent.TrackMuted, onTrackMuted)
      room.off(RoomEvent.TrackUnmuted, onTrackUnmuted)
      room.off(RoomEvent.ActiveSpeakersChanged, onActiveSpeakers)
      room.off(RoomEvent.ConnectionQualityChanged, onConnQuality)
      room.off(RoomEvent.AudioPlaybackStatusChanged, onAudioPlayback)
      room.off(RoomEvent.MediaDevicesError, onMediaDevicesError)
      room.off(RoomEvent.ParticipantConnected, onParticipantConnected)
      room.off(RoomEvent.ParticipantDisconnected, onParticipantDisconnected)
    }
  }, [room, state])

  // 0.9.68 — log every agent state transition with precise timestamp.
  // Cross-reference against backend "🤖 State:" logs to see propagation lag.
  useEffect(() => {
    console.log(`[FE-AUDIO] AgentStateChanged`, JSON.stringify({
      t: new Date().toISOString(),
      state,
      hasAudioTrack: !!audioTrack,
      trackMuted: audioTrack?.publication?.isMuted,
      trackSubscribed: audioTrack?.publication?.isSubscribed,
    }))
  }, [state, audioTrack])

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

  // Refs to track session gate state in data handler without causing re-subscriptions
  const sessionGateCompletedRef = useRef(sessionGateCompleted)
  sessionGateCompletedRef.current = sessionGateCompleted
  const showResumePromptRef = useRef(showResumePrompt)
  showResumePromptRef.current = showResumePrompt

  const addMessageRef = useRef<(role: ChatMessage['role'], content: string, toolName?: string, category?: 'chat' | 'log') => void>()

  // addMessage function with duplicate detection
  addMessageRef.current = useCallback((role: ChatMessage['role'], content: string, toolName?: string, category?: 'chat' | 'log') => {
    console.log(`📥 addMessage called: role=${role}, contentLength=${content?.length}, content="${content?.substring(0, 80)}..."`)

    // Safety check - skip empty/whitespace-only messages
    if (!content || typeof content !== 'string' || !content.trim()) {
      console.log(`⏭️ addMessage: skipping empty ${role} message`)
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
      category: category || 'chat',
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
        // Store sessions from agent_ready if provided
        if (data.sessions && Array.isArray(data.sessions)) {
          setSessions(data.sessions)
        }
        // Store MCP server status from agent_ready
        if (data.mcpServers && Array.isArray(data.mcpServers)) {
          // Merge runtime enabled state with status list
          const enabledKeys: string[] = data.enabledMcpServers || []
          const merged = data.mcpServers.map((s: McpServerStatus) => ({
            ...s,
            enabled: enabledKeys.includes(s.serverKey),
          }))
          setMcpServers(merged)
        }
        // Store skills from agent_ready
        if (data.skills && Array.isArray(data.skills)) {
          setSkills(data.skills)
        }
        // Only process session gate logic on the FIRST agent_ready (skip retries)
        if (!sessionGateCompletedRef.current && !showResumePromptRef.current) {
          // If a session was pre-selected from the session browser, skip the gate entirely
          if (preSelectedSessionId || data.preSelectedSessionId) {
            console.log('📂 Pre-selected session — skipping session gate')
            setSessionGateCompleted(true)
            setCurrentSessionId(preSelectedSessionId || data.preSelectedSessionId)
          }
          // Show session gate if sessions available — mic muted until user chooses
          else if (data.sessions?.length > 0 || (data.hasRecentSession && data.recentSessionId)) {
            setRecentSessionId(data.recentSessionId)
            setShowResumePrompt(true)
            // Mute mic while session gate is shown (prevents premature speech)
            setIsMuted(true)
            localParticipant?.setMicrophoneEnabled(false)
          } else {
            // No sessions — gate is automatically completed
            setSessionGateCompleted(true)
          }
        }
      } else if (data.type === 'agent_state') {
        setAgentState(data.state)
        // Any voice state change (thinking/speaking/listening) = active session
        onVoiceActivity?.()
      } else if (data.type === 'user_transcript') {
        if (data.text && data.text.trim()) {
          console.log('👤 Adding user message:', data.text.substring(0, 50))
          addMessageRef.current?.('user', data.text)
          // User spoke — strongest activity signal, always reset idle timer
          onVoiceActivity?.()
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
          addMessageRef.current?.('system', data.text, undefined, 'log')
        }
      } else if (data.type === 'research_task_started') {
        // Research started — show inline spinner in chat
        console.log('🔬 Research started:', data.task)
        setActiveResearch({ taskId: data.taskId, task: data.task, toolCount: 0 })
      } else if (data.type === 'research_task_complete') {
        // Research finished — replace spinner with summary
        console.log('✅ Research complete:', data.taskId)
        setActiveResearch(null)
        if (data.summary) {
          addMessageRef.current?.('system', data.summary, undefined, 'log')
        }
      } else if (data.type === 'tool_use') {
        // Show tool usage with status
        const status = data.status === 'completed' ? '✓' : '⏳'
        const msg = data.status === 'completed'
          ? `${status} ${data.tool} completed`
          : `${status} Using ${data.tool}...`
        addMessageRef.current?.('system', msg, data.tool, 'log')
        // Increment research tool counter
        setActiveResearch(prev => prev ? { ...prev, toolCount: prev.toolCount + 1 } : null)
      } else if (data.type === 'claude_output') {
        // Raw Claude output for chat bubbles (full formatting preserved)
        console.log('🤖 Claude output:', {
          textLength: data.text?.length,
          isStreaming: data.isStreaming,
          isFinal: data.isFinal,
          agentRole: data.agentRole,
          preview: data.text?.substring(0, 100)
        })
        if (data.text && data.text.trim()) {
          // Direct mode: show as main chat message (visible immediately)
          // Realtime mode: show as log (research agent output, not primary chat)
          const category = data.agentRole === 'direct' ? 'chat' : 'log'
          // Compaction inline bubble — surfaces in this handler because the
          // agent uses claude_output as the carrier (see buildOnCompactionEvent
          // in agent/src/index.ts). If the bubble doesn't show, look here:
          // is the text empty? is agentRole something other than 'direct'?
          if (data.text.startsWith('🧠')) {
            console.log('[COMPACT-FRONTEND-BUBBLE] adding compaction chat bubble, category=', category, 'preview=', data.text.substring(0, 80))
          }
          addMessageRef.current?.('assistant', data.text, undefined, category)
        }
      } else if (data.type === 'permission_request') {
        // YOLO intercept: if the user has turned on auto-approve, respond
        // immediately with `allow` and skip the modal entirely. The agent
        // still sends requests (we don't want to teach it to stop asking —
        // server-side write safety lives in its PreToolUse hook) we just
        // answer them instantly here.
        if (autoApprovePermissionsRef.current) {
          const filePath = data.input?.file_path
          const payload = new TextEncoder().encode(JSON.stringify({
            type: 'permission_response',
            response: 'allow',
            ...(filePath ? { filePath: String(filePath) } : {}),
          }))
          sendToAgent(payload, { reliable: true })
          console.log(`⚡ [perm] auto-approved (YOLO on): ${data.toolName}`)
          addMessageRef.current?.('system', `Auto-approved: ${data.toolName}`, undefined, 'log')
          return
        }
        setPendingPermission({
          toolName: data.toolName,
          description: data.description,
          input: data.input,
          riskLevel: getToolRiskLevel(data.toolName),
          diff: data.diff,
        })
        console.log(`🔍 [perm] received permission_request: diff=${data.diff ? `✅ ${data.diff.length} chars` : '❌ NONE'} toolName=${data.toolName}`)
      } else if (data.type === 'permission_response') {
        setPendingPermission(null)
      } else if (data.type === 'status_update') {
        // Status updates from background tasks
        if (data.summary && data.summary.trim()) {
          console.log('📊 Status update:', data.summary.substring(0, 50))
          // Only show meaningful status updates, not "No active tasks"
          if (!data.summary.includes('No active tasks')) {
            addMessageRef.current?.('system', data.summary, undefined, 'log')
          }
        }
      } else if (data.type === 'progress_update') {
        // Real-time progress updates during research
        if (data.text && data.text.trim()) {
          console.log('🔄 Progress update:', data.text.substring(0, 50))
          addMessageRef.current?.('system', `Progress: ${data.text}`, undefined, 'log')
        }
      } else if (data.type === 'sessions_list') {
        // Received list of previous sessions
        console.log('📋 Sessions list:', data.sessions?.length || 0)
        setSessions(data.sessions || [])
        setIsLoadingSessions(false)
      } else if (data.type === 'current_session') {
        // Current session info
        console.log('📋 Current session:', data.sessionId)
        setCurrentSessionId(data.sessionId || null)
      } else if (data.type === 'session_resume_set') {
        // Session resume confirmation
        if (data.success) {
          console.log('🔄 Session resume set:', data.sessionId)
          setCurrentSessionId(data.sessionId)
          addMessageRef.current?.('system', '🔄 Resuming session...')
        } else {
          console.log('❌ Session resume failed:', data.error)
          addMessageRef.current?.('system', `❌ ${data.error || 'Failed to resume session'}`)
        }
      } else if (data.type === 'session_resume_failed') {
        // SDK created a new session instead of resuming the requested one
        console.warn('⚠️ Session resume verification failed:', data)
        addMessageRef.current?.('system', `⚠️ Could not restore previous session. Starting fresh conversation.`)
        setCurrentSessionId(data.actualSessionId)
      } else if (data.type === 'session_switched') {
        // Handle mid-conversation session switch
        if (data.success) {
          setCurrentSessionId(data.sessionId)

          // Clear previous session's files
          setGeneratedFiles([])
          setSelectedFilePath(null)

          // Clear current chat messages before showing new context
          setMessages([])

          // Show previous session context if available
          if (data.conversationHistory?.length > 0) {
            // Add last few exchanges as context
            addMessageRef.current?.('system', '─── Previous Session Context ───')
            for (const exchange of data.conversationHistory.slice(-3)) {
              addMessageRef.current?.(
                exchange.role === 'user' ? 'user' : 'assistant',
                exchange.content
              )
            }
            addMessageRef.current?.('system', '─── Session Resumed ───')
          }

          // Show summary in chat
          const summary = data.summary
          addMessageRef.current?.('system',
            `🔄 Switched to session (${summary?.messageCount || 0} messages)`
          )
        } else {
          addMessageRef.current?.('system', `❌ Failed to switch: ${data.error}`)
        }
      } else if (data.type === 'plan_file_updated') {
        // Plan file was written/edited by the agent
        console.log('📋 Plan file updated:', data.fileName)
        const fileName = data.fileName || data.filePath.split('/').pop() || 'plan.md'
        setGeneratedFiles((prev) => {
          const existing = prev.findIndex(f => f.filePath === data.filePath)
          const entry: GeneratedFile = {
            filePath: data.filePath,
            fileName,
            type: 'plan',
            source: 'plan',
            updatedAt: new Date(),
          }
          if (existing >= 0) {
            const updated = [...prev]
            updated[existing] = { ...updated[existing], ...entry, content: undefined }
            return updated
          }
          return [...prev, entry]
        })
        // Auto-request content
        const encoder = new TextEncoder()
        const payload = encoder.encode(JSON.stringify({
          type: 'get_plan_file',
          filePath: data.filePath,
        }))
        sendToAgent(payload, { reliable: true })
        setIsFilesModalOpen(true)
        setSelectedFilePath(data.filePath)
      } else if (data.type === 'plan_file_content') {
        // Plan file content received
        console.log('📋 Plan file content received:', data.fileName, data.content?.length || 0, 'chars')
        setGeneratedFiles((prev) => prev.map(f =>
          f.filePath === data.filePath
            ? { ...f, content: data.content || data.error || 'Empty file' }
            : f
        ))
      } else if (data.type === 'research_artifact_updated') {
        // Research artifact was written/edited by the agent
        console.log('🔬 Research artifact updated:', data.fileName)
        const fileName = data.fileName || data.filePath.split('/').pop() || 'artifact'
        const ext = fileName.split('.').pop()?.toLowerCase() || ''
        let fileType: GeneratedFile['type'] = 'other'
        if (fileName.includes('plan')) fileType = 'plan'
        else if (ext === 'mmd' || ext === 'mermaid') fileType = 'diagram'
        else if (ext === 'html' || ext === 'htm') fileType = 'html'
        else if (ext === 'md') fileType = 'notes'
        else if (ext === 'svg') fileType = 'diagram'
        else if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) fileType = 'image'
        else if (fileName.includes('summary')) fileType = 'summary'

        setGeneratedFiles((prev) => {
          const existing = prev.findIndex(f => f.filePath === data.filePath)
          const entry: GeneratedFile = {
            filePath: data.filePath,
            fileName,
            type: fileType,
            source: 'research',
            updatedAt: new Date(),
          }
          if (existing >= 0) {
            const updated = [...prev]
            updated[existing] = { ...updated[existing], ...entry, content: undefined }
            return updated
          }
          return [...prev, entry]
        })
        // Auto-request content
        const encoder = new TextEncoder()
        const payload = encoder.encode(JSON.stringify({
          type: 'get_research_artifact',
          filePath: data.filePath,
        }))
        sendToAgent(payload, { reliable: true })
        setIsFilesModalOpen(true)
        setSelectedFilePath(data.filePath)
      } else if (data.type === 'research_artifact_content') {
        // Research artifact content received. Prefer `data.url` (agent
        // uploaded to Supabase Storage — fetch on demand, no data channel
        // strain) over inline `data.content` (legacy fallback path).
        if (data.url) {
          console.log('🔬 Research artifact URL received:', data.fileName, '→', data.url.substring(0, 60) + '...')
        } else {
          console.log('🔬 Research artifact inline content received:', data.fileName, data.isImage ? 'image' : `${data.content?.length || 0} chars`, data.truncated ? '(truncated)' : '')
        }
        setGeneratedFiles((prev) => prev.map(f =>
          f.filePath === data.filePath
            ? {
                ...f,
                url: data.url || undefined,
                content: data.url ? undefined : (data.content || data.error || 'Empty file'),
                isImage: data.isImage || false,
                mimeType: data.mimeType,
                truncated: data.truncated || false,
                originalSize: data.originalSize,
              }
            : f
        ))
        // Surface meeting-todos.md content into the dedicated meeting panel.
        // The agent writes/edits this file repeatedly while in a meeting, so
        // every research_artifact_content for it should keep the panel fresh.
        if (data.fileName === 'meeting-todos.md' && typeof data.content === 'string') {
          setMeetingTodosContent(data.content)
          setMeetingTodosUpdatedAt(Date.now())
        }
      } else if (data.type === 'session_artifacts') {
        // Bulk load existing session artifacts on resume/switch
        console.log('📁 Session artifacts received:', data.artifacts?.length || 0)
        if (data.artifacts && Array.isArray(data.artifacts)) {
          const newFiles: GeneratedFile[] = data.artifacts.map((a: any) => {
            const ext = a.fileName.split('.').pop()?.toLowerCase() || ''
            const isImage = ['png', 'jpg', 'jpeg', 'svg', 'gif', 'webp'].includes(ext)
            return {
              filePath: a.filePath,
              fileName: a.fileName,
              type: a.type as GeneratedFile['type'],
              source: 'research' as const,
              updatedAt: new Date(a.updatedAt),
              isImage,
              mimeType: isImage ? `image/${ext}` : undefined,
            }
          })

          setGeneratedFiles((prev) => {
            const existingPaths = new Set(prev.map(f => f.filePath))
            const uniqueNew = newFiles.filter(f => !existingPaths.has(f.filePath))
            return [...prev, ...uniqueNew]
          })

          // Auto-select first file and request its content
          if (newFiles.length > 0) {
            setSelectedFilePath(newFiles[0].filePath)
            for (const file of newFiles) {
              const encoder = new TextEncoder()
              const payload = encoder.encode(JSON.stringify({
                type: 'get_research_artifact',
                filePath: file.filePath,
              }))
              sendToAgent(payload, { reliable: true })
            }
          }
        }
      } else if (data.type === 'fast_brain_response') {
        // Pipeline mode: Gemini fast brain parallel response — show in main chat for monitoring
        if (data.text && data.text.trim()) {
          const tools = data.toolsUsed?.length ? ` [${data.toolsUsed.join(',')}]` : ''
          const label = `\u26A1 Fast Brain (${data.elapsedMs}ms) [${data.responseType}]${tools}`
          console.log(`\uD83E\uDDE0\u26A1 Fast brain response:`, data)
          addMessageRef.current?.('assistant', `${label}\n${data.text}`, 'fast-brain', 'chat')
        }
      } else if (data.type === 'mcp_status' || data.type === 'mcp_servers_changed') {
        // MCP server status update
        console.log('🔌 MCP status update:', data.enabledKeys)
        if (data.mcpServers && Array.isArray(data.mcpServers)) {
          const enabledKeys: string[] = data.enabledKeys || []
          const merged = data.mcpServers.map((s: McpServerStatus) => ({
            ...s,
            enabled: enabledKeys.includes(s.serverKey),
          }))
          setMcpServers(merged)
        }
      } else if (data.type === 'mcp_toggle_result') {
        // MCP toggle confirmation from backend
        console.log('🔌 MCP toggle result:', data.serverKey, data.success)
        if (data.success && data.mcpServers && Array.isArray(data.mcpServers)) {
          const enabledKeys: string[] = data.enabledKeys || []
          const merged = data.mcpServers.map((s: McpServerStatus) => ({
            ...s,
            enabled: enabledKeys.includes(s.serverKey),
          }))
          setMcpServers(merged)
        }
      } else if (data.type === 'skills_status') {
        if (data.skills && Array.isArray(data.skills)) {
          setSkills(data.skills)
        }
      } else if (data.type === 'skill_add_result') {
        if (data.success && data.skills) {
          setSkills(data.skills)
          setShowAddSkill(false)
          setNewSkillName('')
          setNewSkillContent('')
        }
      } else if (data.type === 'claude_auth_required') {
        console.log('🔑 Claude auth required')
        setClaudeAuthStatus('required')
        onAuthRequired?.()
      } else if (data.type === 'claude_auth_url') {
        console.log('🔗 Claude auth URL received')
        setClaudeAuthUrl(data.url)
        setClaudeAuthStatus('waiting')
      } else if (data.type === 'claude_auth_waiting_code') {
        console.log('🔑 Claude waiting for auth code')
        setClaudeAuthStatus('waiting_code')
      } else if (data.type === 'claude_auth_submitting') {
        console.log('🔑 Claude submitting auth code')
        setClaudeAuthStatus('submitting')
      } else if (data.type === 'claude_auth_complete') {
        console.log('✅ Claude auth complete')
        setClaudeAuthUrl(null)
        setClaudeAuthStatus('complete')
        // Auto-dismiss after 3 seconds
        setTimeout(() => setClaudeAuthStatus('none'), 3000)
        // Persist the OAuth token to the host-persistent layer so it survives
        // service container restarts (warm→running transitions). Without this,
        // credentials written inside the ephemeral container overlay are lost
        // and the user has to re-authenticate every time the sprite resumes.
        if (data.token) {
          fetch('/api/sandbox', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'persist-auth', token: data.token }),
          }).then(r => {
            if (r.ok) console.log('✅ OAuth token persisted to sprite host layer')
            else console.warn('⚠️ Failed to persist OAuth token:', r.status)
          }).catch(err => console.warn('⚠️ Failed to persist OAuth token:', err))
        }
      } else if (data.type === 'claude_auth_error') {
        console.log('❌ Claude auth error:', data.message)
        setClaudeAuthStatus('error')
      } else if (data.type === 'meeting_joining') {
        console.log('🎥 Meeting: joining...')
        setMeetingStatus('joining')
        setMeetingError(null)
        setMeetingTodosContent(null)
        setMeetingTodosUpdatedAt(null)
      } else if (data.type === 'meeting_joined') {
        console.log('🎥 Meeting: joined, botId:', data.botId)
        setMeetingBotId(data.botId)
        setMeetingStatus('joined')
      } else if (data.type === 'meeting_left') {
        console.log('🎥 Meeting: left')
        setMeetingBotId(null)
        setMeetingStatus('idle')
        // Keep meetingTodosContent visible after leave — user may want to
        // review the final TODO list. Cleared on next join.
      } else if (data.type === 'meeting_error') {
        console.log('❌ Meeting error:', data.message)
        setMeetingError(data.message)
        setMeetingStatus('error')
        setTimeout(() => { setMeetingStatus('idle'); setMeetingError(null) }, 5000)
      } else if (data.type === 'compaction_started') {
        // Detailed logging: if this fires but the banner doesn't update, look at
        // the state setter calls below. If banner DOES update but inline chat
        // bubble doesn't appear, look at the `claude_output` handler — the
        // agent emits a SEPARATE `claude_output` with `agentRole:'direct'` and
        // a 🧠 emoji to add the inline bubble (see agent/src/index.ts
        // buildOnCompactionEvent). Both events should fire in the same tick.
        console.log('[COMPACT-FRONTEND-RX] compaction_started trigger=', data.trigger, 'full=', JSON.stringify(data).substring(0, 200))
        setCompactionStatus('compacting')
        setCompactionStartedAt(Date.now())
        setCompactionStages([{ stage: 'Compaction triggered', detail: data.trigger ?? 'auto', ts: Date.now() }])
        setCompactionSkills([])
      } else if (data.type === 'compaction_progress') {
        console.log('[COMPACT-FRONTEND-RX] compaction_progress stage=', data.stage, 'detail=', data.detail ?? '')
        setCompactionStages(prev => [...prev, { stage: data.stage, detail: data.detail, ts: Date.now() }])
      } else if (data.type === 'bug_report') {
        // bug-reporter skill (agent-side) emitted a bug report. Forward to the
        // backend API which has the Supabase keys and will INSERT the row +
        // upload the log tail. Fire-and-forget — we don't block the voice UI on
        // Supabase round-trips. Errors are logged but not surfaced to the user;
        // the agent already told them "Filed."
        console.log('🪲 Bug report received from agent:', data.reportId, data.payload?.title)
        fetch('/api/sandbox', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'submit-bug-report',
            reportId: data.reportId,
            payload: data.payload,
            context: data.context || {},
            sessionId: preSelectedSessionId ?? null,
          }),
        }).catch((err) => console.error('[bug-report] submit-bug-report failed:', err))
      } else if (data.type === 'compaction_complete') {
        console.log('[COMPACT-FRONTEND-RX] compaction_complete skillsWritten=', data.skillsWritten, 'skills=', data.skillNames, 'full=', JSON.stringify(data).substring(0, 200))
        setCompactionStatus('complete')
        setCompactionSkills(Array.isArray(data.skillNames) ? data.skillNames : [])
        setCompactionStages(prev => [...prev, {
          stage: 'Memory crystallized',
          detail: `${data.skillsWritten ?? 0} skill${data.skillsWritten === 1 ? '' : 's'} updated`,
          ts: Date.now(),
        }])
        // Keep the success panel visible for 10s so the user has time to read it
        // (was 3s — far too brief on mobile where compaction announcements arrive
        // mid-voice-response and the user is listening, not staring at the screen).
        setTimeout(() => {
          setCompactionStatus('idle')
          setCompactionStages([])
          setCompactionSkills([])
          setCompactionStartedAt(null)
        }, 10000)
      } else {
        console.log('❓ Unknown message type:', data.type)
      }
    } catch (e) {
      console.error('❌ Failed to parse data message:', e)
    }
  }, [preSelectedSessionId, sendToAgent])

  // Subscribe to data channel with callback - this fires for EVERY message
  useDataChannel('osborn-updates', handleDataMessage)

  // Session management handlers
  const handleLoadSessions = useCallback(() => {
    setIsLoadingSessions(true)
    const encoder = new TextEncoder()
    const payload = encoder.encode(JSON.stringify({
      type: 'list_sessions',
    }))
    sendToAgent(payload, { reliable: true })
  }, [sendToAgent])

  const handleResumeSession = useCallback((sessionId: string) => {
    const encoder = new TextEncoder()
    const payload = encoder.encode(JSON.stringify({
      type: 'resume_session',
      sessionId,
    }))
    sendToAgent(payload, { reliable: true })
    addMessageRef.current?.('system', `🔄 Resuming session ${sessionId.substring(0, 8)}...`)
  }, [sendToAgent])

  const handleContinueSession = useCallback(() => {
    const encoder = new TextEncoder()
    const payload = encoder.encode(JSON.stringify({
      type: 'continue_session',
    }))
    sendToAgent(payload, { reliable: true })
    addMessageRef.current?.('system', '🔄 Continuing previous session...')
  }, [sendToAgent])

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
      console.warn(`⚠️ Payload too large (${payloadStr.length} bytes)`)
      if (isSupabaseConfigured()) {
        // Upload large text/payload to Supabase and send URL instead
        try {
          const blob = new Blob([text], { type: 'text/plain' })
          const uploadFile_ = new File([blob], `paste-${Date.now()}.txt`, { type: 'text/plain' })
          const result = await uploadFile(uploadFile_, 'files')
          if (result.success && result.url) {
            const uploadedPayload = JSON.stringify({
              type: 'user_text',
              content: text.substring(0, 200) + (text.length > 200 ? '...[full content in attached file]' : ''),
              files: [{ name: uploadFile_.name, type: 'text', content: '', url: result.url }],
            })
            const encoder = new TextEncoder()
            sendToAgent(encoder.encode(uploadedPayload), { reliable: true })
            addMessageRef.current?.('system', `Large message uploaded (${(text.length / 1024).toFixed(1)} KB)`)
            return
          }
        } catch (err) {
          console.error('Failed to upload large text to Supabase:', err)
        }
      }
      // Fallback: truncate with clear error
      addMessageRef.current?.('system', `Message too large for data channel (${(payloadStr.length / 1024).toFixed(0)} KB). Configure Supabase Storage to enable large messages.`)
      const truncated = text.substring(0, 50000) + '\n...[truncated — message exceeded size limit]'
      const smallPayload = JSON.stringify({ type: 'user_text', content: truncated })
      const encoder = new TextEncoder()
      sendToAgent(encoder.encode(smallPayload), { reliable: true })
    } else {
      const encoder = new TextEncoder()
      sendToAgent(encoder.encode(payloadStr), { reliable: true })
    }
  }, [sendToAgent])

  const handlePermissionResponse = useCallback((response: 'allow' | 'deny' | 'always_allow') => {
    const toolName = pendingPermission?.toolName || 'tool'
    const filePath = pendingPermission?.input?.file_path
    setPendingPermission(null)
    addMessageRef.current?.('system', `Permission ${response}: ${toolName}`)

    const encoder = new TextEncoder()
    const payload = encoder.encode(JSON.stringify({
      type: 'permission_response',
      response,
      ...(filePath ? { filePath: String(filePath) } : {}),
    }))
    sendToAgent(payload, { reliable: true })
  }, [sendToAgent, pendingPermission])

  // MCP server toggle handler
  const handleMcpToggle = useCallback((serverKey: string, enabled: boolean) => {
    // Optimistic update
    setMcpServers((prev) => prev.map(s =>
      s.serverKey === serverKey ? { ...s, enabled } : s
    ))
    const encoder = new TextEncoder()
    const payload = encoder.encode(JSON.stringify({
      type: 'mcp_toggle',
      serverKey,
      enabled,
    }))
    sendToAgent(payload, { reliable: true })
  }, [sendToAgent])

  // Request current MCP status
  const handleLoadMcpStatus = useCallback(() => {
    const encoder = new TextEncoder()
    const payload = encoder.encode(JSON.stringify({
      type: 'get_mcp_status',
    }))
    sendToAgent(payload, { reliable: true })
  }, [sendToAgent])

  // Meeting (Recall.ai) handlers
  const handleJoinMeeting = useCallback((meetingUrl: string) => {
    const encoder = new TextEncoder()
    const payload = encoder.encode(JSON.stringify({
      type: 'join_meeting',
      url: meetingUrl,
      webhookBase: agentUrl,
    }))
    sendToAgent(payload, { reliable: true })
  }, [sendToAgent, agentUrl])

  const handleLeaveMeeting = useCallback(() => {
    if (!meetingBotId) return
    const encoder = new TextEncoder()
    const payload = encoder.encode(JSON.stringify({
      type: 'leave_meeting',
      botId: meetingBotId,
    }))
    sendToAgent(payload, { reliable: true })
  }, [sendToAgent, meetingBotId])

  // Add a new skill
  const handleAddSkill = useCallback((name: string, content: string) => {
    const encoder = new TextEncoder()
    const payload = encoder.encode(JSON.stringify({
      type: 'skill_add',
      name,
      content,
    }))
    sendToAgent(payload, { reliable: true })
  }, [sendToAgent])

  // Helper: complete the session gate (unmute mic, send session_selected to backend)
  const completeSessionGate = useCallback((sessionId: string | null) => {
    setShowResumePrompt(false)
    setSessionGateCompleted(true)
    // Unmute mic now that user has made their choice
    setIsMuted(false)
    localParticipant?.setMicrophoneEnabled(true)
    // Notify backend of session choice so it can apply resume + send greeting
    const encoder = new TextEncoder()
    const payload = encoder.encode(JSON.stringify({
      type: 'session_selected',
      sessionId,
    }))
    sendToAgent(payload, { reliable: true })
  }, [localParticipant, sendToAgent])

  // Handle auto-resume prompt actions (must be before early returns to maintain hook order)
  const handleResumePromptContinue = useCallback(() => {
    if (recentSessionId) {
      handleResumeSession(recentSessionId)
    }
    completeSessionGate(recentSessionId)
  }, [recentSessionId, handleResumeSession, completeSessionGate])

  const handleResumePromptStartFresh = useCallback(() => {
    completeSessionGate(null)
    addMessageRef.current?.('system', '🆕 Starting a fresh session')
  }, [completeSessionGate])

  if (waitingMode) {
    return (
      <>
        {/* Claude Auth Modal — must render even in waiting mode for cloud deployments */}
        {claudeAuthStatus !== 'none' && claudeAuthStatus !== 'complete' && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
            <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 max-w-md mx-4 shadow-2xl">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center shrink-0">
                  <span className="text-xl">🔑</span>
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-lg font-semibold text-white">Claude Authentication</h3>
                  <p className="text-sm text-gray-400">
                    {claudeAuthStatus === 'error' ? 'Authentication failed' : 'Sign in to your Anthropic account'}
                  </p>
                </div>
                <button onClick={() => setClaudeAuthStatus('none')}
                  className="p-1.5 rounded-lg text-gray-500 hover:text-gray-300 hover:bg-gray-800 transition-all shrink-0"
                  title="Dismiss">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              {claudeAuthStatus === 'required' && (
                <div className="flex items-center gap-2 text-gray-300 text-sm">
                  <div className="animate-spin w-4 h-4 border-2 border-gray-500 border-t-amber-400 rounded-full" />
                  <span>Preparing login...</span>
                </div>
              )}
              {(claudeAuthStatus === 'waiting' || claudeAuthStatus === 'waiting_code') && claudeAuthUrl && (
                <div className="space-y-3">
                  <p className="text-sm text-gray-300">
                    Sign in with your own Anthropic account &mdash; use this device or your phone.
                  </p>
                  <p className="text-xs text-gray-400 leading-relaxed">
                    After authorizing you&apos;ll land on a page that says
                    &ldquo;connection refused&rdquo; or similar &mdash; that&apos;s expected. The code is in
                    the browser&apos;s address bar: find <code className="text-amber-400">code=</code>&hellip; and
                    copy everything up to the next <code className="text-amber-400">&amp;</code>, then paste
                    it below.
                  </p>
                  <a
                    href={claudeAuthUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block w-full text-center px-4 py-2.5 bg-amber-600 hover:bg-amber-500 text-white font-medium rounded-lg transition-colors"
                  >
                    Sign in to Claude
                  </a>
                  <div className="mt-3">
                    <label className="block text-xs text-gray-400 mb-1">Paste authentication code:</label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={claudeAuthCode}
                        onChange={(e) => setClaudeAuthCode(e.target.value)}
                        placeholder="Paste code here..."
                        className="flex-1 px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-amber-500"
                      />
                      <button
                        onClick={() => {
                          if (claudeAuthCode.trim()) {
                            const payload = new TextEncoder().encode(JSON.stringify({ type: 'claude_auth_code', code: claudeAuthCode.trim() }))
                            sendToAgent(payload, { reliable: true })
                            setClaudeAuthCode('')
                          }
                        }}
                        disabled={!claudeAuthCode.trim()}
                        className="px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium rounded-lg transition-colors"
                      >
                        Submit
                      </button>
                    </div>
                  </div>
                </div>
              )}
              {claudeAuthStatus === 'waiting_code' && !claudeAuthUrl && (
                <div className="space-y-3">
                  <p className="text-sm text-gray-300">
                    Paste the authentication code from the browser:
                  </p>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={claudeAuthCode}
                      onChange={(e) => setClaudeAuthCode(e.target.value)}
                      placeholder="Paste code here..."
                      autoFocus
                      className="flex-1 px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-amber-500"
                    />
                    <button
                      onClick={() => {
                        if (claudeAuthCode.trim()) {
                          const payload = new TextEncoder().encode(JSON.stringify({ type: 'claude_auth_code', code: claudeAuthCode.trim() }))
                          sendToAgent(payload, { reliable: true })
                          setClaudeAuthCode('')
                        }
                      }}
                      disabled={!claudeAuthCode.trim()}
                      className="px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium rounded-lg transition-colors"
                    >
                      Submit
                    </button>
                  </div>
                </div>
              )}
              {claudeAuthStatus === 'submitting' && (
                <div className="flex items-center gap-2 text-gray-300 text-sm">
                  <div className="animate-spin w-4 h-4 border-2 border-gray-500 border-t-amber-400 rounded-full" />
                  <span>Submitting code to Claude...</span>
                </div>
              )}
              {claudeAuthStatus === 'error' && (
                <div className="space-y-3">
                  <p className="text-sm text-red-400">
                    Authentication failed. The agent will fall back to API key authentication if available.
                  </p>
                  <button
                    onClick={() => setClaudeAuthStatus('none')}
                    className="w-full px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg transition-colors"
                  >
                    Dismiss
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
        <div className="w-full p-6 text-center">
          <div className="flex flex-col items-center gap-3">
            <div className="relative">
              <div className="w-3 h-3 bg-amber-500 rounded-full animate-ping absolute" />
              <div className="w-3 h-3 bg-amber-500 rounded-full" />
            </div>
            <span className="text-gray-400 text-sm">
              {claudeAuthStatus !== 'none' ? 'Authenticating Claude...' : 'Connecting to agent...'}
            </span>
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      {/* Claude Auth Modal — shown during first-time OAuth flow in cloud deployments */}
      {claudeAuthStatus !== 'none' && claudeAuthStatus !== 'complete' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 max-w-md mx-4 shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center shrink-0">
                <span className="text-xl">🔑</span>
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-lg font-semibold text-white">Claude Authentication</h3>
                <p className="text-sm text-gray-400">
                  {claudeAuthStatus === 'error' ? 'Authentication failed' : 'Sign in to your Anthropic account'}
                </p>
              </div>
              <button onClick={() => setClaudeAuthStatus('none')}
                className="p-1.5 rounded-lg text-gray-500 hover:text-gray-300 hover:bg-gray-800 transition-all shrink-0"
                title="Dismiss">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {claudeAuthStatus === 'required' && (
              <div className="flex items-center gap-2 text-gray-300 text-sm">
                <div className="animate-spin w-4 h-4 border-2 border-gray-500 border-t-amber-400 rounded-full" />
                <span>Preparing login...</span>
              </div>
            )}

            {claudeAuthStatus === 'waiting' && claudeAuthUrl && (
              <div className="space-y-3">
                <p className="text-sm text-gray-300">
                  Click below to sign in, then paste the authentication code you receive.
                </p>
                <a
                  href={claudeAuthUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block w-full text-center px-4 py-2.5 bg-amber-600 hover:bg-amber-500 text-white font-medium rounded-lg transition-colors"
                >
                  Sign in to Claude
                </a>
                <div className="mt-3">
                  <label className="block text-xs text-gray-400 mb-1">Paste authentication code:</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={claudeAuthCode}
                      onChange={(e) => setClaudeAuthCode(e.target.value)}
                      placeholder="Paste code here..."
                      autoFocus
                      className="flex-1 px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-amber-500"
                    />
                    <button
                      onClick={() => {
                        if (claudeAuthCode.trim()) {
                          const payload = new TextEncoder().encode(JSON.stringify({ type: 'claude_auth_code', code: claudeAuthCode.trim() }))
                          sendToAgent(payload, { reliable: true })
                          setClaudeAuthCode('')
                        }
                      }}
                      disabled={!claudeAuthCode.trim()}
                      className="px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium rounded-lg transition-colors"
                    >
                      Submit
                    </button>
                  </div>
                </div>
              </div>
            )}

            {claudeAuthStatus === 'waiting_code' && (
              <div className="space-y-3">
                <p className="text-sm text-gray-300">
                  Paste the authentication code from the browser:
                </p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={claudeAuthCode}
                    onChange={(e) => setClaudeAuthCode(e.target.value)}
                    placeholder="Paste code here..."
                    autoFocus
                    className="flex-1 px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-amber-500"
                  />
                  <button
                    onClick={() => {
                      if (claudeAuthCode.trim()) {
                        const payload = new TextEncoder().encode(JSON.stringify({ type: 'claude_auth_code', code: claudeAuthCode.trim() }))
                        sendToAgent(payload, { reliable: true })
                        setClaudeAuthCode('')
                      }
                    }}
                    disabled={!claudeAuthCode.trim()}
                    className="px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium rounded-lg transition-colors"
                  >
                    Submit
                  </button>
                </div>
              </div>
            )}

            {claudeAuthStatus === 'submitting' && (
              <div className="flex items-center gap-2 text-gray-300 text-sm">
                <div className="animate-spin w-4 h-4 border-2 border-gray-500 border-t-amber-400 rounded-full" />
                <span>Submitting code to Claude...</span>
              </div>
            )}

            {claudeAuthStatus === 'error' && (
              <p className="text-sm text-red-400">
                Authentication failed. Check the agent logs for details. The agent will fall back to API key authentication if available.
              </p>
            )}
          </div>
        </div>
      )}

      {pendingPermission && (
        <PermissionModal
          permission={pendingPermission}
          onRespond={handlePermissionResponse}
        />
      )}

      {/* Session browser modal - shows list of previous sessions */}
      {showResumePrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 max-w-md mx-4 shadow-2xl max-h-[80vh] flex flex-col">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center">
                <span className="text-xl">📂</span>
              </div>
              <div>
                <h3 className="text-lg font-semibold text-white">Previous Sessions</h3>
                <p className="text-sm text-gray-400">Continue or start fresh</p>
              </div>
            </div>

            {/* Session list with date grouping */}
            {sessions.length > 0 ? (
              <div className="flex-1 overflow-y-auto space-y-1 mb-4 max-h-96">
                {groupSessionsByDate(sessions).map((group) => (
                  <div key={group.label}>
                    <div className="sticky top-0 bg-gray-900/95 backdrop-blur-sm px-2 py-1.5 border-b border-gray-800/50">
                      <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">{group.label}</span>
                    </div>
                    <div className="space-y-1 p-1">
                      {group.sessions.map((session, index) => (
                        <button
                          key={session.sessionId}
                          onClick={() => {
                            handleResumeSession(session.sessionId)
                            completeSessionGate(session.sessionId)
                          }}
                          className={`w-full text-left p-3 rounded-lg border transition-colors ${
                            group.label === 'Today' && index === 0
                              ? 'border-amber-500 bg-amber-500/10'
                              : 'border-gray-700 hover:border-gray-500'
                          }`}
                        >
                          <div className="flex justify-between items-start">
                            <span className="text-sm font-medium text-white">
                              {formatTime(session.timestamp)}
                              {group.label === 'Today' && index === 0 && <span className="ml-2 text-amber-400">(Latest)</span>}
                            </span>
                            <span className="text-xs text-gray-500">{session.messageCount} msgs</span>
                          </div>
                          {session.lastMessage && (
                            <p className="text-xs text-gray-400 mt-1 truncate">{session.lastMessage}</p>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-gray-400 text-sm mb-4">No previous sessions found.</p>
            )}

            {/* Start Fresh button */}
            <button
              onClick={handleResumePromptStartFresh}
              className="w-full py-2.5 bg-gray-700 hover:bg-gray-600 text-white rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
            >
              <span>🆕</span>
              Start Fresh
            </button>
          </div>
        </div>
      )}

      <div className="w-full h-[100dvh] sm:h-[85vh] flex gap-3 transition-all duration-300 max-w-[90rem]">
      <div className="flex-1 min-w-0 flex flex-col bg-gradient-to-b from-gray-900 to-gray-950 sm:rounded-2xl overflow-hidden border-0 sm:border border-gray-800/50 shadow-2xl">
        {/* Header - Streamlined */}
        <div className="relative z-30 px-2 sm:px-3 py-2 border-b border-gray-800/50 bg-gray-900/50 backdrop-blur-sm">
          <div className="flex items-center gap-2 sm:gap-3">
            {/* Visualizer — only visible when speaking */}
            {state === 'speaking' && <VoiceVisualizer state={state} audioTrack={audioTrack} />}

            {/* Status */}
            <StatusIndicator state={agentState !== 'idle' ? agentState : state} isMuted={isMuted} />

            {/* Compaction status pill — header-level summary (always visible during compact) */}
            {compactionStatus !== 'idle' && (
              <div className={`flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-semibold transition-all duration-300 ${
                compactionStatus === 'compacting'
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-[0_0_12px_rgba(245,158,11,0.3)]'
                  : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-[0_0_12px_rgba(16,185,129,0.3)]'
              }`}>
                {compactionStatus === 'compacting' ? (
                  <>
                    <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    <span>Crystallizing memory&hellip;</span>
                  </>
                ) : (
                  <>
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                    <span>{compactionSkills.length > 0 ? `${compactionSkills.length} skill${compactionSkills.length === 1 ? '' : 's'} updated` : 'Memory crystallized'}</span>
                  </>
                )}
              </div>
            )}

            {/* Control Menu (Mode + History + Tools) — hidden on mobile */}
            <div className="hidden sm:block"><ControlMenu
              sessions={sessions}
              currentSessionId={currentSessionId}
              onLoadSessions={handleLoadSessions}
              onResumeSession={handleResumeSession}
              onContinueSession={handleContinueSession}
              isLoadingSessions={isLoadingSessions}
              disabled={!agentConnected}
              mcpServers={mcpServers}
              onMcpToggle={handleMcpToggle}
              onLoadMcpStatus={handleLoadMcpStatus}
              skills={skills}
              onAddSkill={handleAddSkill}
              showAddSkill={showAddSkill}
              setShowAddSkill={setShowAddSkill}
              newSkillName={newSkillName}
              setNewSkillName={setNewSkillName}
              newSkillContent={newSkillContent}
              setNewSkillContent={setNewSkillContent}
            /></div>

            {/* Mobile menu button */}
            <button onClick={() => setShowMobileMenu(true)}
              className="sm:hidden p-2 rounded-lg bg-gray-800/50 text-gray-400 hover:text-gray-200 hover:bg-gray-700/50 transition-all">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>

            {/* Spacer */}
            <div className="flex-1" />

            {/* Compact Controls — meeting/files/copy hidden on mobile */}
            <div className="flex items-center gap-1.5">
              {/* Meeting button — hidden on mobile */}
              {meetingStatus === 'joined' ? (
                <button
                  onClick={handleLeaveMeeting}
                  className="hidden sm:flex px-2.5 py-1.5 rounded-lg transition-all bg-green-500/20 text-green-400 hover:bg-red-500/20 hover:text-red-400 text-xs font-medium items-center gap-1.5 border border-green-500/30 hover:border-red-500/30"
                  title="Leave meeting"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                  In Meeting
                </button>
              ) : meetingStatus === 'joining' ? (
                <span className="hidden sm:flex px-2.5 py-1.5 rounded-lg bg-yellow-500/20 text-yellow-400 text-xs font-medium items-center gap-1.5 border border-yellow-500/30">
                  <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
                  </svg>
                  Joining...
                </span>
              ) : (
                <button
                  onClick={() => {
                    const url = prompt('Paste your Zoom or Google Meet URL:')
                    if (url?.trim()) handleJoinMeeting(url.trim())
                  }}
                  disabled={!agentConnected}
                  className={`hidden sm:block p-2 rounded-lg transition-all ${
                    !agentConnected
                      ? 'bg-gray-800/30 text-gray-600 cursor-not-allowed'
                      : 'bg-gray-800/50 text-gray-400 hover:bg-gray-700/50 hover:text-gray-200'
                  }`}
                  title={meetingError || 'Join a meeting'}
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                </button>
              )}

              {/* Files button - hidden on mobile */}
              <button
                onClick={() => setIsFilesModalOpen(!isFilesModalOpen)}
                className={`hidden sm:block relative p-2 rounded-lg transition-all ${
                  isFilesModalOpen
                    ? 'bg-amber-500/20 text-amber-400'
                    : 'bg-gray-800/50 text-gray-400 hover:bg-gray-700/50 hover:text-gray-200'
                }`}
                title="Toggle files explorer"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                </svg>
                {generatedFiles.length > 0 && (
                  <span className="absolute -top-1 -right-1 w-4 h-4 bg-amber-500 text-white text-[10px] rounded-full flex items-center justify-center font-bold">
                    {generatedFiles.length}
                  </span>
                )}
              </button>

              {/* Auto-approve (YOLO) toggle — always visible in the toolbar
                  so the user can flip it mid-conversation without waiting
                  for a permission modal. When ON, incoming permission_request
                  events are intercepted and answered 'allow' before the modal
                  renders (see handleDataMessage branch above). Icon swaps
                  between a lock (off) and a lightning bolt (on). */}
              <button
                onClick={() => setAutoApprovePermissions(v => !v)}
                className={`p-2 rounded-lg transition-all ${
                  autoApprovePermissions
                    ? 'bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 ring-1 ring-amber-500/50'
                    : 'bg-gray-800/50 text-gray-400 hover:bg-gray-700/50 hover:text-gray-200'
                }`}
                title={autoApprovePermissions
                  ? 'Auto-approve ON — all tool permissions accepted instantly. Click to turn off.'
                  : 'Auto-approve OFF — permission prompts appear. Click to enable YOLO mode.'}
              >
                {autoApprovePermissions ? (
                  // Lightning bolt — YOLO engaged
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                ) : (
                  // Shield-check — default safe mode (prompts appear)
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                  </svg>
                )}
              </button>

              {/* Copy All Messages button — hidden on mobile */}
              <button
                onClick={handleCopyAllMessages}
                disabled={messages.length === 0}
                className={`hidden sm:block p-2 rounded-lg transition-all ${
                  copyFeedback
                    ? 'bg-green-500/20 text-green-400'
                    : messages.length === 0
                      ? 'bg-gray-800/30 text-gray-600 cursor-not-allowed'
                      : 'bg-gray-800/50 text-gray-400 hover:bg-gray-700/50 hover:text-gray-200'
                }`}
                title={copyFeedback ? 'Copied!' : 'Copy all messages'}
              >
                {copyFeedback ? (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                )}
              </button>

              {/* Mute button */}
              <button
                onClick={toggleMute}
                className={`p-2 rounded-lg transition-all ${
                  isMuted
                    ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
                    : 'bg-gray-800/50 text-gray-400 hover:bg-gray-700/50 hover:text-gray-200'
                }`}
                title={isMuted ? 'Unmute' : 'Mute'}
              >
                {isMuted ? (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                  </svg>
                )}
              </button>

              {/* Disconnect button - prominent to save LiveKit minutes */}
              {onDisconnect && (
                <button
                  onClick={onDisconnect}
                  className="p-2 rounded-lg transition-all bg-red-500/20 text-red-400 hover:bg-red-500/40 hover:text-red-300 border border-red-500/30"
                  title="Disconnect (saves LiveKit minutes)"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 8l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2M5 3a2 2 0 00-2 2v1c0 8.284 6.716 15 15 15h1a2 2 0 002-2v-3.28a1 1 0 00-.684-.948l-4.493-1.498a1 1 0 00-1.21.502l-1.13 2.257a11.042 11.042 0 01-5.516-5.517l2.257-1.128a1 1 0 00.502-1.21L9.228 3.683A1 1 0 008.279 3H5z" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Prominent compaction banner — sits above chat during PreCompact→PostCompact window.
            Visible for the full duration (typically 1–3 min), rolling stages keep the user
            informed something is happening. Replaces the older 3-second flash pill which
            users routinely missed. */}
        {compactionStatus !== 'idle' && (
          <div className={`px-3 sm:px-4 py-2.5 border-b transition-all duration-500 ${
            compactionStatus === 'compacting'
              ? 'bg-gradient-to-r from-amber-500/10 via-amber-500/15 to-amber-500/10 border-amber-500/30'
              : 'bg-gradient-to-r from-emerald-500/10 via-emerald-500/15 to-emerald-500/10 border-emerald-500/30'
          }`}>
            <div className="flex items-start gap-2.5 max-w-3xl mx-auto">
              <div className={`shrink-0 mt-0.5 ${compactionStatus === 'compacting' ? 'text-amber-400' : 'text-emerald-400'}`}>
                {compactionStatus === 'compacting' ? (
                  <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className={`text-sm font-semibold ${compactionStatus === 'compacting' ? 'text-amber-300' : 'text-emerald-300'}`}>
                  {compactionStatus === 'compacting'
                    ? `Crystallizing session memory${compactionStartedAt ? ` · ${Math.floor((Date.now() - compactionStartedAt) / 1000)}s` : ''}`
                    : `Memory crystallized — ${compactionSkills.length} skill${compactionSkills.length === 1 ? '' : 's'} updated`}
                </div>
                {compactionStages.length > 0 && (
                  <div className="mt-1 text-xs text-gray-400 space-y-0.5 max-h-24 overflow-y-auto">
                    {compactionStages.slice(-6).map((s, i) => (
                      <div key={`${s.ts}-${i}`} className="flex items-center gap-1.5">
                        <span className="text-gray-600">›</span>
                        <span className="text-gray-300">{s.stage}</span>
                        {s.detail && <span className="text-gray-500">— {s.detail}</span>}
                      </div>
                    ))}
                  </div>
                )}
                {compactionStatus === 'complete' && compactionSkills.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {compactionSkills.map(name => (
                      <span key={name} className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 font-mono">
                        {name}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Meeting TODO panel — visible whenever there's meeting-todos.md
            content. Shows a scannable view of the agent's running notes from
            the meeting. Stays visible after leaving the meeting so the user
            can review; cleared on the next meeting join. */}
        {(meetingStatus === 'joined' || meetingTodosContent) && (
          <div className="px-3 sm:px-4 py-2.5 border-b bg-gradient-to-r from-blue-500/10 via-indigo-500/10 to-blue-500/10 border-blue-500/30">
            <div className="max-w-3xl mx-auto">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-blue-300 text-sm font-semibold flex items-center gap-1.5">
                  <svg className={`w-3.5 h-3.5 ${meetingStatus === 'joined' ? 'text-blue-400 animate-pulse' : 'text-blue-400/60'}`} fill="currentColor" viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="6" />
                  </svg>
                  Meeting notes
                </span>
                {meetingStatus === 'joined' && <span className="text-[10px] text-blue-400/70">listening · poll every 30s</span>}
                {meetingTodosUpdatedAt && (
                  <span className="text-[10px] text-gray-500 ml-auto">updated {Math.floor((Date.now() - meetingTodosUpdatedAt) / 1000)}s ago</span>
                )}
              </div>
              {meetingTodosContent ? (
                <div className="text-xs text-gray-300 whitespace-pre-wrap max-h-48 overflow-y-auto font-mono leading-relaxed">
                  {meetingTodosContent}
                </div>
              ) : (
                <div className="text-xs text-gray-500 italic">
                  Waiting for the first transcript chunk…
                </div>
              )}
            </div>
          </div>
        )}

        {/* Chat */}
        <ChatPanel
          messages={messages}
          onSuggestionClick={(text) => handleSendText(text)}
          activeResearch={activeResearch}
        />

        {/* Logs drawer */}
        <LogsDrawer messages={messages.filter(m => m.category === 'log')} />

        {/* Input */}
        <TextInput
          onSend={handleSendText}
          attachedFiles={attachedFiles}
          onAttachFile={handleAttachFile}
          onRemoveFile={handleRemoveFile}
        />
      </div>

      {/* Inline files preview panel — hidden on mobile */}
      {showFilesPanel && (
        <div className="hidden sm:flex w-[28rem] shrink-0 flex-col bg-gray-900 rounded-2xl overflow-hidden border border-gray-800/50 shadow-2xl">
          {/* Panel header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700/50">
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
              <span className="text-sm font-semibold text-white">Files</span>
              <span className="text-xs text-gray-500">({generatedFiles.length})</span>
            </div>
            <div className="flex items-center gap-2">
              {generatedFiles.filter(f => !f.isImage).length > 1 && (
                <button
                  onClick={handleCopyAllFiles}
                  className={`px-2 py-1 text-xs rounded transition-colors ${
                    fileCopyFeedback === 'all'
                      ? 'bg-green-500/20 text-green-400'
                      : 'bg-gray-800 text-gray-400 hover:text-gray-200'
                  }`}
                >
                  {fileCopyFeedback === 'all' ? 'Copied!' : 'Copy All'}
                </button>
              )}
              <button
                onClick={() => setIsFilesModalOpen(true)}
                className="p-1 text-gray-400 hover:text-white rounded transition-colors"
                title="Expand files explorer"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5v-4m0 4h-4m4 0l-5-5" />
                </svg>
              </button>
              <button
                onClick={() => setShowFilesPanel(false)}
                className="p-1 text-gray-400 hover:text-white rounded transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          {/* File browser - compact list */}
          <div className="border-b border-gray-700/50 max-h-52 overflow-y-auto">
            {generatedFiles.filter(f => f.source === 'plan').length > 0 && (
              <div>
                <div className="px-3 py-1.5 text-[10px] font-semibold text-gray-500 uppercase tracking-wider bg-gray-800/30">
                  Plans
                </div>
                {generatedFiles.filter(f => f.source === 'plan').map((file) => (
                  <button
                    key={file.filePath}
                    onClick={() => setSelectedFilePath(file.filePath)}
                    className={`w-full text-left px-3 py-2 flex items-center gap-2 transition-colors ${
                      selectedFile?.filePath === file.filePath
                        ? 'bg-amber-500/15 border-l-2 border-amber-400'
                        : 'hover:bg-gray-800/50 border-l-2 border-transparent'
                    }`}
                  >
                    <span className="px-1.5 py-0.5 text-[9px] font-bold rounded bg-amber-500/20 text-amber-400">Plan</span>
                    <span className="text-xs font-mono text-gray-300 truncate flex-1">{file.fileName}</span>
                    {!file.content && (
                      <svg className="w-3 h-3 animate-spin text-gray-500 shrink-0" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                    )}
                  </button>
                ))}
              </div>
            )}
            {generatedFiles.filter(f => f.source === 'research').length > 0 && (
              <div>
                <div className="px-3 py-1.5 text-[10px] font-semibold text-gray-500 uppercase tracking-wider bg-gray-800/30">
                  Research
                </div>
                {generatedFiles.filter(f => f.source === 'research').map((file) => {
                  const typeBadge: Record<string, { label: string; color: string }> = {
                    diagram: { label: 'Diagram', color: 'bg-blue-500/20 text-blue-400' },
                    notes: { label: 'Notes', color: 'bg-emerald-500/20 text-emerald-400' },
                    image: { label: 'Image', color: 'bg-amber-500/20 text-amber-400' },
                    summary: { label: 'Summary', color: 'bg-cyan-500/20 text-cyan-400' },
                    plan: { label: 'Plan', color: 'bg-amber-500/20 text-amber-400' },
                    other: { label: 'File', color: 'bg-gray-500/20 text-gray-400' },
                  }
                  const badge = typeBadge[file.type] || typeBadge.other
                  return (
                    <button
                      key={file.filePath}
                      onClick={() => setSelectedFilePath(file.filePath)}
                      className={`w-full text-left px-3 py-2 flex items-center gap-2 transition-colors ${
                        selectedFile?.filePath === file.filePath
                          ? 'bg-amber-500/15 border-l-2 border-amber-400'
                          : 'hover:bg-gray-800/50 border-l-2 border-transparent'
                      }`}
                    >
                      <span className={`px-1.5 py-0.5 text-[9px] font-bold rounded ${badge.color}`}>{badge.label}</span>
                      <span className="text-xs font-mono text-gray-300 truncate flex-1">{file.fileName}</span>
                      {!file.content && (
                        <svg className="w-3 h-3 animate-spin text-gray-500 shrink-0" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {/* Preview area */}
          <div className="flex-1 overflow-y-auto">
            {generatedFiles.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-gray-500 gap-3 p-6">
                <svg className="w-10 h-10 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                </svg>
                <span className="text-sm">No files yet</span>
                <span className="text-xs text-gray-600 text-center">Research artifacts and plans will appear here as the agent works</span>
              </div>
            ) : selectedFile ? (
              <div>
                <div className="sticky top-0 flex items-center justify-between px-4 py-2 bg-gray-800/80 backdrop-blur-sm border-b border-gray-700/30 z-10">
                  <span className="text-xs font-mono text-amber-300 truncate">{selectedFile.fileName}</span>
                  {!selectedFile.isImage && (
                    <button
                      onClick={() => handleCopyFile(selectedFile.filePath)}
                      className={`px-2 py-1 text-xs rounded transition-colors shrink-0 ml-2 ${
                        fileCopyFeedback === selectedFile.filePath
                          ? 'bg-green-500/20 text-green-400'
                          : 'bg-gray-700 text-gray-400 hover:text-gray-200'
                      }`}
                    >
                      {fileCopyFeedback === selectedFile.filePath ? 'Copied!' : 'Copy'}
                    </button>
                  )}
                </div>
                <div className="p-4">
                  {selectedFile.content ? (
                    selectedFile.isImage ? (
                      <img
                        src={`data:${selectedFile.mimeType || 'image/png'};base64,${selectedFile.content}`}
                        alt={selectedFile.fileName}
                        className="max-w-full rounded-lg border border-gray-700"
                      />
                    ) : selectedFile.type === 'html' || selectedFile.fileName?.endsWith('.svg') ? (
                      <iframe
                        srcDoc={selectedFile.fileName?.endsWith('.svg')
                          ? `<!DOCTYPE html><html><head><style>html,body{margin:0;height:100%;display:flex;align-items:center;justify-content:center;background:#1a1a2e;overflow:hidden}svg{width:100%;height:100%;max-width:100vw;max-height:100vh}</style></head><body>${selectedFile.content}</body></html>`
                          : `<!DOCTYPE html><html><head><style>html{font-size:16px}body{margin:16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.6;color:#e2e8f0;background:#1a1a2e}table{border-collapse:collapse;width:100%}th,td{border:1px solid #475569;padding:8px 12px;text-align:left}th{background:#334155}h1,h2,h3{color:#f1f5f9}a{color:#60a5fa}code{background:#334155;padding:2px 6px;border-radius:4px;font-size:14px}pre{background:#0f172a;padding:16px;border-radius:8px;overflow-x:auto}</style></head><body>${selectedFile.content}</body></html>`}
                        className="w-full h-full min-h-[400px] rounded-lg border border-gray-700"
                        sandbox="allow-scripts"
                        title={selectedFile.fileName}
                      />
                    ) : (
                      <div className="text-sm">
                        <MarkdownMessage content={selectedFile.content} />
                      </div>
                    )
                  ) : (
                    <div className="flex items-center justify-center py-8 text-gray-500 text-xs">
                      <svg className="w-5 h-5 animate-spin mr-2" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      Loading content...
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center h-full text-gray-500 text-sm">
                Select a file to preview
              </div>
            )}
          </div>
        </div>
      )}
      </div>

      {/* Mobile Menu Drawer */}
      {showMobileMenu && (
        <div className="fixed inset-0 z-50 sm:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowMobileMenu(false)} />
          <div className="absolute bottom-0 left-0 right-0 bg-gray-900 border-t border-gray-700 rounded-t-2xl max-h-[70vh] overflow-y-auto animate-in slide-in-from-bottom">
            <div className="p-4 space-y-1">
              {/* Handle bar */}
              <div className="w-10 h-1 bg-gray-700 rounded-full mx-auto mb-4" />

              {/* Files */}
              <button onClick={() => { setIsFilesModalOpen(true); setShowMobileMenu(false) }}
                className="w-full flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-gray-800 transition-colors text-left">
                <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                </svg>
                <span className="text-sm text-gray-200">Files Explorer</span>
                {generatedFiles.length > 0 && (
                  <span className="ml-auto text-xs bg-amber-500/30 text-amber-300 px-2 py-0.5 rounded-full">{generatedFiles.length}</span>
                )}
              </button>

              {/* Copy messages */}
              <button onClick={() => { handleCopyAllMessages(); setShowMobileMenu(false) }}
                disabled={messages.length === 0}
                className="w-full flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-gray-800 transition-colors text-left disabled:opacity-40">
                <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
                <span className="text-sm text-gray-200">Copy All Messages</span>
              </button>

              {/* Meeting */}
              <button onClick={() => {
                const url = prompt('Paste your Zoom or Google Meet URL:')
                if (url?.trim()) { handleJoinMeeting(url.trim()); setShowMobileMenu(false) }
              }}
                className="w-full flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-gray-800 transition-colors text-left">
                <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
                <span className="text-sm text-gray-200">Join Meeting</span>
              </button>

              {/* Sessions */}
              <button onClick={() => { handleLoadSessions(); setShowMobileMenu(false) }}
                className="w-full flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-gray-800 transition-colors text-left">
                <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="text-sm text-gray-200">Session History</span>
              </button>

              {/* Divider */}
              <div className="h-px bg-gray-800 my-2" />

              {/* Disconnect */}
              {onDisconnect && (
                <button onClick={() => { onDisconnect(); setShowMobileMenu(false) }}
                  className="w-full flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-red-500/10 transition-colors text-left">
                  <svg className="w-5 h-5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16 8l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2M5 3a2 2 0 00-2 2v1c0 8.284 6.716 15 15 15h1a2 2 0 002-2v-3.28a1 1 0 00-.684-.948l-4.493-1.498a1 1 0 00-1.21.502l-1.13 2.257a11.042 11.042 0 01-5.516-5.517l2.257-1.128a1 1 0 00.502-1.21L9.228 3.683A1 1 0 008.279 3H5z" />
                  </svg>
                  <span className="text-sm text-red-400">Disconnect</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Files Explorer Modal */}
      <FilesExplorerModal
        isOpen={isFilesModalOpen}
        onClose={() => setIsFilesModalOpen(false)}
        files={generatedFiles}
        selectedFilePath={selectedFilePath}
        onSelectFile={setSelectedFilePath}
        onCopyFile={handleCopyFile}
        onCopyAll={handleCopyAllFiles}
        fileCopyFeedback={fileCopyFeedback}
      />
    </>
  )
}

/**
 * Default export. VoiceRoom is now a thin adapter — the LiveKitRoom
 * wrapper and all session callbacks live in ChatSessionProvider
 * (see app/chat/layout.tsx). This component is rendered INSIDE the
 * provider's <LiveKitRoom>, so VoiceRoomInner's useRoomContext /
 * useLocalParticipant / useDataChannel hooks work without any
 * prop-drilled connection info.
 */
export default function VoiceRoom({ waitingMode }: VoiceRoomProps) {
  const { disconnect, markAgentReady, markAuthRequired, markVoiceActivity, idleStopped, preSelectedSessionId, agentUrl } =
    useChatSession()

  if (idleStopped) {
    return (
      <div className="min-h-screen bg-[var(--background)] flex flex-col items-center justify-center gap-6 p-8">
        <div className="text-4xl">😴</div>
        <div className="text-center">
          <p className="text-lg font-medium text-[var(--text)]">Session paused</p>
          <p className="text-sm text-[var(--muted)] mt-1">No activity for 15 min — machine stopped to save credits</p>
        </div>
        <button
          onClick={() => window.location.reload()}
          className="px-6 py-3 bg-[var(--accent)] text-black font-semibold rounded-xl hover:opacity-90 transition-opacity"
        >
          Resume
        </button>
        <button
          onClick={disconnect}
          className="text-sm text-[var(--muted)] hover:text-[var(--text)] transition-colors"
        >
          Back to dashboard
        </button>
      </div>
    )
  }

  return (
    <VoiceRoomInner
      onDisconnect={disconnect}
      onAgentReady={markAgentReady}
      onAuthRequired={markAuthRequired}
      onVoiceActivity={markVoiceActivity}
      waitingMode={waitingMode}
      preSelectedSessionId={preSelectedSessionId}
      agentUrl={agentUrl}
    />
  )
}
