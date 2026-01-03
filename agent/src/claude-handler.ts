import { query, type Options } from '@anthropic-ai/claude-agent-sdk'
import { EventEmitter } from 'events'

interface ClaudeHandlerOptions {
  workingDirectory?: string
  allowedTools?: string[]
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions'
}

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

  // Tools that require permission
  private dangerousTools = ['Bash', 'Write', 'Edit']

  // Tools the user has permanently approved
  private alwaysAllowedTools: Set<string> = new Set()

  constructor(options: ClaudeHandlerOptions = {}) {
    super()
    this.options = {
      workingDirectory: options.workingDirectory || process.cwd(),
      allowedTools: options.allowedTools || ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'],
      permissionMode: options.permissionMode || 'default',
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
        hooks: {
          PreToolUse: [{
            matcher: '.*',
            hooks: [async (input: any, toolUseId?: string) => {
              const toolName = input?.tool_name || 'unknown'
              const toolInput = input?.tool_input || {}

              console.log(`🔧 Tool: ${toolName}`)
              this.emit('tool_use', { name: toolName, input: toolInput })

              // Check if this tool needs permission
              if (this.dangerousTools.includes(toolName) && this.options.permissionMode === 'default') {
                // Skip if user has permanently approved this tool
                if (this.alwaysAllowedTools.has(toolName)) {
                  console.log(`✅ Auto-approved (always allow): ${toolName}`)
                } else {
                  console.log(`⚠️ Permission required for: ${toolName}`)

                  // Emit permission request and wait for approval
                  const response = await this.requestPermission(toolName, toolInput, toolUseId || 'unknown')

                  if (response === 'deny') {
                    console.log(`❌ Permission denied for: ${toolName}`)
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
            hooks: [async (input: any) => {
              const toolName = input?.tool_name || 'unknown'
              console.log(`✅ Completed: ${toolName}`)
              this.emit('tool_result', { name: toolName })
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
  private requestPermission(toolName: string, toolInput: any, toolUseId: string): Promise<PermissionResponse> {
    return new Promise((resolve) => {
      // Format the permission request message
      let description = ''
      if (toolName === 'Bash') {
        description = `Run command: ${toolInput.command || 'unknown command'}`
      } else if (toolName === 'Write') {
        description = `Create file: ${toolInput.file_path || 'unknown file'}`
      } else if (toolName === 'Edit') {
        description = `Edit file: ${toolInput.file_path || 'unknown file'}`
      }

      this.pendingPermission = { toolName, toolInput, toolUseId, resolve: resolve as any }

      // Emit event for voice handler to pick up
      this.emit('permission_request', {
        toolName,
        description,
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
    let description = ''
    if (toolName === 'Bash') {
      description = `Run command: ${toolInput.command || 'unknown command'}`
    } else if (toolName === 'Write') {
      description = `Create file: ${toolInput.file_path || 'unknown file'}`
    } else if (toolName === 'Edit') {
      description = `Edit file: ${toolInput.file_path || 'unknown file'}`
    }
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
