/**
 * Claude LLM Wrapper for LiveKit Agents
 *
 * Wraps the Claude Agent SDK (@anthropic-ai/claude-agent-sdk) to work
 * with LiveKit's AgentSession as an LLM provider.
 *
 * Flow: User speaks → STT → ClaudeLLM (Agent SDK) → TTS → User hears
 */

import { llm, shortuuid, DEFAULT_API_CONNECT_OPTIONS, type APIConnectOptions } from '@livekit/agents'
import { query, type Options } from '@anthropic-ai/claude-agent-sdk'
import { EventEmitter } from 'events'

export interface ClaudeLLMOptions {
  workingDirectory?: string
  /**
   * Permission mode for tool usage:
   * - 'default': Prompts for dangerous tools, uses canUseTool callback
   * - 'acceptEdits': Auto-accepts file edits only
   * - 'bypassPermissions': Auto-accepts ALL tools (no prompts)
   * - 'plan': Read-only mode for research
   */
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
  /** Tools that Claude can use */
  allowedTools?: string[]
  /** Event emitter for tool_use, permission_request, progress updates */
  eventEmitter?: EventEmitter
}

/**
 * Strip markdown formatting for TTS (text-to-speech)
 * Removes **bold**, ##headers, ```code```, etc. so TTS doesn't read them literally
 */
