/**
 * Codex LLM Wrapper for LiveKit Agents
 *
 * Wraps the Codex Agent SDK (@openai/codex-sdk) to work
 * with LiveKit's AgentSession as an LLM provider.
 *
 * Flow: User speaks → STT → CodexLLM (Agent SDK) → TTS → User hears
 */

import { llm, shortuuid, DEFAULT_API_CONNECT_OPTIONS, type APIConnectOptions } from '@livekit/agents'
import { Codex } from '@openai/codex-sdk'
import { EventEmitter } from 'events'

export interface CodexLLMOptions {
  workingDirectory?: string
  skipGitRepoCheck?: boolean
  /** Event emitter for tool_use, progress updates */
  eventEmitter?: EventEmitter
}

/**
 * Codex LLM - Wraps Codex Agent SDK for LiveKit
 */
export class CodexLLM extends llm.LLM {
  #opts: CodexLLMOptions
  #codex: Codex
  #thread: ReturnType<Codex['startThread']> | null = null
  #eventEmitter: EventEmitter

  constructor(opts: CodexLLMOptions = {}) {
    super()
    this.#opts = {
      workingDirectory: opts.workingDirectory || process.cwd(),
      skipGitRepoCheck: opts.skipGitRepoCheck ?? true,
    }
    this.#codex = new Codex()
    this.#eventEmitter = opts.eventEmitter || new EventEmitter()
    console.log('🟣 CodexLLM initialized (Codex Agent SDK)')
    console.log(`   📁 Working dir: ${this.#opts.workingDirectory}`)
  }

  label(): string {
    return 'codex.agent-sdk'
  }

  get model(): string {
    return 'codex'
  }

  get events(): EventEmitter {
    return this.#eventEmitter
  }

  get thread(): ReturnType<Codex['startThread']> | null {
    return this.#thread
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
    return new CodexLLMStream(this, {
      chatCtx,
      toolCtx,
      connOptions,
      opts: this.#opts,
      codex: this.#codex,
      thread: this.#thread,
      onThread: (t) => { this.#thread = t },
      eventEmitter: this.#eventEmitter,
    })
  }
}

/**
 * Codex LLM Stream - Runs Codex Agent SDK and streams results
 */
class CodexLLMStream extends llm.LLMStream {
  #opts: CodexLLMOptions
  #codex: Codex
  #thread: ReturnType<Codex['startThread']> | null
  #onThread: (t: ReturnType<Codex['startThread']>) => void
  #eventEmitter: EventEmitter

  constructor(
    llmInstance: CodexLLM,
    {
      chatCtx,
      toolCtx,
      connOptions,
      opts,
      codex,
      thread,
      onThread,
      eventEmitter,
    }: {
      chatCtx: llm.ChatContext
      toolCtx?: llm.ToolContext
      connOptions: APIConnectOptions
      opts: CodexLLMOptions
      codex: Codex
      thread: ReturnType<Codex['startThread']> | null
      onThread: (t: ReturnType<Codex['startThread']>) => void
      eventEmitter: EventEmitter
    },
  ) {
    super(llmInstance, { chatCtx, toolCtx, connOptions })
    this.#opts = opts
    this.#codex = codex
    this.#thread = thread
    this.#onThread = onThread
    this.#eventEmitter = eventEmitter
  }

  protected async run(): Promise<void> {
    const requestId = `codex_${shortuuid()}`

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

      console.log(`🎤 User (${userText.length} chars): "${userText}"`)

      // Create or reuse thread
      if (!this.#thread) {
        console.log('🆕 Starting new Codex thread')
        this.#thread = this.#codex.startThread({
          workingDirectory: this.#opts.workingDirectory,
          skipGitRepoCheck: this.#opts.skipGitRepoCheck,
        })
        this.#onThread(this.#thread)
      } else {
        console.log('🔄 Continuing Codex thread')
      }

      // Run Codex and get result
      const turn = await this.#thread.run(userText)

      // Emit tool usage events
      if (turn.items && turn.items.length > 0) {
        for (const item of turn.items) {
          console.log(`🔧 Codex: ${(item as any).type || 'action'}`)
          this.#eventEmitter.emit('tool_use', item)
        }
      }

      // Send response to TTS
      const result = turn.finalResponse || 'Done.'
      this.queue.put({
        id: requestId,
        delta: { role: 'assistant', content: result },
      })

      console.log('✅ Codex response complete')

    } catch (error) {
      console.error('❌ Codex Agent SDK error:', error)
      this.queue.put({
        id: requestId,
        delta: { role: 'assistant', content: 'Sorry, I encountered an error.' },
      })
    }
  }
}

/**
 * Create a CodexLLM instance
 */
export function createCodexLLM(opts?: CodexLLMOptions): CodexLLM {
  return new CodexLLM(opts)
}
