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

export interface InterruptionContext {
  spokenText: string       // what user heard (word-accurate from LiveKit synchronizedTranscript)
  recentMessages: string   // last 10 assistant messages from JSONL (full untruncated)
  /**
   * Text the agent generated while the user was still speaking, which we
   * suppressed at session.say() to avoid talking over the user. The agent
   * receives this so it knows what it tried to say but the user did not hear,
   * and can re-articulate the relevant bits in its next response.
   */
  suppressedText: string
}

export interface PipelineDirectOptions extends ClaudeLLMOptions {
  onFastBrainResult?: (result: FastBrainPanelResult) => void
  getChatHistory?: () => { role: string; content: string }[]
  getResearchContext?: () => string | undefined
  /** Returns pending interruption context and clears it (consumed once). null = no pending interruption. */
  getAndConsumeInterruptionContext?: () => InterruptionContext | null
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
  // True while the in-flight turn is a [MEETING —] chunk — the tts_say gate in
  // index.ts reads this to skip browser session.say() (meeting audio goes via
  // /canvas, not the laptop speakers → no same-room feedback). Set per chat().
  public suppressMeetingTTS = false

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
  resetForSessionSwitch() {
    this.stopIndexWatcher()
    this.#indexBuilding = false
    this.#claudeLLM.resetForSessionSwitch()
  }
  respondToPermission(allow: boolean, msg?: string) { this.#claudeLLM.respondToPermission(allow, msg) }
  hasPendingPermission() { return this.#claudeLLM.hasPendingPermission() }
  getPendingPermission() { return this.#claudeLLM.getPendingPermission() }
  getMcpServers() { return this.#claudeLLM.getMcpServers() }
  setMcpServers(s: any) { this.#claudeLLM.setMcpServers(s) }

  // Agent control — proxied to ClaudeLLM for fast brain access
  async interruptAgent() { return this.#claudeLLM.interruptQuery() }
  abortAgent() { this.#claudeLLM.abortQuery() }
  async rewindAgent(checkpointId?: string) { return this.#claudeLLM.rewindToCheckpoint(checkpointId) }
  hasActiveAgent() { return this.#claudeLLM.hasActiveQuery() }

  /** Send a new prompt to Claude via direct chat() — event listeners stay attached */
  sendPrompt(prompt: string) {
    console.log(`📋 [pipeline] Sending prompt to Claude (${prompt.length} chars)`)
    const chatCtx = new llm.ChatContext()
    chatCtx.addMessage({ role: 'user', content: prompt })
    this.#claudeLLM.chat({ chatCtx })
  }
  enableMcpServer(k: string, c: any) { this.#claudeLLM.enableMcpServer(k, c) }
  disableMcpServer(k: string) { this.#claudeLLM.disableMcpServer(k) }
  getLatestCheckpoint() { return this.#claudeLLM.getLatestCheckpoint() }
  getFirstCheckpoint() { return this.#claudeLLM.getFirstCheckpoint() }
  getCheckpoints() { return this.#claudeLLM.getCheckpoints() }
  clearCheckpoints() { this.#claudeLLM.clearCheckpoints() }
  hasCheckpoints() { return this.#claudeLLM.hasCheckpoints() }

  #chatCallCount = 0

  chat({
    chatCtx, toolCtx, connOptions = DEFAULT_API_CONNECT_OPTIONS, abortController,
  }: {
    chatCtx: llm.ChatContext
    toolCtx?: llm.ToolContext
    connOptions?: APIConnectOptions
    abortController?: AbortController
  }): llm.LLMStream {
    const callN = ++this.#chatCallCount

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

    console.log(`📥 [pipeline] chat() call #${callN} (${userText.length} chars): "${userText}"`)

    // Always check the pending playback context — it can carry two independent
    // signals: (a) an actual interruption (spokenText + recentMessages) when the
    // user cut Osborn off mid-TTS, OR (b) suppressed text generated by the SDK
    // while the user was speaking, regardless of whether they were actually
    // interrupting active TTS. We need to forward BOTH cases so the agent knows
    // what it produced that the user didn't hear, and so the buffer is cleared
    // every turn even when there was no interrupt.
    const interruptCtx = this.#opts.getAndConsumeInterruptionContext?.()
    if (interruptCtx && userText.trim()) {
      const hasInterrupt = !!interruptCtx.spokenText
      const hasSuppressed = !!interruptCtx.suppressedText
      const suppressedBlock = hasSuppressed
        ? [
            ``,
            `Text you generated while the user was speaking — NOT played (we suppressed it so we wouldn't talk over them):`,
            `"${interruptCtx.suppressedText}"`,
            `If any of that is still relevant to the user's current message, re-articulate the key points naturally. If it's no longer relevant, drop it.`,
          ].join('\n')
        : ''

      let enrichedMessage: string
      if (hasInterrupt) {
        // Actual mid-TTS interruption — keep the full [INTERRUPTED] template
        console.log(`🔇 [pipeline] Enriching: interrupt (spoken=${interruptCtx.spokenText.length} chars, suppressed=${interruptCtx.suppressedText.length} chars)`)
        this.#claudeLLM.interruptQuery().catch(() => {})
        enrichedMessage = [
          `[INTERRUPTED] The user interrupted your response mid-speech.`,
          ``,
          `What the user heard before cutoff:`,
          `"${interruptCtx.spokenText}"`,
          ``,
          `WHAT THE USER DID NOT HEAR (you wrote this but it was cut off):`,
          `Anything in "Your recent messages" below that appears AFTER the quoted heard text is content the user did not hear. The user has no memory of it.`,
          ``,
          `Your recent messages (full untruncated — you wrote these):`,
          interruptCtx.recentMessages || '(no recent messages found)',
          suppressedBlock,
          ``,
          `User's message: "${userText}"`,
          ``,
          `CONTEXT PRESERVATION (READ THIS):`,
          `The user has NO memory of unheard content. If any of it bears on their current message — answers a question they just asked, sets up a follow-up they're now asking about, or shows a knowledge gap and fills in a detail they're reacting to — you MUST surface it. Briefly is fine if their message is off-topic or explores a direction they haven't asked about yet. But never assume they remember what they never heard.`,
          ``,
          `RESPOND with speech first, then act:`,
          `- ALWAYS reply with at least one spoken sentence before doing any tool calls`,
          `- If it's a quick side question, answer it then continue where you left off`,
          `- If they want to change direction, acknowledge and follow their lead`,
          `- Clarify when asked to or the question requires going over what you just said`,
          `- If relevant details were cut off — whether they answer the current question or an earlier one — weave them back in naturally so the user stays in context without having to ask again.`,
        ].join('\n')
      } else if (hasSuppressed) {
        // No real interrupt — user was speaking while we had text queued. They
        // weren't cutting Osborn off, just talking over a gap. Don't claim an
        // interrupt happened; symmetric structure to [INTERRUPTED] so Claude
        // treats both signals consistently.
        console.log(`🤐 [pipeline] Enriching: suppressed-only (${interruptCtx.suppressedText.length} chars, no interrupt)`)
        enrichedMessage = [
          `[CONTEXT] You generated speech while the user was already talking. None of it played.`,
          ``,
          `What the user is saying now:`,
          `"${userText}"`,
          ``,
          `Text you produced that the user did NOT hear:`,
          `"${interruptCtx.suppressedText}"`,
          ``,
          `CONTEXT PRESERVATION (READ THIS):`,
          `The user has NO memory of the unheard text. If any of it bears on their current message — answers a question they just asked, sets up a follow-up they're now asking about, or shows a knowledge gap and fills in a detail they're reacting to — you MUST surface it. Briefly is fine if their message is off-topic or explores a direction they haven't asked about yet. But never assume they remember what they never heard.`,
          ``,
          `RESPOND with speech first, then act:`,
          `- ALWAYS reply with at least one spoken sentence before doing any tool calls`,
          `- Three likely cases — figure out which applies:`,
          `  (a) the user didn't realize you were responding → forward the key points of the unheard text`,
          `  (b) the user changed direction → drop the unheard text, follow their lead`,
          `  (c) the user's message builds on the unheard text → integrate it as if they'd heard it`,
          `- Keep it tight — this is a voice response.`,
        ].join('\n')
      } else {
        // Context object existed but both fields empty — defensive no-op,
        // shouldn't happen because appendSuppressedText only creates entries
        // when text is non-empty.
        enrichedMessage = userText
      }

      // Modify the last user message in chatCtx
      for (let i = chatCtx.items.length - 1; i >= 0; i--) {
        const item = chatCtx.items[i] as any
        if (item.type === 'message' && item.role === 'user') {
          item.content = [enrichedMessage]
          break
        }
      }
    }

    // Meeting chunks ([MEETING —]) are the silent-observer / addressed-response
    // path. They must NOT drive the browser voice session: (a) no session.say()
    // TTS — the Meet mic re-captures browser audio in the same room → feedback;
    // the agent speaks INTO the meeting via /canvas instead; (b) no fast brain —
    // it's chat-panel noise ("Is there something you'd like to know?") on meeting
    // speech. Set BEFORE the response streams so the tts_say gate (index.ts) sees
    // it. Cleared implicitly by the next real user turn (which isn't a [MEETING]).
    const isMeetingChunk = userText.startsWith('[MEETING')
    this.suppressMeetingTTS = isMeetingChunk

    // Fire Claude
    const claudeStream = this.#claudeLLM.chat({ chatCtx, toolCtx, connOptions, abortController })

    // Fire pipeline fast brain in background — no await, no blocking. Skip for
    // meeting chunks (silent observer / meeting-response path, not a user turn).
    if (userText.trim() && !isMeetingChunk) {
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
        const state = buildSummaryIndex(sessionId, workingDir, undefined,
          (msg) => console.log(`🔍 [index] ${msg}`))
        this.#indexWatcher = startIndexWatcher(sessionId, workingDir, undefined, state)
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
        agentControl: {
          interrupt: () => this.#claudeLLM.interruptQuery(),
          abort: () => this.#claudeLLM.abortQuery(),
          hasActiveAgent: () => this.#claudeLLM.hasActiveQuery(),
          getRecentUserMessages: (count: number) => {
            const history = this.#opts.getChatHistory?.() || []
            return history
              .filter(t => t.role === 'user')
              .slice(-count)
              .map(t => t.content)
          },
          sendPrompt: (prompt: string) => {
            // Direct call to ClaudeLLM.chat() — event listeners (tts_say, tool_use, etc.) still attached
            // skipTTSQueue mode: tts_say events → index.ts → session.say() — works independently
            console.log(`🧠⚡ [control] Sending new prompt to Claude (${prompt.length} chars)`)
            const chatCtx = new llm.ChatContext()
            chatCtx.addMessage({ role: 'user', content: prompt })
            this.#claudeLLM.chat({ chatCtx })
          },
        },
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
