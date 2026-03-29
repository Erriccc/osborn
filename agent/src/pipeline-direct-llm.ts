/**
 * Pipeline Direct LLM — Wraps ClaudeLLM with parallel Gemini fast brain
 *
 * In pipeline mode, every user message fires two tracks simultaneously:
 *   Track A: Claude SDK (unchanged) — speaks the answer via TTS
 *   Track B: Gemini fast brain (new) — searches JSONL memory, sends result to UI only
 *
 * Phase 1 (current): Gemini is silent — results go to frontend panel for monitoring
 * Phase 2 (future): Gemini speaks first, Claude suppressed when Gemini has HIGH confidence
 */

import { llm, DEFAULT_API_CONNECT_OPTIONS, type APIConnectOptions } from '@livekit/agents'
import { ClaudeLLM, type ClaudeLLMOptions } from './claude-llm.js'
import { askPipelineFastBrain, type PipelineFastBrainResult } from './pipeline-fastbrain.js'
import { buildSummaryIndex, startIndexWatcher, type IndexWatcher } from './summary-index.js'
import { EventEmitter } from 'events'

export interface PipelineDirectOptions extends ClaudeLLMOptions {
  onFastBrainResult?: (result: FastBrainPanelResult) => void
  getChatHistory?: () => { role: string; content: string }[]
  getResearchContext?: () => string | undefined
}

export interface FastBrainPanelResult {
  question: string
  answer: string
  type: string
  elapsedMs: number
  timestamp: number
  toolsUsed: string[]
}

export class PipelineDirectLLM extends llm.LLM {
  #claudeLLM: ClaudeLLM
  #opts: PipelineDirectOptions
  #turnAbort: AbortController | null = null
  #indexWatcher: IndexWatcher | null = null
  #indexBuilding = false

  constructor(opts: PipelineDirectOptions) {
    super()
    this.#claudeLLM = new ClaudeLLM(opts)
    this.#opts = opts
  }

  /** Stop the index watcher (call on disconnect/session switch) */
  stopIndexWatcher() {
    if (this.#indexWatcher) {
      this.#indexWatcher.stop()
      this.#indexWatcher = null
    }
  }

