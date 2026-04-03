/**
 * Claude LLM Wrapper for LiveKit Agents
 *
 * Wraps the Claude Agent SDK (@anthropic-ai/claude-agent-sdk) to work
 * with LiveKit's AgentSession as an LLM provider.
 *
 * Flow: User speaks → STT → ClaudeLLM (Agent SDK) → TTS → User hears
 */

import { llm, shortuuid, DEFAULT_API_CONNECT_OPTIONS, type APIConnectOptions } from '@livekit/agents'
import { query, unstable_v2_createSession, unstable_v2_resumeSession, type Options, type McpServerConfig, type SDKSession, type SDKSessionOptions, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { EventEmitter } from 'events'
import { saveSessionMetadata } from './config.js'
import { getResearchSystemPrompt, getDirectModeResearchPrompt } from './prompts.js'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ClaudeLLMOptions {
  workingDirectory?: string      // cwd for Claude Code (where it reads/writes/runs commands)
  sessionBaseDir?: string        // where .osborn/sessions/ lives (defaults to workingDirectory)
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions'
  allowedTools?: string[]
  eventEmitter?: EventEmitter
  resumeSessionId?: string
  continueSession?: boolean
  mcpServers?: Record<string, McpServerConfig>
  model?: string  // Claude model ID (default: claude-sonnet-4-6)
  voiceMode?: 'direct' | 'realtime'  // Which voice pipeline — controls system prompt selection
  skipTTSQueue?: boolean  // When true, emit 'tts_say' events instead of queue.put() — for session.say() bypass
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


/**
 * Load skill files from agent/.claude/skills/{name}/SKILL.md
 * Injects into system prompt so Claude sees them as available capabilities.
 * Skills execute via Bash — no SDK settingSources needed.
 */
function loadSkillsFromDir(agentDir: string): string {
  const skillsDir = join(agentDir, '.claude', 'skills')
  if (!existsSync(skillsDir)) return ''

  const skills: string[] = []
  try {
    for (const skillName of readdirSync(skillsDir)) {
      const skillFile = join(skillsDir, skillName, 'SKILL.md')
      if (existsSync(skillFile)) {
        skills.push(readFileSync(skillFile, 'utf-8').trim())
      }
    }
  } catch (err) {
    console.warn('⚠️ Failed to load skills:', err)
  }

  if (skills.length === 0) return ''
  console.log(`📚 Loaded ${skills.length} skill(s) from ${skillsDir}`)
  return `<available-skills>\n${skills.join('\n\n---\n\n')}\n</available-skills>`
}

// Research mode tools — full research capabilities
const RESEARCH_TOOLS = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'Bash', 'WebSearch', 'WebFetch',
  'LSP', 'Task', 'TodoWrite',
]

/**
 * Claude LLM - Wraps Claude Agent SDK for LiveKit
 * Research mode: reads anything, writes only to session workspace
 */
export class ClaudeLLM extends llm.LLM {
  #opts: ClaudeLLMOptions
  #sessionId: string | null = null
  #eventEmitter: EventEmitter
  #resumeSessionId: string | null = null
  #continueSession: boolean = false
  #mcpServers: Record<string, McpServerConfig> = {}

  // File checkpointing - stores checkpoint UUIDs for rewinding file changes
  #checkpoints: string[] = []
  #latestCheckpoint: string | null = null

  // Pending permission request (for voice approval flow)
  #pendingPermission: {
    toolName: string
    input: Record<string, unknown>
    resolve: (decision: { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }) => void
  } | null = null

  // V2 Persistent Session — single subprocess, no JSONL replay after first init.
  // On first chat(), creates/resumes a session. Subsequent chat() calls use send().
  #v2Session: SDKSession | null = null
  #v2StreamLoop: AsyncGenerator<SDKMessage, void> | null = null
  #v2Initialized = false

  // Active queries — multiple can be running (SDK queues them internally).
  // We keep ALL references so interrupt() can stop whatever is currently executing.
  #activeQueries: Set<any> = new Set()

  constructor(opts: ClaudeLLMOptions = {}) {
    super()

    // Session resume/continue options
    this.#resumeSessionId = opts.resumeSessionId || null
    this.#continueSession = opts.continueSession || false

    // MCP servers
    this.#mcpServers = opts.mcpServers || {}

    this.#opts = {
      workingDirectory: opts.workingDirectory || process.cwd(),
      sessionBaseDir: opts.sessionBaseDir || opts.workingDirectory || process.cwd(),
      permissionMode: opts.permissionMode || 'default',
      allowedTools: opts.allowedTools || RESEARCH_TOOLS,
      resumeSessionId: this.#resumeSessionId || undefined,
      continueSession: this.#continueSession,
      mcpServers: this.#mcpServers,
      voiceMode: opts.voiceMode || 'realtime',
      skipTTSQueue: opts.skipTTSQueue || false,
    }
    this.#eventEmitter = opts.eventEmitter || new EventEmitter()

    console.log('🟠 ClaudeLLM initialized (Research Mode)')
    console.log(`   📁 Working dir (cwd): ${this.#opts.workingDirectory}`)
    if (this.#opts.sessionBaseDir !== this.#opts.workingDirectory) {
      console.log(`   📁 Session base dir: ${this.#opts.sessionBaseDir}`)
    }
    console.log(`   🔧 Allowed tools: ${this.#opts.allowedTools?.join(', ')}`)
    const mcpCount = Object.keys(this.#mcpServers).length
    if (mcpCount > 0) {
      console.log(`   🔌 MCP servers: ${Object.keys(this.#mcpServers).join(', ')}`)
    }
    if (this.#resumeSessionId) {
      console.log(`   🔄 Resuming session: ${this.#resumeSessionId}`)
    } else if (this.#continueSession) {
      console.log(`   🔄 Continuing most recent session`)
    }
  }

  /**
   * Respond to a pending permission request
   * Call this after receiving 'permission_request' event
   */
  respondToPermission(allow: boolean, message?: string) {
    if (this.#pendingPermission) {
      const input = this.#pendingPermission.input
      if (allow) {
        this.#pendingPermission.resolve({
          behavior: 'allow',
          updatedInput: input, // Pass through original input
        })
      } else {
        this.#pendingPermission.resolve({
          behavior: 'deny',
          message: message || 'User denied permission',
        })
      }
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

  // ============================================================
  // MCP SERVER MANAGEMENT - Runtime enable/disable MCP servers
  // ============================================================

  /**
   * Get all currently enabled MCP servers
   */
  getMcpServers(): Record<string, McpServerConfig> {
    return { ...this.#mcpServers }
  }

  /**
   * Get list of enabled MCP server keys
   */
  getEnabledMcpServerKeys(): string[] {
    return Object.keys(this.#mcpServers)
  }

  /**
   * Replace all MCP servers at once
   */
  setMcpServers(servers: Record<string, McpServerConfig>): void {
    this.#mcpServers = { ...servers }
    this.#opts.mcpServers = this.#mcpServers
    console.log(`🔌 MCP servers updated: ${Object.keys(servers).join(', ') || 'none'}`)
    this.#eventEmitter.emit('mcp_servers_changed', {
      enabledKeys: Object.keys(this.#mcpServers),
    })
  }

  /**
   * Enable a single MCP server
   */
  enableMcpServer(key: string, config: McpServerConfig): void {
    this.#mcpServers[key] = config
    this.#opts.mcpServers = this.#mcpServers
    console.log(`🔌 MCP server enabled: ${key}`)
    this.#eventEmitter.emit('mcp_servers_changed', {
      enabledKeys: Object.keys(this.#mcpServers),
    })
  }

  /**
   * Disable a single MCP server
   */
  disableMcpServer(key: string): void {
    delete this.#mcpServers[key]
    this.#opts.mcpServers = this.#mcpServers
    console.log(`🔌 MCP server disabled: ${key}`)
    this.#eventEmitter.emit('mcp_servers_changed', {
      enabledKeys: Object.keys(this.#mcpServers),
    })
  }

  label(): string {
    return 'claude.agent-sdk'
  }

  get model(): string {
    return this.#opts.model || 'claude-sonnet-4-6' // claude-sonnet-4-6 || claude-haiku-4-5-20251001
  }

  get sessionId(): string | null {
    return this.#sessionId
  }

  /**
   * Set session ID to resume a specific conversation
   * Call this before sending the first message to resume from a previous session
   */
  setResumeSessionId(sessionId: string | null): void {
    this.#resumeSessionId = sessionId
    // CRITICAL: Sync to opts so ClaudeLLMStream.run() picks up the resume ID
    this.#opts.resumeSessionId = sessionId || undefined

    if (sessionId) {
      console.log(`🔄 Will resume session: ${sessionId}`)
    }
  }

  /**
   * Reset state for mid-conversation session switch
   * Clears pending permissions and resets conversation tracking
   */
  resetForSessionSwitch(): void {
    // Clear any pending permission request from previous session
    if (this.#pendingPermission) {
      // Deny the pending permission to clean up
      this.#pendingPermission.resolve({
        behavior: 'deny',
        message: 'Session switched - permission request cancelled',
      })
      this.#pendingPermission = null
    }

    // Clear session resume state so new resume can take effect
    this.#resumeSessionId = null
    this.#continueSession = false
    this.#opts.resumeSessionId = undefined
    this.#opts.continueSession = false
    this.#sessionId = null

    // Clear checkpoints from previous session
    this.#checkpoints = []
    this.#latestCheckpoint = null

    // Emit event for listeners
    this.#eventEmitter.emit('session_reset')

    console.log('🔄 LLM state reset for session switch')
  }

  /**
   * Enable "continue" mode - resumes most recent session
   */
  setContinueSession(enabled: boolean): void {
    this.#continueSession = enabled
    this.#opts.continueSession = enabled
    if (enabled) {
      console.log(`🔄 Will continue most recent session`)
    }
  }

  /**
   * Check if this instance is configured to resume a session
   */
  get isResumingSession(): boolean {
    return !!(this.#resumeSessionId || this.#continueSession)
  }

  get events(): EventEmitter {
    return this.#eventEmitter
  }

  // ============================================================
  // FILE CHECKPOINTING - Track and rewind file changes
  // ============================================================

  /**
   * Capture a checkpoint UUID for potential file rewind
   * Called internally when receiving user message UUIDs from the SDK
   */
  captureCheckpoint(checkpointId: string): void {
    this.#checkpoints.push(checkpointId)
    this.#latestCheckpoint = checkpointId
    console.log(`📍 Checkpoint captured: ${checkpointId.substring(0, 8)}...`)
    this.#eventEmitter.emit('checkpoint_captured', { checkpointId })
  }

  /**
   * Get the most recent checkpoint UUID
   * Use this to rewind all file changes back to the beginning
   */
  getLatestCheckpoint(): string | null {
    return this.#latestCheckpoint
  }

  /**
   * Get the first checkpoint UUID (initial state)
   * Rewinding to this restores all files to their original state
   */
  getFirstCheckpoint(): string | null {
    return this.#checkpoints.length > 0 ? this.#checkpoints[0] : null
  }

  /**
   * Get all captured checkpoint UUIDs
   * Ordered from oldest to newest
   */
  getCheckpoints(): string[] {
    return [...this.#checkpoints]
  }

  /**
   * Clear all captured checkpoints
   * Call this when starting a new session
   */
  clearCheckpoints(): void {
    this.#checkpoints = []
    this.#latestCheckpoint = null
    console.log('🧹 Checkpoints cleared')
  }

  /**
   * Check if checkpoints are available
   */
  hasCheckpoints(): boolean {
    return this.#checkpoints.length > 0
  }

  // ============================================================
  // AGENT CONTROL — interrupt, abort, rewind (for fast brain)
  // ============================================================

  /**
   * Interrupt the current Claude query gracefully (like pressing Esc).
   * Stops current tool execution but keeps the process alive.
   * Returns true if interrupted, false if no active query.
   */
  async interruptQuery(): Promise<boolean> {
    if (this.#activeQueries.size === 0) return false
    // Snapshot current queries — new queries added during await must NOT be interrupted
    // (race: pipeline-direct-llm calls interruptQuery() then chat() without awaiting,
    //  so the new query can get added to #activeQueries before this loop finishes)
    const queriesToInterrupt = [...this.#activeQueries]
    let interrupted = false
    for (const q of queriesToInterrupt) {
      if (typeof q.interrupt === 'function') {
        try {
          await q.interrupt()
          interrupted = true
        } catch (err: any) {
          console.error('⚠️ Interrupt failed:', err?.message)
        }
      }
    }
    if (interrupted) {
      console.log(`🛑 Interrupted ${queriesToInterrupt.length} active query(s) (Esc equivalent)`)
    }
    return interrupted
  }

  /**
   * Hard abort all active queries (like Ctrl+C).
   * Kills subprocesses. Next message will spawn new processes.
   */
  abortQuery(): void {
    for (const q of this.#activeQueries) {
      try { q.return?.() } catch {}
    }
    this.#activeQueries.clear()
    console.log('🛑 All queries aborted (Ctrl+C equivalent)')
  }

  /**
   * Rewind file changes to a specific checkpoint.
   * Uses the most recently added query (most likely to have the rewind capability).
   */
  async rewindToCheckpoint(checkpointId?: string): Promise<boolean> {
    const id = checkpointId || this.#latestCheckpoint
    if (!id) {
      console.log('⚠️ No checkpoint available for rewind')
      return false
    }
    // Try rewind on the latest query
    const queries = [...this.#activeQueries]
    const latest = queries[queries.length - 1]
    if (latest && typeof latest.rewindFiles === 'function') {
      try {
        await latest.rewindFiles(id)
        console.log(`🔄 Files rewound to checkpoint: ${id.substring(0, 8)}...`)
        return true
      } catch (err: any) {
        console.error('⚠️ Rewind failed:', err?.message)
      }
    }
    return false
  }

  /**
   * Check if there are active queries that can be interrupted
   */
  hasActiveQuery(): boolean {
    return this.#activeQueries.size > 0
  }

  /** Add an active query (called from ClaudeLLMStream when query starts) */
  setActiveQuery(q: any): void {
    if (q) {
      this.#activeQueries.add(q)
    }
  }

  /** Remove an active query (called from ClaudeLLMStream when query completes) */
  removeActiveQuery(q: any): void {
    this.#activeQueries.delete(q)
  }

  // ============================================================
  // V2 PERSISTENT SESSION — single subprocess per voice session
  // ============================================================

  /**
   * Get or create a V2 persistent session.
   * First call: spawns subprocess, does JSONL replay (cold start).
   * Subsequent calls: returns the same session (no replay).
   */
  getOrCreateSession(): SDKSession {
    if (this.#v2Session) return this.#v2Session

    const sessionOpts: SDKSessionOptions = {
      model: this.#opts.model || 'claude-sonnet-4-6',
      allowedTools: this.#opts.allowedTools || RESEARCH_TOOLS,
      permissionMode: this.#opts.permissionMode as any || 'default',
      canUseTool: async (toolName, input, _options) => {
        // Auto-approve writes to session workspace (block spec.md/library — fast brain manages)
        if (toolName === 'Write' || toolName === 'Edit') {
          const filePath = String(input?.file_path || '')
          if (filePath.includes('.osborn/sessions/') || filePath.includes('.osborn/research/')) {
            const fileName = filePath.split('/').pop() || ''
            if (fileName === 'spec.md' || filePath.includes('/library/')) {
              console.log(`🚫 Blocked research agent write to managed file: ${filePath}`)
              return { behavior: 'deny' as const, message: 'spec.md and library/ are managed by the fast brain. Return findings in text.' }
            }
            console.log(`✅ Auto-approved ${toolName} to workspace: ${filePath}`)
            return { behavior: 'allow' as const, updatedInput: input }
          }
        }
        if (toolName === 'AskUserQuestion') {
          return { behavior: 'allow' as const, updatedInput: input }
        }
        if (toolName === 'EnterPlanMode' || toolName === 'ExitPlanMode') {
          return { behavior: 'deny' as const, message: 'Research mode does not use plan mode.' }
        }
        // Fall through to permission flow — emit event, wait for response
        console.log(`⚠️ Permission needed: ${toolName}`)
        return new Promise((resolve) => {
          this.#pendingPermission = { toolName, input, resolve: resolve as any }
          this.#eventEmitter.emit('permission_request', { toolName, input })
        })
      },
      hooks: {
        PreToolUse: [{
          matcher: '.*',
          hooks: [async (input: any) => {
            const toolName = input?.tool_name || 'unknown'
            const toolInput = input?.tool_input || {}
            if (toolName === 'Write' || toolName === 'Edit') {
              const filePath = String(toolInput.file_path || '')
              if (filePath && !filePath.includes('.osborn/sessions/') && !filePath.includes('.osborn/research/')) {
                console.log(`🚫 Research mode: blocked write to ${filePath}`)
                this.#eventEmitter.emit('tool_blocked', { name: toolName, reason: 'Research mode: writes restricted to session workspace' })
                return { decision: 'block', reason: 'Research mode: write to .osborn/sessions/ only.' }
              }
            }
            console.log(`🔧 Claude: ${toolName}`)
            this.#eventEmitter.emit('tool_use', { name: toolName, input: toolInput })
            return {}
          }]
        }],
        PostToolUse: [{
          matcher: '.*',
          hooks: [async (input: any) => {
            const toolName = input?.tool_name || 'unknown'
            const toolInput = input?.tool_input || {}
            const toolResponse = input?.tool_response
            console.log(`✅ Done: ${toolName}`)
            this.#eventEmitter.emit('tool_result', { name: toolName, input: toolInput, response: toolResponse })
            return {}
          }]
        }]
      },
    }

    const resumeId = this.#resumeSessionId || this.#sessionId
    if (resumeId) {
      console.log(`🔄 V2 persistent session: resuming ${resumeId.substring(0, 8)}...`)
      this.#v2Session = unstable_v2_resumeSession(resumeId, sessionOpts)
    } else if (this.#continueSession) {
      // TODO: V2 doesn't have a direct 'continue' equivalent yet
      // For now, create a new session — the next message will establish context
      console.log('🆕 V2 persistent session: creating new')
      this.#v2Session = unstable_v2_createSession(sessionOpts)
    } else {
      console.log('🆕 V2 persistent session: creating new')
      this.#v2Session = unstable_v2_createSession(sessionOpts)
    }

    return this.#v2Session
  }

  /**
   * Close the V2 session (kills subprocess).
   * Call on disconnect, session switch, or recovery.
   */
  closeSession(): void {
    if (this.#v2Session) {
      try { this.#v2Session.close() } catch {}
      console.log('🔒 V2 persistent session closed')
    }
    this.#v2Session = null
    this.#v2StreamLoop = null
    this.#v2Initialized = false
  }

  /** Check if a V2 persistent session is alive */
  hasSession(): boolean {
    return this.#v2Session !== null
  }

  chat({
    chatCtx,
    toolCtx,
    connOptions = DEFAULT_API_CONNECT_OPTIONS,
    abortController,
  }: {
    chatCtx: llm.ChatContext
    toolCtx?: llm.ToolContext
    connOptions?: APIConnectOptions
    parallelToolCalls?: boolean
    toolChoice?: llm.ToolChoice
    extraKwargs?: Record<string, unknown>
    abortController?: AbortController
  }): llm.LLMStream {
    return new ClaudeLLMStream(this, {
      chatCtx,
      toolCtx,
      connOptions,
      opts: this.#opts,
      sessionId: this.#sessionId,
      abortController,
      onSessionId: (id) => {
        const isFirst = !this.#sessionId
        this.#sessionId = id
        if (isFirst) {
          this.#eventEmitter.emit('session_id', { sessionId: id })
        }
      },
      eventEmitter: this.#eventEmitter,
      // Pass checkpoint capture handler
      onCheckpoint: (checkpointId: string) => {
        this.captureCheckpoint(checkpointId)
      },
      // Pass permission handler for canUseTool callback
      onPermissionRequest: (toolName: string, input: Record<string, unknown>) => {
        type PermResult = { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }
        return new Promise<PermResult>((resolve) => {
          this.#pendingPermission = { toolName, input, resolve }
          console.log(`⚠️ Permission request: ${toolName}`)
          this.#eventEmitter.emit('permission_request', { toolName, input })
        })
      },
    })
  }
}

// Permission result type matching Claude Agent SDK
type PermissionResult = { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }

/**
 * Claude LLM Stream - Runs Claude Agent SDK query() and streams results
 */
class ClaudeLLMStream extends llm.LLMStream {
  #opts: ClaudeLLMOptions
  #sessionId: string | null
  #onSessionId: (id: string) => void
  #eventEmitter: EventEmitter
  #onPermissionRequest: (toolName: string, input: Record<string, unknown>) => Promise<PermissionResult>
  #onCheckpoint: (checkpointId: string) => void
  #abortController?: AbortController
  #llmRef: ClaudeLLM

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
      onCheckpoint,
      onPermissionRequest,
      abortController,
    }: {
      chatCtx: llm.ChatContext
      toolCtx?: llm.ToolContext
      connOptions: APIConnectOptions
      opts: ClaudeLLMOptions
      sessionId: string | null
      onSessionId: (id: string) => void
      eventEmitter: EventEmitter
      onCheckpoint: (checkpointId: string) => void
      onPermissionRequest: (toolName: string, input: Record<string, unknown>) => Promise<PermissionResult>
      abortController?: AbortController
    },
  ) {
    super(llmInstance, { chatCtx, toolCtx, connOptions })
    this.#llmRef = llmInstance
    this.#opts = opts
    this.#sessionId = sessionId
    this.#onSessionId = onSessionId
    this.#eventEmitter = eventEmitter
    this.#onCheckpoint = onCheckpoint
    this.#onPermissionRequest = onPermissionRequest
    this.#abortController = abortController
  }

  protected async run(): Promise<void> {
    const requestId = `claude_${shortuuid()}`
    let activeQuery: any = null

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
      const resumeSessionId = this.#opts.resumeSessionId
      const continueSession = this.#opts.continueSession

      // Session workspace path for system prompt — uses sessionBaseDir (not cwd) so
      // workspace always lives in the Osborn install dir regardless of cwd setting
      const sessionId = this.#sessionId || this.#opts.resumeSessionId || null
      const baseDir = this.#opts.sessionBaseDir || this.#opts.workingDirectory
      const workspacePath = sessionId
        ? (baseDir
            ? `${baseDir}/.osborn/sessions/${sessionId}/`
            : `.osborn/sessions/${sessionId}/`)
        : null

      const allowedTools = this.#opts.allowedTools || []

      const sdkOptions: Options = {
        cwd: this.#opts.workingDirectory,
        permissionMode: this.#opts.permissionMode,
        allowedTools,
        model: this.#opts.model || 'claude-sonnet-4-6', // claude-sonnet-4-6 || claude-haiku-4-5-20251001
        enableFileCheckpointing: true,
        extraArgs: { 'replay-user-messages': null },
        ...(this.#abortController && { abortController: this.#abortController }),
        ...(resumeSessionId && { resume: resumeSessionId }),
        ...(continueSession && !resumeSessionId && { continue: true }),
        ...(this.#sessionId && !resumeSessionId && !continueSession && { resume: this.#sessionId }),
        // System prompt — direct mode gets speech-optimized prompt, realtime gets structured research prompt
        // Skills from agent/.claude/skills/ are appended if present
        systemPrompt: [
          this.#opts.voiceMode === 'direct'
            ? getDirectModeResearchPrompt(workspacePath)
            : getResearchSystemPrompt(workspacePath),
          loadSkillsFromDir(this.#opts.sessionBaseDir || this.#opts.workingDirectory || process.cwd()),
        ].filter(Boolean).join('\n\n'),
        canUseTool: async (toolName, input, _options) => {
          // Auto-approve writes to session workspace (but block spec.md and library/ — fast brain manages those)
          if (toolName === 'Write' || toolName === 'Edit') {
            const filePath = String(input?.file_path || '')
            if (filePath.includes('.osborn/sessions/') || filePath.includes('.osborn/research/')) {
              // Block writes to spec.md and library/ — the fast brain manages these
              const fileName = filePath.split('/').pop() || ''
              if (fileName === 'spec.md' || filePath.includes('/library/')) {
                console.log(`🚫 Blocked research agent write to managed file: ${filePath} (fast brain handles spec.md and library/)`)
                return { behavior: 'deny', message: 'spec.md and library/ are managed by the fast brain sub-agent. Do NOT write to them. Return your findings in your response text — the fast brain will organize them into spec.md and library/ automatically.' }
              }
              console.log(`✅ Auto-approved ${toolName} to workspace: ${filePath}`)
              return { behavior: 'allow', updatedInput: input }
            }
          }
          // Auto-approve AskUserQuestion — research agent should freely ask clarifying questions
          if (toolName === 'AskUserQuestion') {
            console.log(`✅ Auto-approved ${toolName}`)
            return { behavior: 'allow', updatedInput: input }
          }
          // Auto-deny tools the research agent should never use
          if (toolName === 'EnterPlanMode' || toolName === 'ExitPlanMode') {
            console.log(`🚫 Auto-denied ${toolName} (not used in research mode)`)
            return { behavior: 'deny', message: 'Research mode does not use plan mode. Just proceed with the research directly.' }
          }
          console.log(`⚠️ Permission needed: ${toolName}`)
          return this.#onPermissionRequest(toolName, input)
        },
        hooks: {
          PreToolUse: [{
            matcher: '.*',
            hooks: [async (input: any) => {
              const toolName = input?.tool_name || 'unknown'
              const toolInput = input?.tool_input || {}

              // Safety: block Write/Edit outside session workspace
              if (toolName === 'Write' || toolName === 'Edit') {
                const filePath = String(toolInput.file_path || '')
                if (filePath && !filePath.includes('.osborn/sessions/') && !filePath.includes('.osborn/research/')) {
                  console.log(`🚫 Research mode: blocked write to ${filePath}`)
                  this.#eventEmitter.emit('tool_blocked', { name: toolName, reason: 'Research mode: writes restricted to session workspace' })
                  return { decision: 'block', reason: 'Research mode: write to .osborn/sessions/ only.' }
                }
              }

              console.log(`🔧 Claude: ${toolName}`)
              this.#eventEmitter.emit('tool_use', { name: toolName, input: toolInput })
              return {}
            }]
          }],
          PostToolUse: [{
            matcher: '.*',
            hooks: [async (input: any) => {
              const toolName = input?.tool_name || 'unknown'
              const toolInput = input?.tool_input || {}
              const toolResponse = input?.tool_response  // Capture actual tool output for fast brain processing
              console.log(`✅ Done: ${toolName}`)
              this.#eventEmitter.emit('tool_result', { name: toolName, input: toolInput, response: toolResponse })
              return {}
            }]
          }]
        },
        // Writer sub-agent — has write/edit permissions, delegates from main research agent.
        // The main agent handles research, planning, and user interaction.
        // When changes need to be made (code, config, docs, any file), it delegates here.
        agents: {
          writer: {
            description: [
              'Sub-agent with file write and edit permissions.',
              'Delegate here when the user has approved changes and you need to create, modify, or update files.',
              'This is NOT just for code — use it for any file operation: config changes, documentation, scripts, data files, etc.',
              'Pass it a clear, specific plan of what to change. If your instructions are vague, it will ask you clarifying questions before proceeding.',
              'The writer will ask you (the main agent) for clarification if details are missing — answer from your research context if you can, or relay the question to the user if you cannot.',
            ].join(' '),
            tools: ['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Glob', 'Grep', 'NotebookRead', 'NotebookEdit'],
            model: 'sonnet',
            prompt: [
              'You are Osborn\'s writer sub-agent. You have file write and edit permissions. The main agent delegates file operations to you after the user approves a plan.',
              '',
              '## Your role',
              '',
              'You handle ALL file operations — code, config, documentation, scripts, data files, anything that needs to be created or modified. You are not limited to code.',
              '',
              '## Before making changes',
              '',
              '1. Review the plan you were given. If it is clear and specific, proceed.',
              '2. If ANYTHING is vague, ambiguous, or missing — ask the main agent a specific clarifying question BEFORE touching any files. Examples:',
              '   - "Which config format should I use — YAML or JSON?"',
              '   - "Should this go in the existing auth.ts or a new file?"',
              '   - "The plan says \'update the API\' — which endpoints specifically?"',
              '   The main agent will either answer from its research context or ask the user.',
              '3. Restate what you will do before doing it: which files, what changes, in what order.',
              '',
              '## While making changes',
              '',
              '- Make ONLY the changes described in the plan. Do not:',
              '  - Refactor adjacent code',
              '  - Fix unrelated issues you notice',
              '  - Add comments or docs unless asked',
              '  - Change formatting beyond what\'s needed',
              '- If you hit an unexpected issue (file missing, structure doesn\'t match expectations), STOP and report it to the main agent. Do not improvise.',
              '',
              '## After changes',
              '',
              'Provide a concise summary: files changed, what changed in each, and any notes.',
            ].join('\n'),
          },
        },
      }

      // Run Claude Agent SDK query() and stream results
      let hasOutput = false
      let fullResponse = '' // Collect full response for frontend

      // DIRECT MODE OPTIMIZATION: When skipTTSQueue is true, we run the Claude query
      // in the background and return from run() immediately. This is critical because:
      //
      // LiveKit's main speech loop (agent_activity.ts) processes one SpeechHandle at a time.
      // The LLM's SpeechHandle blocks the queue until run() returns (which closes the queue
      // → pipeline completes → _markGenerationDone()). If we await the full query() here,
      // the pipeline is blocked for the entire duration of tool execution (10-30s).
      // Meanwhile, session.say() SpeechHandles queue up but can't play.
      //
      // By returning early, the pipeline completes in milliseconds. The say() handles
      // created by tts_say events get processed by the main loop immediately.
      // The query continues in the background — text arrives via tts_say, tools via hooks.
      if (this.#opts.skipTTSQueue) {
        const bgAbortController = this.#abortController
        const bgEventEmitter = this.#eventEmitter
        const bgOpts = this.#opts
        const bgOnSessionId = this.#onSessionId
        const bgOnCheckpoint = this.#onCheckpoint
        const self = this

        // Fire-and-forget: query runs in background, emits tts_say events as text arrives
        ;(async () => {
          // Declare outside try so finally can access it
          const activeQuery = query({ prompt: userText, options: sdkOptions })
          self.#llmRef.setActiveQuery(activeQuery)

          try {

            for await (const message of activeQuery) {
              // Abort check
              if (bgAbortController?.signal.aborted) break

              // Session ID capture (same as synchronous path)
              if ((message as any).type === 'system' && (message as any).subtype === 'init') {
                const mcpServers = (message as any).mcp_servers
                if (mcpServers && Array.isArray(mcpServers)) {
                  for (const s of mcpServers) {
                    const status = s.status === 'connected' ? '✅' : '❌'
                    console.log(`${status} MCP server ${s.name}: ${s.status}`)
                    if (s.status !== 'connected') {
                      console.log(`   🔍 MCP error:`, JSON.stringify(s))
                    }
                  }
                }
                const newSessionId = (message as any).session_id
                if (newSessionId) {
                  bgOnSessionId(newSessionId)
                  const isNewSession = !self.#sessionId
                  if (isNewSession) console.log(`📋 New session: ${newSessionId}`)
                  self.#sessionId = newSessionId
                  if (isNewSession && bgOpts.workingDirectory) {
                    saveSessionMetadata(bgOpts.workingDirectory, {
                      sessionId: newSessionId,
                      lastUpdated: new Date().toISOString(),
                      projectPath: bgOpts.workingDirectory,
                    })
                  }
                  const requestedResumeId = bgOpts.resumeSessionId
                  if (requestedResumeId && newSessionId !== requestedResumeId) {
                    console.error(`❌ Session resume FAILED: Expected ${requestedResumeId.substring(0, 8)}..., got ${newSessionId.substring(0, 8)}...`)
                    bgEventEmitter.emit('session_resume_failed', { requestedSessionId: requestedResumeId, actualSessionId: newSessionId })
                  } else if (requestedResumeId && newSessionId === requestedResumeId) {
                    console.log(`✅ Session resumed successfully: ${newSessionId.substring(0, 8)}...`)
                  }
                }
              }

              // Checkpoint capture
              if ((message as any).type === 'user' && (message as any).uuid) {
                bgOnCheckpoint((message as any).uuid)
              }

              // Stream text → tts_say events (the whole point of background mode)
              if ((message as any).type === 'assistant' && (message as any).message?.content) {
                const sdkRequestId = (message as any).requestId
                if (sdkRequestId) bgEventEmitter.emit('query_request_id', { requestId: sdkRequestId })

                for (const block of (message as any).message.content) {
                  if (block.type === 'text' && block.text) {
                    hasOutput = true
                    bgEventEmitter.emit('assistant_text', { text: block.text })
                    const ttsChunk = stripMarkdownForTTS(block.text)
                    if (ttsChunk.trim()) {
                      console.log(`🔊 TTS say (${ttsChunk.length} chars): "${ttsChunk.substring(0, 60)}..."`)
                      bgEventEmitter.emit('tts_say', { text: ttsChunk })
                    }
                  }
                }
              }

              // Final result
              if ((message as any).type === 'result' && (message as any).result) {
                bgEventEmitter.emit('assistant_result', { text: (message as any).result })
                if (!hasOutput) {
                  hasOutput = true
                  const ttsText = stripMarkdownForTTS((message as any).result)
                  if (ttsText.trim()) {
                    console.log(`🔊 TTS say result (${ttsText.length} chars): "${ttsText.substring(0, 60)}..."`)
                    bgEventEmitter.emit('tts_say', { text: ttsText })
                  }
                }
              }
            }

            if (!hasOutput) {
              // Silent completion — don't say "Done." in voice pipeline
              // This fires on interruptions, fast brain aborts, and tool-only responses
              // where Claude produces no speech. Silence is better than a confusing "Done."
              console.log('🔇 Claude completed with no speech output (silent)')
            }
            console.log('✅ Claude response complete (background)')
          } catch (error) {
            if (bgAbortController?.signal.aborted) {
              console.log('🛑 Claude Agent SDK query aborted (background)')
              return
            }
            console.error('❌ Claude Agent SDK error (background):', error)
            bgEventEmitter.emit('tts_say', { text: 'Sorry, I encountered an error.' })
          } finally {
            self.#llmRef.removeActiveQuery(activeQuery)
          }
        })()

        // Return immediately — queue closes, pipeline completes, say() handles play
        console.log('🚀 Direct mode: Claude query running in background, pipeline released')
        return
      }

      // Store active query for interrupt/rewind access
      activeQuery = query({ prompt: userText, options: sdkOptions })
      this.#llmRef.setActiveQuery(activeQuery)

      for await (const message of activeQuery) {
        // Capture session ID for context continuity
        if ((message as any).type === 'system' && (message as any).subtype === 'init') {
          // Log MCP server connection status
          const mcpServers = (message as any).mcp_servers
          if (mcpServers && Array.isArray(mcpServers)) {
            for (const s of mcpServers) {
              const status = s.status === 'connected' ? '✅' : '❌'
              console.log(`${status} MCP server ${s.name}: ${s.status}`)
              if (s.status !== 'connected') {
                console.log(`   🔍 MCP error:`, JSON.stringify(s))
              }
            }
          }
          const newSessionId = (message as any).session_id
          if (newSessionId) {
            this.#onSessionId(newSessionId)
            const isNewSession = !this.#sessionId
            if (isNewSession) {
              console.log(`📋 New session: ${newSessionId}`)
            }
            this.#sessionId = newSessionId

            // Save session metadata for new sessions
            if (isNewSession && this.#opts.workingDirectory) {
              saveSessionMetadata(this.#opts.workingDirectory, {
                sessionId: newSessionId,
                lastUpdated: new Date().toISOString(),
                projectPath: this.#opts.workingDirectory,
              })
            }

            // Verify session resume succeeded (if we requested a specific session)
            const requestedResumeId = this.#opts.resumeSessionId
            if (requestedResumeId && newSessionId !== requestedResumeId) {
              console.error(`❌ Session resume FAILED: Expected ${requestedResumeId.substring(0, 8)}..., got ${newSessionId.substring(0, 8)}...`)
              this.#eventEmitter.emit('session_resume_failed', {
                requestedSessionId: requestedResumeId,
                actualSessionId: newSessionId,
              })
            } else if (requestedResumeId && newSessionId === requestedResumeId) {
              console.log(`✅ Session resumed successfully: ${newSessionId.substring(0, 8)}...`)
            }
          }
        }

        // Capture checkpoint UUIDs from user messages (for file rewind capability)
        // Per SDK docs: user messages include a UUID that can be used as a restore point
        if ((message as any).type === 'user' && (message as any).uuid) {
          const checkpointId = (message as any).uuid
          this.#onCheckpoint(checkpointId)
        }

        // Stream text chunks — send each assistant text block to TTS
        if ((message as any).type === 'assistant' && (message as any).message?.content) {
          // Emit SDK requestId on first assistant message — identifies this query()
          // in the JSONL for tracking which research task produced which output
          const sdkRequestId = (message as any).requestId
          if (sdkRequestId) {
            this.#eventEmitter.emit('query_request_id', { requestId: sdkRequestId })
          }

          for (const block of (message as any).message.content) {
            if (block.type === 'text' && block.text) {
              hasOutput = true
              const rawText = block.text

              // Emit RAW text to frontend (for chat bubbles with full formatting)
              this.#eventEmitter.emit('assistant_text', { text: rawText })

              // Strip markdown for clean speech
              const ttsChunk = stripMarkdownForTTS(rawText)
              if (ttsChunk.trim()) {
                if (this.#opts.skipTTSQueue) {
                  // Direct mode: emit event for session.say() — bypasses LiveKit's
                  // BufferedTokenStream which causes stuck/delayed/out-of-order audio
                  console.log(`🔊 TTS say (${ttsChunk.length} chars): "${ttsChunk.substring(0, 60)}..."`)
                  this.#eventEmitter.emit('tts_say', { text: ttsChunk })
                } else {
                  // Realtime mode: use LLM stream queue (framework handles TTS)
                  console.log(`🔊 TTS stream (${ttsChunk.length} chars): "${ttsChunk.substring(0, 60)}..."`)
                  this.queue.put({
                    id: requestId,
                    delta: { role: 'assistant', content: ttsChunk },
                  })
                }
              }
            }
          }
        }

        // Final result — only speak if no text blocks were streamed already
        if ((message as any).type === 'result' && (message as any).result) {
          const rawResult = (message as any).result

          // Emit RAW result to frontend
          this.#eventEmitter.emit('assistant_result', { text: rawResult })

          if (!hasOutput) {
            hasOutput = true
            const ttsText = stripMarkdownForTTS(rawResult)
            if (ttsText.trim()) {
              if (this.#opts.skipTTSQueue) {
                console.log(`🔊 TTS say result (${ttsText.length} chars): "${ttsText.substring(0, 60)}..."`)
                this.#eventEmitter.emit('tts_say', { text: ttsText })
              } else {
                console.log(`🔊 TTS result (${ttsText.length} chars): "${ttsText.substring(0, 60)}..."`)
                this.queue.put({
                  id: requestId,
                  delta: { role: 'assistant', content: ttsText },
                })
              }
            }
          }
        }
      }

      // If Claude produced no output at all, say "Done."
      if (!hasOutput) {
        if (this.#opts.skipTTSQueue) {
          this.#eventEmitter.emit('tts_say', { text: 'Done.' })
        } else {
          this.queue.put({
            id: requestId,
            delta: { role: 'assistant', content: 'Done.' },
          })
        }
      }

      console.log('✅ Claude response complete')

    } catch (error) {
      // AbortError = clean abort (disconnect, new research, recovery) — don't push
      // garbage text that would flow through the post-research pipeline
      if (this.#abortController?.signal.aborted) {
        console.log('🛑 Claude Agent SDK query aborted')
        if (!this.#opts.skipTTSQueue) {
          this.queue.put({ id: requestId, delta: { role: 'assistant', content: '' } })
        }
        return
      }
      console.error('❌ Claude Agent SDK error:', error)
      if (this.#opts.skipTTSQueue) {
        this.#eventEmitter.emit('tts_say', { text: 'Sorry, I encountered an error.' })
      } else {
        this.queue.put({
          id: requestId,
          delta: { role: 'assistant', content: 'Sorry, I encountered an error.' },
        })
      }
    } finally {
      this.#llmRef.removeActiveQuery(activeQuery)
    }
  }
}

/**
 * Create a ClaudeLLM instance
 */
export function createClaudeLLM(opts?: ClaudeLLMOptions): ClaudeLLM {
  return new ClaudeLLM(opts)
}
