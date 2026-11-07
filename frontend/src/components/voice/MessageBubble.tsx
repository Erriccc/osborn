'use client'

import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { MarkdownMessage } from '../MarkdownMessage'
import { FileCard } from '../chat/FileCard'
import { userBubbleText } from '@/lib/chat-echo'
import { stripProvenance, type ChatMessage, type MessagePart, type SpeakingChunk } from './shared'

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
export const MessageBubble = React.memo(function MessageBubble({
  message,
  grouped,
  speakingChunk,
  onCopy,
  onLike,
  onIgnore,
  onReplay,
  isLiked,
}: {
  message: ChatMessage
  grouped?: boolean
  speakingChunk?: SpeakingChunk | null
  onCopy?: () => void
  onLike?: () => void
  onIgnore?: () => void
  onReplay?: () => void
  isLiked?: boolean
}) {
  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'
  // Display text: user turns go through the shared transcript cleaner
  // (lib/transcript-clean via userBubbleText; null = nothing the user said, so
  // the bubble is hidden); agent/system text gets provenance stripped so echoed
  // recall citations never clutter the UI.
  const userText = isUser ? userBubbleText(message.content) : null
  const displayContent = isUser ? (userText ?? '') : stripProvenance(message.content)

  const [copyDone, setCopyDone] = useState(false)

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(displayContent).catch(() => {})
    setCopyDone(true)
    setTimeout(() => setCopyDone(false), 1500)
    onCopy?.()
  }, [displayContent, onCopy])

  // Parse content into parts for assistant messages
  const parts = useMemo(() => {
    const raw = message.role === 'user' ? message.content : stripProvenance(message.content)
    if (message.role === 'assistant' && !message.parts) {
      return parseMessageParts(raw)
    }
    return message.parts || [{ type: 'text' as const, content: raw }]
  }, [message])

  // Nothing the user actually said (notice / wrapper only): no "You" bubble.
  // Returned after the hooks so hook order never depends on the content.
  if (isUser && userText === null) return null

  // In-chat file card (L4): the agent wrote a file; show it where the work happened.
  if (message.fileRef) {
    return <FileCard filePath={message.fileRef.filePath} fileName={message.fileRef.fileName} />
  }

  // Date / prior-conversation dividers — centered hairline label (Slack-style),
  // not a notice box. Emitted by buildPriorItems as system rows starting with ──.
  if (isSystem && /^──/.test(message.content)) {
    const label = message.content.replace(/─/g, '').trim()
    return (
      <div className="flex items-center gap-3 w-full py-1.5 select-none">
        <div className="flex-1 h-px bg-gray-800/70" />
        <span className="text-[11px] text-gray-500 font-medium">{label}</span>
        <div className="flex-1 h-px bg-gray-800/70" />
      </div>
    )
  }

  return (
    <div className="flex min-w-0 w-full justify-start group rounded-md px-2 py-1 -mx-2 hover:bg-white/[0.02] transition-colors" data-message-id={message.messageId ?? undefined}>{/* Slack model: every message is a left-aligned row; sender identity comes from the avatar + name line, not bubble position */}
      {/* Avatar — flat rounded square, only on the FIRST message of a run; a
          spacer keeps grouped rows aligned. Hidden on mobile to save space. */}
      {!isSystem && message.toolName !== 'fast-brain' && (
        grouped ? (
          <div className="hidden sm:block w-7 mr-2.5 shrink-0" aria-hidden="true" />
        ) : (
          <div className={`hidden sm:flex w-7 h-7 rounded-md items-center justify-center mr-2.5 mt-0.5 shrink-0 ${isUser ? 'bg-gray-700' : 'bg-amber-600'}`}>
            {isUser ? (
              <svg className="w-4 h-4 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
            ) : (
              <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            )}
          </div>
        )
      )}

      <div
        className={`min-w-0 max-w-[92%] sm:max-w-[85%] transition-all ${
          isSystem
            ? 'bg-amber-500/10 text-amber-200/90 border border-amber-500/20 rounded-lg px-3 py-1.5'
            : message.toolName === 'fast-brain'
            ? 'border-l-2 border-amber-500/30 pl-3 pr-1 py-0.5 opacity-70 [&_p]:!my-0.5 [&_p]:!text-xs [&_p]:!leading-snug [&_p]:!text-gray-400 [&_p]:!font-mono'
            : 'text-gray-100 px-0.5 py-0.5'
        } ${message.isStreaming ? 'opacity-95' : ''}`}
      >
        {/* Sender line — only on the first message of a run (Slack grouping) */}
        {!isSystem && message.toolName !== 'fast-brain' && !grouped && (
          <div className="flex items-baseline gap-2">
            <span className={`text-[13px] font-bold ${isUser ? 'text-sky-300' : 'text-amber-300'}`}>{isUser ? 'You' : 'Osborn'}</span>
            {message.timestamp.getTime() > 0 && (
              <span className="text-[10px] text-gray-500 opacity-0 group-hover:opacity-100 transition-opacity select-none">
                {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </div>
        )}

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
                  // [Image: name](url) / [File: name](url) from the agent get the
                  // same inline media rendering as user uploads (send-media skill)
                  if (/\[(?:Image|File):\s*[^\]]+\]\(https?:\/\/[^\s)]+\)/.test(part.content)) {
                    return <MessageContent key={idx} content={part.content} />
                  }
                  // Check if content has markdown formatting (including tables with |)
                  const hasMarkdown = /[*#`\[\]|]/.test(part.content) || /^-{3,}$/m.test(part.content)
                  if (hasMarkdown) {
                    return <MarkdownMessage key={idx} content={part.content} />
                  }
                  // Simple text - render directly without Markdown processing
                  // Each bubble is exactly one TTS chunk; highlight the whole bubble
                  // when its stored chunkIndex matches the currently-speaking chunk.
                  const isHighlighted =
                    message.messageId != null &&
                    message.chunkIndex != null &&
                    speakingChunk != null &&
                    speakingChunk.messageId === message.messageId &&
                    message.chunkIndex === speakingChunk.chunkIndex
                  return (
                    <p key={idx} className="text-sm leading-relaxed whitespace-pre-wrap text-gray-100">
                      <span
                        className={isHighlighted ? 'bg-amber-500/20 rounded transition-colors' : undefined}
                      >
                        {part.content}
                      </span>
                    </p>
                  )
                }
                return null
              })
            ) : (
              // Fallback: render raw content if parts parsing failed
              <p className="text-sm leading-relaxed whitespace-pre-wrap">{displayContent}</p>
            )}
            {/* Extra fallback: if all parts were empty, show raw content */}
            {parts.length > 0 && parts.every(p => !p.content?.trim()) && displayContent?.trim() && (
              <p className="text-sm leading-relaxed whitespace-pre-wrap">{displayContent}</p>
            )}
            {message.isStreaming && <StreamingDots />}
          </div>
        ) : (
          <MessageContent content={isUser ? (userText as string) : message.content} />
        )}

        {/* Time moved into the sender line (Slack model); keep only the live streaming badge */}
        {message.isStreaming && (
          <span className="text-[10px] text-amber-400">streaming</span>
        )}

        {/* Action buttons — hover-reveal on pointer devices; always visible on
            touch (no hover): max-sm:opacity-100 (P1.10 — actions were
            unreachable on phones). Targets padded to 44pt-equivalent spacing. */}
        {!isSystem && !message.isStreaming && (
          <div className={`flex items-center gap-1 mt-1 opacity-0 group-hover:opacity-100 max-sm:opacity-100 transition-opacity ${isUser ? 'justify-end' : 'justify-start'}`}>
            <button
              onClick={handleCopy}
              className="p-1.5 -m-1 rounded text-gray-500 hover:text-gray-200 transition-colors active:scale-95"
              title="Copy"
            >
              {copyDone ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                </svg>
              )}
            </button>
            {!isUser && (
              <button
                onClick={onLike}
                className={`p-1.5 -m-1 rounded transition-colors active:scale-95 ${isLiked ? 'text-amber-400 hover:text-amber-300' : 'text-gray-500 hover:text-gray-200'}`}
                title="Like"
              >
                {isLiked ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M14 9V5a3 3 0 00-3-3l-4 9v11h11.28a2 2 0 002-1.7l1.38-9a2 2 0 00-2-2.3H14z" />
                    <path d="M7 22H4a2 2 0 01-2-2v-7a2 2 0 012-2h3" />
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 9V5a3 3 0 00-3-3l-4 9v11h11.28a2 2 0 002-1.7l1.38-9a2 2 0 00-2-2.3H14z" />
                    <path d="M7 22H4a2 2 0 01-2-2v-7a2 2 0 012-2h3" />
                  </svg>
                )}
              </button>
            )}
            {!isUser && (
              <button
                onClick={onReplay}
                className="p-1.5 -m-1 rounded text-gray-500 hover:text-gray-200 transition-colors active:scale-95"
                title="Replay"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="1 4 1 10 7 10" />
                  <path d="M3.51 15a9 9 0 102.13-9.36L1 10" />
                </svg>
              </button>
            )}
            {isUser && (
              <button
                onClick={onIgnore}
                className="p-1.5 -m-1 rounded text-gray-500 hover:text-gray-200 transition-colors active:scale-95"
                title="Ignore"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
                </svg>
              </button>
            )}
          </div>
        )}
      </div>

    </div>
  )
})