  // Proxy all properties
  get events(): EventEmitter { return this.#claudeLLM.events }
  get sessionId(): string | null { return this.#claudeLLM.sessionId }
  get model(): string { return this.#claudeLLM.model }
  get isResumingSession(): boolean { return this.#claudeLLM.isResumingSession }
  label(): string { return 'pipeline-direct' }

  // Proxy all methods
  setResumeSessionId(id: string | null) { this.#claudeLLM.setResumeSessionId(id) }
  setContinueSession(e: boolean) { this.#claudeLLM.setContinueSession(e) }
  resetForSessionSwitch() { this.#claudeLLM.resetForSessionSwitch() }
  respondToPermission(allow: boolean, msg?: string) { this.#claudeLLM.respondToPermission(allow, msg) }
  hasPendingPermission() { return this.#claudeLLM.hasPendingPermission() }
  getPendingPermission() { return this.#claudeLLM.getPendingPermission() }
  getMcpServers() { return this.#claudeLLM.getMcpServers() }
  setMcpServers(s: any) { this.#claudeLLM.setMcpServers(s) }
  enableMcpServer(k: string, c: any) { this.#claudeLLM.enableMcpServer(k, c) }
  disableMcpServer(k: string) { this.#claudeLLM.disableMcpServer(k) }
  getLatestCheckpoint() { return this.#claudeLLM.getLatestCheckpoint() }
  getFirstCheckpoint() { return this.#claudeLLM.getFirstCheckpoint() }
  getCheckpoints() { return this.#claudeLLM.getCheckpoints() }
  clearCheckpoints() { this.#claudeLLM.clearCheckpoints() }
  hasCheckpoints() { return this.#claudeLLM.hasCheckpoints() }

  chat({
    chatCtx, toolCtx, connOptions = DEFAULT_API_CONNECT_OPTIONS, abortController,
  }: {
    chatCtx: llm.ChatContext
    toolCtx?: llm.ToolContext
    connOptions?: APIConnectOptions
    abortController?: AbortController
  }): llm.LLMStream {

    // Extract user text for fast brain
    let userText = ''
    for (let i = chatCtx.items.length - 1; i >= 0; i--) {
      const item = chatCtx.items[i] as any
      if (item.type === 'message' && item.role === 'user') {
        if (Array.isArray(item.content)) {
          userText = item.content.filter((c: any) => typeof c === 'string').join('\n')
        }
        break
      }
    }

    // Fire Claude — unchanged
    const claudeStream = this.#claudeLLM.chat({ chatCtx, toolCtx, connOptions, abortController })

    // Fire pipeline fast brain in background — no await, no blocking
    if (userText.trim()) {
      this.#firePipelineFastBrain(userText)
    }

    return claudeStream
  }

  async #firePipelineFastBrain(userText: string) {
    // Abort stale turn
    if (this.#turnAbort) this.#turnAbort.abort()
    this.#turnAbort = new AbortController()
    const signal = this.#turnAbort.signal

    const startMs = Date.now()
    // Wait for SDK to assign session ID — listen for event instead of polling
    // Large sessions (22MB+) can take 10-15s for SDK to replay JSONL
    let sessionId = this.#claudeLLM.sessionId
    if (!sessionId) {
      sessionId = await new Promise<string>((resolve) => {
        // Listen for the session_id event from SDK
        const onSessionId = (data: { sessionId: string }) => {
          resolve(data.sessionId)
        }
        this.#claudeLLM.events.once('session_id', onSessionId)
        // Safety timeout — don't wait forever
        setTimeout(() => {
          this.#claudeLLM.events.removeListener('session_id', onSessionId)
          resolve(this.#claudeLLM.sessionId || 'pending')
        }, 15000)
      })
    }
    const workingDir = this.#opts.workingDirectory || process.cwd()
    const sessionBaseDir = this.#opts.sessionBaseDir || workingDir

    // Build summary index on first question (async, non-blocking for subsequent questions)
    if (!this.#indexWatcher && !this.#indexBuilding && sessionId !== 'pending') {
      this.#indexBuilding = true
      try {
        const startBuild = Date.now()
        const state = buildSummaryIndex(sessionId, workingDir, sessionBaseDir,
          (msg) => console.log(`🔍 [index] ${msg}`))
        this.#indexWatcher = startIndexWatcher(sessionId, workingDir, sessionBaseDir, state)
        console.log(`🔍 [index] Built + watching in ${Date.now() - startBuild}ms`)
      } catch (err: any) {
        console.error('🔍 [index] Build failed:', err?.message)
      }
      this.#indexBuilding = false
    }

    try {
      console.log(`🧠⚡ [pipeline] Fast brain: "${userText.substring(0, 60)}"`)

      const result = await askPipelineFastBrain(workingDir, sessionId, userText, {
        chatHistory: this.#opts.getChatHistory?.() || [],
        researchContext: this.#opts.getResearchContext?.(),
        sessionBaseDir,
      })

      if (signal.aborted) return

      const elapsedMs = Date.now() - startMs
      console.log(`🧠⚡ [pipeline] ${result.type} in ${elapsedMs}ms [${result.toolsUsed.join(',')}]: "${result.script.substring(0, 80)}"`)

      this.#opts.onFastBrainResult?.({
        question: userText,
        answer: result.script,
        type: result.type,
        elapsedMs,
        timestamp: Date.now(),
        toolsUsed: result.toolsUsed,
      })

    } catch (err: any) {
      if (err?.name === 'AbortError') return
      console.error('❌ [pipeline] Fast brain error:', err?.message)
    } finally {
      if (this.#turnAbort?.signal === signal) this.#turnAbort = null
    }
  }
}

export function createPipelineDirectLLM(opts: PipelineDirectOptions): PipelineDirectLLM {
  return new PipelineDirectLLM(opts)
}