function stripMarkdownForTTS(text: string): string {
  return text
    // Remove code blocks (``` ... ```)
    .replace(/```[\s\S]*?```/g, ' [code block] ')
    // Remove inline code (` ... `)
    .replace(/`([^`]+)`/g, '$1')
    // Remove bold (**text** or __text__)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    // Remove italic (*text* or _text_) - be careful not to match bullet points
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1')
    .replace(/(?<!_)_([^_]+)_(?!_)/g, '$1')
    // Remove headers (# ## ### etc)
    .replace(/^#{1,6}\s+/gm, '')
    // Remove bullet points but keep content
    .replace(/^[\s]*[-*+]\s+/gm, '')
    // Remove numbered lists but keep content
    .replace(/^[\s]*\d+\.\s+/gm, '')
    // Remove horizontal rules
    .replace(/^[-*_]{3,}$/gm, '')
    // Remove links [text](url) -> text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Remove images ![alt](url)
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    // Remove blockquotes
    .replace(/^>\s+/gm, '')
    // Clean up multiple spaces/newlines
    .replace(/\n{3,}/g, '\n\n')
    .replace(/  +/g, ' ')
    .trim()
}

// Default tools for voice agent - includes all common tools
const DEFAULT_ALLOWED_TOOLS = [
  // File operations
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  // Shell
  'Bash',
  // Web access
  'WebSearch', 'WebFetch',
  // Code intelligence
  'LSP',
  // Multi-step tasks
  'Task', 'TodoWrite',
]

/**
 * Claude LLM - Wraps Claude Agent SDK for LiveKit
 */
export class ClaudeLLM extends llm.LLM {
  #opts: ClaudeLLMOptions
  #sessionId: string | null = null
  #eventEmitter: EventEmitter

  // Pending permission request (for voice approval flow)
  #pendingPermission: {
    toolName: string
    input: any
    resolve: (decision: { behavior: 'allow' | 'deny', message?: string }) => void
  } | null = null

  constructor(opts: ClaudeLLMOptions = {}) {
    super()
    this.#opts = {
      workingDirectory: opts.workingDirectory || process.cwd(),
      // Use 'default' for permission prompts, voice agent will handle approval
      permissionMode: opts.permissionMode || 'default',
      allowedTools: opts.allowedTools || DEFAULT_ALLOWED_TOOLS,
    }
    this.#eventEmitter = opts.eventEmitter || new EventEmitter()
    console.log('🟠 ClaudeLLM initialized (Claude Agent SDK)')
    console.log(`   📁 Working dir: ${this.#opts.workingDirectory}`)
    console.log(`   🔑 Permission mode: ${this.#opts.permissionMode}`)
    console.log(`   🔧 Allowed tools: ${this.#opts.allowedTools?.join(', ')}`)
  }

  /**
   * Respond to a pending permission request
   * Call this after receiving 'permission_request' event
   */
  respondToPermission(allow: boolean, message?: string) {
    if (this.#pendingPermission) {
      this.#pendingPermission.resolve({
        behavior: allow ? 'allow' : 'deny',
        message: message || (allow ? undefined : 'User denied permission'),
      })
      this.#pendingPermission = null
    }
  }

  /**
   * Check if there's a pending permission request
   */
  hasPendingPermission(): boolean {
    return this.#pendingPermission !== null
  }

  /**
   * Get pending permission details
   */
  getPendingPermission(): { toolName: string; input: any } | null {
    if (this.#pendingPermission) {
      return { toolName: this.#pendingPermission.toolName, input: this.#pendingPermission.input }
    }
    return null
  }

  label(): string {
    return 'claude.agent-sdk'
  }

  get model(): string {
    return 'claude-sonnet-4-20250514'
  }

  get sessionId(): string | null {
    return this.#sessionId
  }

  get events(): EventEmitter {
    return this.#eventEmitter
  }

  chat({
    chatCtx,
    toolCtx,
    connOptions = DEFAULT_API_CONNECT_OPTIONS,
  }: {
    chatCtx: llm.ChatContext
    toolCtx?: llm.ToolContext
    connOptions?: APIConnectOptions
    parallelToolCalls?: boolean
    toolChoice?: llm.ToolChoice
    extraKwargs?: Record<string, unknown>
  }): llm.LLMStream {
    return new ClaudeLLMStream(this, {
      chatCtx,
      toolCtx,
      connOptions,
      opts: this.#opts,
      sessionId: this.#sessionId,
      onSessionId: (id) => { this.#sessionId = id },
      eventEmitter: this.#eventEmitter,
      // Pass permission handler for canUseTool callback
      onPermissionRequest: (toolName: string, input: any) => {
        return new Promise<{ behavior: 'allow' | 'deny', message?: string }>((resolve) => {
          this.#pendingPermission = { toolName, input, resolve }
          console.log(`⚠️ Permission request: ${toolName}`)
          this.#eventEmitter.emit('permission_request', { toolName, input })
        })
      },
    })
  }
}

/**
 * Claude LLM Stream - Runs Claude Agent SDK query() and streams results
 */
class ClaudeLLMStream extends llm.LLMStream {
  #opts: ClaudeLLMOptions
  #sessionId: string | null
  #onSessionId: (id: string) => void
  #eventEmitter: EventEmitter
  #onPermissionRequest: (toolName: string, input: any) => Promise<{ behavior: 'allow' | 'deny', message?: string }>

  constructor(
    llmInstance: ClaudeLLM,
    {
      chatCtx,
      toolCtx,
      connOptions,
      opts,
      sessionId,
      onSessionId,
      eventEmitter,
      onPermissionRequest,
    }: {
      chatCtx: llm.ChatContext
      toolCtx?: llm.ToolContext
      connOptions: APIConnectOptions
      opts: ClaudeLLMOptions
      sessionId: string | null
      onSessionId: (id: string) => void
      eventEmitter: EventEmitter
      onPermissionRequest: (toolName: string, input: any) => Promise<{ behavior: 'allow' | 'deny', message?: string }>
    },
  ) {
    super(llmInstance, { chatCtx, toolCtx, connOptions })
    this.#opts = opts
    this.#sessionId = sessionId
    this.#onSessionId = onSessionId
    this.#eventEmitter = eventEmitter
    this.#onPermissionRequest = onPermissionRequest
  }

  protected async run(): Promise<void> {
    const requestId = `claude_${shortuuid()}`

    try {
      // Extract user's message from chat context
      // ChatContext has .items which are ChatItem[] (ChatMessage | FunctionCall | FunctionCallOutput)
      const items = this.chatCtx.items

      // Find the last user message
      let userText = ''
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i] as any
        if (item.type === 'message' && item.role === 'user') {
          // Content is ChatContent[] = (ImageContent | AudioContent | string)[]
          if (Array.isArray(item.content)) {
            userText = item.content
              .filter((c: any) => typeof c === 'string')
              .join('\n')
          }
          break
        }
      }

      if (!userText.trim()) {
        this.queue.put({
          id: requestId,
          delta: { role: 'assistant', content: "I didn't catch that. Could you repeat?" },
        })
        return
      }

      console.log(`🎤 User: "${userText.substring(0, 100)}${userText.length > 100 ? '...' : ''}"`)

      // Build Claude Agent SDK options
      const sdkOptions: Options = {
        cwd: this.#opts.workingDirectory,
        permissionMode: this.#opts.permissionMode,
        allowedTools: this.#opts.allowedTools,
        ...(this.#sessionId && { resume: this.#sessionId }),
        // Permission callback - fires when a tool needs user approval
        // (only in 'default' mode, not in 'bypassPermissions' or 'acceptEdits')
        canUseTool: async (toolName: string, input: any) => {
          console.log(`⚠️ Permission needed: ${toolName}`)
          return this.#onPermissionRequest(toolName, input)
        },
        hooks: {
          PreToolUse: [{
            matcher: '.*',
            hooks: [async (input: any) => {
              const toolName = input?.tool_name || 'unknown'
              const toolInput = input?.tool_input || {}
              console.log(`🔧 Claude: ${toolName}`)
              this.#eventEmitter.emit('tool_use', { name: toolName, input: toolInput })
              return {} // Allow tool (permission already handled by canUseTool)
            }]
          }],
          PostToolUse: [{
            matcher: '.*',
            hooks: [async (input: any) => {
              const toolName = input?.tool_name || 'unknown'
              console.log(`✅ Done: ${toolName}`)
              this.#eventEmitter.emit('tool_result', { name: toolName })
              return {}
            }]
          }]
        }
      }

      // Run Claude Agent SDK query() and stream results
      let hasOutput = false

      for await (const message of query({ prompt: userText, options: sdkOptions })) {
        // Capture session ID for context continuity
        if ((message as any).type === 'system' && (message as any).subtype === 'init') {
          const newSessionId = (message as any).session_id
          if (newSessionId) {
            this.#onSessionId(newSessionId)
            if (!this.#sessionId) {
              console.log(`📋 New session: ${newSessionId}`)
            }
            this.#sessionId = newSessionId
          }
        }

        // Stream text chunks → TTS (strip markdown for speech)
        if ((message as any).type === 'assistant' && (message as any).message?.content) {
          for (const block of (message as any).message.content) {
            if (block.type === 'text' && block.text) {
              hasOutput = true
              // Strip markdown so TTS doesn't read "star star" or "pound pound"
              const ttsText = stripMarkdownForTTS(block.text)
              this.queue.put({
                id: requestId,
                delta: { role: 'assistant', content: ttsText },
              })
            }
          }
        }

        // Final result (also strip markdown)
        if ((message as any).type === 'result' && (message as any).result) {
          if (!hasOutput) {
            const ttsText = stripMarkdownForTTS((message as any).result)
            this.queue.put({
              id: requestId,
              delta: { role: 'assistant', content: ttsText },
            })
            hasOutput = true
          }
        }
      }

      if (!hasOutput) {
        this.queue.put({
          id: requestId,
          delta: { role: 'assistant', content: 'Done.' },
        })
      }

      console.log('✅ Claude response complete')

    } catch (error) {
      console.error('❌ Claude Agent SDK error:', error)
      this.queue.put({
        id: requestId,
        delta: { role: 'assistant', content: 'Sorry, I encountered an error.' },
      })
    }
  }
}

/**
 * Create a ClaudeLLM instance
 */
export function createClaudeLLM(opts?: ClaudeLLMOptions): ClaudeLLM {
  return new ClaudeLLM(opts)
}
