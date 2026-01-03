import { query, type Options, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { EventEmitter } from 'events'
import { appendFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

interface ClaudeHandlerOptions {
  workingDirectory?: string
  allowedTools?: string[]
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions'
  mcpServers?: Record<string, McpServerConfig>
  // If true, ALL tools require permission (not just dangerous ones)
  requireAllPermissions?: boolean
}

export type { McpServerConfig }

export interface PermissionRequestEvent {
  toolName: string
  description: string
  toolInput: any
  toolUseId: string
}

interface PermissionRequest {
  toolName: string
  toolInput: any
  toolUseId: string
  resolve: (response: PermissionResponse) => void
}

// Tool call log entry
interface ToolLogEntry {
  timestamp: string
  toolName: string
  toolUseId: string
  input: any
  status: 'started' | 'completed' | 'blocked'
  output?: any
  duration?: number
  error?: string
}

// Ensure log directory exists
const LOG_DIR = join(homedir(), '.osborn', 'logs')
if (!existsSync(LOG_DIR)) {
  mkdirSync(LOG_DIR, { recursive: true })
}

// Log file path (rotates daily)
function getLogFilePath(): string {
  const date = new Date().toISOString().split('T')[0]
  return join(LOG_DIR, `tool-calls-${date}.jsonl`)
}

// Append log entry (non-blocking)
function logToolCall(entry: ToolLogEntry): void {
  try {
    const line = JSON.stringify(entry) + '\n'
    appendFileSync(getLogFilePath(), line)
  } catch (err) {
    // Don't fail if logging fails
    console.error('⚠️ Failed to write tool log:', (err as Error).message)
  }
}

/**
 * Claude Handler using the official Claude Agent SDK
 *
 * Features:
 * - Session persistence (reuses same session for context)
 * - Built-in tools (Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch)
 * - Permission interception for voice approval
 * - Hooks for observability
 */
export type PermissionResponse = 'allow' | 'deny' | 'always_allow'

export class ClaudeHandler extends EventEmitter {
  private options: ClaudeHandlerOptions
  private abortController: AbortController | null = null
  private sessionId: string | null = null
  private pendingPermission: PermissionRequest | null = null

  // Track tool call start times for duration logging
  private toolStartTimes: Map<string, number> = new Map()

  // Tools the user has permanently approved (for this session)
  private alwaysAllowedTools: Set<string> = new Set()

  // All available Claude Agent SDK tools
  private static readonly ALL_TOOLS = [
    // File operations
    'Read', 'Write', 'Edit', 'MultiEdit',
    // Search
    'Glob', 'Grep',
    // Terminal
    'Bash',
    // Web
    'WebSearch', 'WebFetch',
    // Notebooks
    'NotebookEdit',
    // Task management
    'Task', 'TodoWrite',
    // LSP (Language Server Protocol)
    'LSP',
  ]

  constructor(options: ClaudeHandlerOptions = {}) {
    super()
    this.options = {
      workingDirectory: options.workingDirectory || process.cwd(),
      allowedTools: options.allowedTools || ClaudeHandler.ALL_TOOLS,
      permissionMode: options.permissionMode || 'default',
      mcpServers: options.mcpServers,
      // By default, require permission for ALL tools
      requireAllPermissions: options.requireAllPermissions ?? true,
    }
    console.log(`🔧 Allowed tools: ${this.options.allowedTools?.join(', ')}`)
    console.log(`🔐 Require all permissions: ${this.options.requireAllPermissions}`)
    console.log(`📝 Tool logs: ${LOG_DIR}`)
    if (this.options.mcpServers) {
      console.log(`🔌 MCP servers: ${Object.keys(this.options.mcpServers).join(', ')}`)
    }
  }

  /**
   * Generate human-readable description for a tool call
   */
  private getToolDescription(toolName: string, toolInput: any): string {
    switch (toolName) {
      case 'Bash':
        return `Run command: ${toolInput.command || 'unknown command'}`
      case 'Write':
        return `Create file: ${toolInput.file_path || 'unknown file'}`
      case 'Edit':
        return `Edit file: ${toolInput.file_path || 'unknown file'}`
      case 'MultiEdit':
        return `Multi-edit: ${toolInput.edits?.length || 0} edits`
      case 'Read':
        return `Read file: ${toolInput.file_path || 'unknown file'}`
      case 'Glob':
        return `Find files: ${toolInput.pattern || 'unknown pattern'}`
      case 'Grep':
        return `Search content: "${toolInput.pattern || 'unknown'}" in ${toolInput.path || 'cwd'}`
      case 'WebSearch':
        return `🌐 Web search: "${toolInput.query || 'unknown query'}"`
      case 'WebFetch':
        return `🌐 Fetch URL: ${toolInput.url || 'unknown url'}`
      case 'NotebookEdit':
        return `Edit notebook: ${toolInput.notebook_path || 'unknown'}`
      case 'Task':
        return `Spawn task: ${toolInput.description || 'unknown task'}`
      case 'TodoWrite':
        return `Update todos: ${toolInput.todos?.length || 0} items`
      case 'LSP':
        return `LSP ${toolInput.operation || 'query'}: ${toolInput.filePath || 'unknown'}`
      default:
        // For MCP tools, show the tool name and first few input keys
        const inputKeys = Object.keys(toolInput || {}).slice(0, 3).join(', ')
        return `${toolName}: ${inputKeys || 'no params'}`
    }
  }

  async run(prompt: string): Promise<string> {
    this.abortController = new AbortController()
    let fullResponse = ''

    try {
      // Log session state
      if (this.sessionId) {
        console.log(`🔄 RESUMING session: ${this.sessionId}`)
      } else {
        console.log('🆕 STARTING new session')
      }
      console.log(`📁 CWD: ${this.options.workingDirectory}`)
      console.log(`🔑 Mode: ${this.options.permissionMode}`)

      // Build SDK options with session resume
      const sdkOptions: Options = {
        allowedTools: this.options.allowedTools,
        cwd: this.options.workingDirectory,
        permissionMode: this.options.permissionMode,
        abortController: this.abortController || undefined,
        // CRITICAL: Resume existing session for context continuity
        ...(this.sessionId && { resume: this.sessionId }),
        // MCP servers configuration
        ...(this.options.mcpServers && { mcpServers: this.options.mcpServers }),
        hooks: {
          PreToolUse: [{
            matcher: '.*',
            hooks: [async (input: any, toolUseId?: string) => {
              const toolName = input?.tool_name || 'unknown'
              const toolInput = input?.tool_input || {}
              const id = toolUseId || `tool-${Date.now()}`
              const description = this.getToolDescription(toolName, toolInput)

              // Record start time for duration tracking
              this.toolStartTimes.set(id, Date.now())

              // Log tool start (background, non-blocking)
              logToolCall({
                timestamp: new Date().toISOString(),
                toolName,
                toolUseId: id,
                input: toolInput,
                status: 'started',
              })

              console.log(`🔧 Tool: ${toolName}`)
              console.log(`   📋 ${description}`)
              this.emit('tool_use', { name: toolName, input: toolInput, description })

              // Check if this tool needs permission
              // In default mode with requireAllPermissions, ALL tools need permission
              const needsPermission = this.options.permissionMode === 'default' &&
                                     this.options.requireAllPermissions

              if (needsPermission) {
                // Skip if user has permanently approved this tool
                if (this.alwaysAllowedTools.has(toolName)) {
                  console.log(`✅ Auto-approved (always allow): ${toolName}`)
                } else {
                  console.log(`⚠️ Permission required for: ${toolName}`)

                  // Emit permission request and wait for approval
                  const response = await this.requestPermission(toolName, toolInput, id, description)

                  if (response === 'deny') {
                    console.log(`❌ Permission denied for: ${toolName}`)

                    // Log blocked tool
                    logToolCall({
                      timestamp: new Date().toISOString(),
                      toolName,
                      toolUseId: id,
                      input: toolInput,
                      status: 'blocked',
                      error: 'User denied permission',
                    })

                    return {
                      decision: 'block',
                      reason: 'User denied permission for this operation'
                    }
                  }

                  if (response === 'always_allow') {
                    this.alwaysAllowedTools.add(toolName)
                    console.log(`✅ Permission granted (always allow): ${toolName}`)
                  } else {
                    console.log(`✅ Permission granted for: ${toolName}`)
                  }
                }
              }

              return {} // Allow tool to proceed
            }]
          }],
          PostToolUse: [{
            matcher: '.*',
            hooks: [async (input: any, toolUseId?: string) => {
              const toolName = input?.tool_name || 'unknown'
              const toolOutput = input?.tool_output || input?.output
              const id = toolUseId || 'unknown'

              // Calculate duration
              const startTime = this.toolStartTimes.get(id)
              const duration = startTime ? Date.now() - startTime : undefined
              this.toolStartTimes.delete(id)

              // Log tool completion (background, non-blocking)
              logToolCall({
                timestamp: new Date().toISOString(),
                toolName,
                toolUseId: id,
                input: input?.tool_input || {},
                status: 'completed',
                output: toolOutput ? (typeof toolOutput === 'string' ? toolOutput.substring(0, 500) : 'object') : undefined,
                duration,
              })

              console.log(`✅ Completed: ${toolName} (${duration ? duration + 'ms' : 'unknown duration'})`)
              this.emit('tool_result', { name: toolName, output: toolOutput, duration })
              return {}
            }]
          }]
        }
      }

      // Run the query
      for await (const message of query({
        prompt,
        options: sdkOptions,
      })) {
        this.handleMessage(message)

        // Capture session ID from init
        if ((message as any).type === 'system' && (message as any).subtype === 'init') {
          const newSessionId = (message as any).session_id
          if (newSessionId) {
            if (!this.sessionId) {
              this.sessionId = newSessionId
              console.log(`📋 Session CREATED: ${this.sessionId}`)
            } else if (this.sessionId === newSessionId) {
              console.log(`📋 Session CONTINUED: ${this.sessionId}`)
            } else {
              // Session ID changed - SDK created new session despite resume
              console.log(`⚠️ Session CHANGED: ${this.sessionId} → ${newSessionId}`)
              this.sessionId = newSessionId
            }
          }
        }

        // Collect text from assistant
        if ((message as any).type === 'assistant' && (message as any).message?.content) {
          for (const block of (message as any).message.content) {
            if (block.type === 'text') {
              fullResponse += block.text
            }
          }
        }

        // Final result
        if ((message as any).type === 'result') {
          console.log(`📋 Result: ${(message as any).subtype}`)
          if ((message as any).result && !fullResponse) {
            fullResponse = (message as any).result
          }
        }
      }

      console.log(`✅ Done. Length: ${fullResponse.length}`)
      return fullResponse || 'Task completed.'

    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        this.emit('aborted')
        return 'Task was cancelled.'
      }
      console.error('❌ SDK error:', error)
      this.emit('error', error)
      // Don't clear session on error - might be transient
      throw error
    }
  }

  /**
   * Request permission from user via event emission
   * Returns a promise that resolves when user responds with allow/deny/always_allow
   */
  private requestPermission(toolName: string, toolInput: any, toolUseId: string, description?: string): Promise<PermissionResponse> {
    return new Promise((resolve) => {
      // Use provided description or generate one
      const desc = description || this.getToolDescription(toolName, toolInput)

      this.pendingPermission = { toolName, toolInput, toolUseId, resolve: resolve as any }

      // Emit event for voice handler to pick up
      this.emit('permission_request', {
        toolName,
        description: desc,
        toolInput,
        toolUseId,
      })

      // No auto-approve - wait for user response (with 2 minute timeout for safety)
      setTimeout(() => {
        if (this.pendingPermission?.toolUseId === toolUseId) {
          console.log(`⏰ Permission timeout - denying for safety: ${toolName}`)
          this.pendingPermission = null
          resolve('deny')
        }
      }, 120000) // 2 minute timeout
    })
  }

  /**
   * Respond to a pending permission request
   */
  respondToPermission(response: PermissionResponse): void {
    if (this.pendingPermission) {
      console.log(`📋 Permission response: ${response}`)
      this.pendingPermission.resolve(response)
      this.pendingPermission = null
    }
  }

  /**
   * Grant permission for pending request (shorthand)
   */
  grantPermission(): void {
    this.respondToPermission('allow')
  }

  /**
   * Deny permission for pending request (shorthand)
   */
  denyPermission(): void {
    this.respondToPermission('deny')
  }

  /**
   * Always allow this tool type (shorthand)
   */
  alwaysAllowPermission(): void {
    this.respondToPermission('always_allow')
  }

  /**
   * Check if there's a pending permission request
   */
  hasPendingPermission(): boolean {
    return this.pendingPermission !== null
  }

  /**
   * Get current pending permission info (for displaying to user)
   */
  getPendingPermission(): PermissionRequestEvent | null {
    if (!this.pendingPermission) return null
    const { toolName, toolInput, toolUseId } = this.pendingPermission
    const description = this.getToolDescription(toolName, toolInput)
    return { toolName, description, toolInput, toolUseId }
  }

  /**
   * Get list of always-allowed tools
   */
  getAlwaysAllowedTools(): string[] {
    return Array.from(this.alwaysAllowedTools)
  }

  /**
   * Reset always-allowed tools
   */
  resetAlwaysAllowed(): void {
    this.alwaysAllowedTools.clear()
    console.log('🔄 Reset always-allowed tools')
  }

  getSessionId(): string | null {
    return this.sessionId
  }

  clearSession(): void {
    this.sessionId = null
    console.log('🗑️ Session cleared')
  }

  private handleMessage(message: any): void {
    switch (message.type) {
      case 'assistant':
        if (message.message?.content) {
          for (const block of message.message.content) {
            if (block.type === 'text') {
              this.emit('text', block.text)
            } else if (block.type === 'tool_use') {
              this.emit('tool_use', {
                id: block.id,
                name: block.name,
                input: block.input,
              })
            }
          }
        }
        break

      case 'tool_result':
        this.emit('tool_result', {
          id: message.tool_use_id,
          content: message.content,
        })
        break

      case 'system':
        this.emit('system', message)
        break

      case 'result':
        this.emit('result', message)
        break

      default:
        this.emit('message', message)
    }
  }

  stop(): void {
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }
  }
}

// Quick utility for one-off queries
export async function askClaude(prompt: string, cwd?: string): Promise<string> {
  const handler = new ClaudeHandler({ workingDirectory: cwd })
  return handler.run(prompt)
}
