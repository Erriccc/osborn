import { Codex } from '@openai/codex-sdk'
import { EventEmitter } from 'events'

interface CodexHandlerOptions {
  workingDirectory?: string
  skipGitRepoCheck?: boolean
}

/**
 * Codex Handler using the official OpenAI Codex SDK
 *
 * Features:
 * - Thread persistence (reuses same thread for context)
 * - Built-in coding tools (file operations, terminal commands)
 * - Hooks for observability
 */
export class CodexHandler extends EventEmitter {
  private codex: Codex
  private thread: ReturnType<Codex['startThread']> | null = null
  private options: CodexHandlerOptions

  constructor(options: CodexHandlerOptions = {}) {
    super()
    this.options = {
      workingDirectory: options.workingDirectory || process.cwd(),
      skipGitRepoCheck: options.skipGitRepoCheck ?? true,
    }

    // Initialize Codex (inherits process env by default)
    this.codex = new Codex()
  }

  async run(prompt: string): Promise<string> {
    try {
      // Create or reuse thread
      if (!this.thread) {
        console.log('🆕 Starting new Codex thread')
        this.thread = this.codex.startThread({
          workingDirectory: this.options.workingDirectory,
          skipGitRepoCheck: this.options.skipGitRepoCheck,
        })
      } else {
        console.log('🔄 Continuing Codex thread')
      }

      console.log(`📁 CWD: ${this.options.workingDirectory}`)

      this.emit('thinking', prompt)

      // Run the prompt and get the Turn result
      const turn = await this.thread.run(prompt)

      // Extract the final response text
      const result = turn.finalResponse || ''

      this.emit('result', result)
      console.log(`✅ Codex done. Length: ${result.length}`)

      // Log tool usage if any
      if (turn.items && turn.items.length > 0) {
        for (const item of turn.items) {
          this.emit('tool_use', item)
        }
      }

      return result || 'Task completed.'
    } catch (error) {
      console.error('❌ Codex SDK error:', error)
      this.emit('error', error)
      throw error
    }
  }

  getThreadId(): string | null {
    // Codex threads have IDs but they may not be directly exposed
    // Check the thread object for an id property
    return (this.thread as any)?.id || null
  }

  clearThread(): void {
    this.thread = null
    console.log('🗑️ Codex thread cleared')
  }
}

// Quick utility for one-off queries
export async function askCodex(prompt: string, cwd?: string): Promise<string> {
  const handler = new CodexHandler({ workingDirectory: cwd })
  return handler.run(prompt)
}
