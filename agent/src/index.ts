// Load environment variables FIRST before any other imports
import 'dotenv/config'

import { voice, initializeLogger, type Agent } from '@livekit/agents'
import { Room, RoomEvent, RemoteParticipant, LocalParticipant } from '@livekit/rtc-node'
import { AccessToken } from 'livekit-server-sdk'

// Initialize logger before anything else
initializeLogger({ pretty: true, level: 'info' })

import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { loadConfig, getMcpServers, getEnabledMcpServerNames, getVoiceMode, getRealtimeConfig, getDirectConfig, listSessions, getMostRecentSessionId, sessionExists, cleanupOrphanedMetadata, getSessionSummary, getConversationHistory, ensureSessionWorkspace, getMcpServerStatusList, buildMcpServersForKeys, listResearchArtifacts, listWorkspaceArtifacts, readSessionSpec, listLibraryFiles, type VoiceMode, type SessionInfo, type SessionSummary, type ConversationExchange } from './config.js'
import { createSTT, createTTS, createVAD, createRealtimeModelFromConfig } from './voice-io.js'
import { createClaudeLLM } from './claude-llm.js'
import { createSmitheryProxy, destroySmitheryProxy, parseSmitheryUrl, isSmitheryUrl, SmitheryAuthorizationError } from './smithery-proxy.js'
import { askHaiku, updateSpecFromJSONL } from './fast-brain.js'
import { DIRECT_MODE_PROMPT, getRealtimeInstructions, getResearchCompleteInjection, getResearchUpdateInjection, getNotificationInjection } from './prompts.js'
import { MCP_CATALOG } from './config.js'
import { llm } from '@livekit/agents'
import { z } from 'zod'

// ============================================================
// DUAL MODE VOICE ARCHITECTURE
// ============================================================
// DIRECT MODE (default): STT → Claude Agent SDK → TTS
//   - Full coding capabilities via Claude Agent SDK
//   - Permission system flows to frontend
//   - Best for actual coding tasks
//
// REALTIME MODE: OpenAI/Gemini native speech-to-speech
//   - Faster response, lower latency
//   - Voice LLM with tool calling (ask_agent, respond_permission)
//   - Routes tasks to Claude agents for execution
// ============================================================

// Generate a short, user-friendly room code
function generateRoomCode(): string {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789'
  let code = ''
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)]
  }
  return code
}

// Parse CLI arguments
function parseArgs(): { roomCode?: string } {
  const args = process.argv.slice(2)
  let roomCode: string | undefined

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--room' && args[i + 1]) {
      roomCode = args[i + 1]
    }
    // Short code detection (e.g., `npm run dev abc123`)
    if (!args[i].startsWith('-') && args[i].length >= 4 && args[i].length <= 10 &&
        !['dev', 'start'].includes(args[i])) {
      roomCode = args[i]
    }
  }

  return { roomCode }
}

// Global error handlers
process.on('unhandledRejection', (reason: any) => {
  const msg = reason?.message || String(reason)
  if (msg.includes('aborted') || msg.includes('AbortError')) {
    console.log('⚠️ LLM request aborted (user interrupted)')
    return
  }
  // Gemini plugin intentionally supersedes generate_reply calls — safe to suppress
  if (msg.includes('Superseded')) {
    console.log('⚠️ generateReply superseded (expected during concurrent injections)')
    return
  }
  // OpenAI race: voice queue fired while server-side VAD already created a response
  if (msg.includes('conversation_already_has_active_response') || msg.includes('active_response')) {
    console.log('⚠️ OpenAI active response collision (will retry on next listening state)')
    return
  }
  console.error('❌ Unhandled Rejection:', msg)
})

process.on('uncaughtException', (error) => {
  if (error.message?.includes('aborted') || error.message?.includes('AbortError')) {
    console.log('⚠️ Operation aborted')
    return
  }
  console.error('❌ Uncaught Exception:', error)
})

// ============================================================
// HTTP API SERVER - Exposes session data to cloud-deployed frontend
// ============================================================

function startApiServer(workingDir: string, port: number): void {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS headers for cloud frontend
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url || '/', `http://localhost:${port}`)

    if (req.method === 'GET' && url.pathname === '/sessions') {
      try {
        await cleanupOrphanedMetadata(workingDir)
        const sessions = await listSessions(workingDir)
        const payload = {
          sessions: sessions.map(s => ({
            sessionId: s.sessionId,
            timestamp: s.timestamp.toISOString(),
            lastMessage: s.lastMessage,
            messageCount: s.messageCount,
          })),
          total: sessions.length,
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(payload))
      } catch (err) {
        console.error('API /sessions error:', err)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ sessions: [], total: 0, error: 'Failed to list sessions' }))
      }
      return
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', workingDir }))
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
  })

  server.listen(port, () => {
    console.log(`🌐 API server listening on http://localhost:${port}`)
    console.log(`   Sessions: http://localhost:${port}/sessions`)
  })

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`⚠️ API port ${port} in use, trying ${port + 1}...`)
      startApiServer(workingDir, port + 1)
    } else {
      console.error('❌ API server error:', err)
    }
  })
}

// ============================================================
// SESSION CONTEXT HELPERS
// ============================================================

/**
 * Build a context briefing string for the realtime agent
 * Loads session conversation history so the model has deep context.
 * Gemini has smaller context limits — cap at 10 exchanges with 500 char content.
 * OpenAI handles full history (30 exchanges, 2000 char content).
 */
function buildContextBriefing(
  summary: SessionSummary,
  history: ConversationExchange[],
  provider?: string
): string {
  const isGemini = provider === 'gemini'
  // Gemini: last 10 exchanges capped at 500 chars. OpenAI: full history.
  const maxExchanges = isGemini ? 10 : history.length
  const maxContentLen = isGemini ? 500 : 2000
  const trimmedHistory = history.slice(-maxExchanges)

  const lines = [
    `Session ID: ${summary.sessionId.substring(0, 8)}`,
    `Total messages: ${summary.messageCount}`,
    '',
    '=== SESSION CONVERSATION HISTORY ==='
  ]

  for (const exchange of trimmedHistory) {
    const content = exchange.content.length > maxContentLen
      ? exchange.content.substring(0, maxContentLen) + '...'
      : exchange.content
    lines.push(`${exchange.role === 'user' ? 'User' : 'Assistant'}: ${content}`)
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * Read spec.md and format it for the realtime voice model.
 * Truncates to avoid bloating the context window.
 * Returns null if spec doesn't exist or session ID isn't available.
 */
function getSpecForVoiceModel(workingDir: string, sessionId: string | null | undefined): string | null {
  if (!sessionId) return null
  const specContent = readSessionSpec(workingDir, sessionId)
  if (!specContent) return null
  const MAX = 3000
  if (specContent.length <= MAX) return specContent
  const truncated = specContent.substring(0, MAX)
  const lastHeading = truncated.lastIndexOf('\n## ')
  if (lastHeading > MAX * 0.5) {
    return truncated.substring(0, lastHeading) + '\n\n[... truncated — call read_spec for full content]'
  }
  return truncated + '\n\n[... truncated]'
}

/**
 * Load full session conversation history into the realtime model's ChatContext.
 * This gives the model persistent memory of what was discussed/researched,
 * enabling deeper follow-up conversations without re-delegating to ask_agent.
 *
 * NOTE: Gemini's Live API doesn't support updateChatCtx (crashes with code 1008).
 * For Gemini, the session resume context is already injected via generateReply({ userInput })
 * which becomes part of the conversation history as model turns.
 */
function loadSessionHistoryIntoChatCtx(
  agent: voice.Agent | null,
  history: ConversationExchange[],
  provider?: string
) {
  if (!agent || history.length === 0) return
  // Skip for Gemini — updateChatCtx triggers unsupported operations on Gemini Live API
  if (provider === 'gemini') {
    console.log(`🧠 Skipping ChatCtx load for Gemini (${history.length} exchanges) — context injected via generateReply`)
    return
  }

  try {
    const chatCtx = agent.chatCtx.copy()

    // Inject each conversation exchange as a proper chat message
    for (const exchange of history) {
      chatCtx.addMessage({
        role: exchange.role === 'user' ? 'user' : 'assistant',
        content: exchange.content,
      })
    }

    agent.updateChatCtx(chatCtx)
    console.log(`🧠 Loaded ${history.length} conversation exchanges into ChatCtx (${history.reduce((sum, e) => sum + e.content.length, 0)} chars)`)
  } catch (err) {
    console.log('⚠️ Failed to load session history into ChatCtx:', err)
  }
}


// Main function
async function main() {
  console.log('\n🤖 Osborn Voice AI Coding Assistant\n')

  // Validate environment
  const livekitUrl = process.env.LIVEKIT_URL
  const apiKey = process.env.LIVEKIT_API_KEY
  const apiSecret = process.env.LIVEKIT_API_SECRET

  if (!livekitUrl || !apiKey || !apiSecret) {
    console.error('❌ Missing required environment variables:')
    if (!livekitUrl) console.error('   - LIVEKIT_URL')
    if (!apiKey) console.error('   - LIVEKIT_API_KEY')
    if (!apiSecret) console.error('   - LIVEKIT_API_SECRET')
    console.error('\nSet these in your .env file or environment.')
    process.exit(1)
  }

  // Parse CLI args
  const cliArgs = parseArgs()

  // Load configuration
  console.log('📁 Loading configuration...')
  const config = loadConfig()
  const mcpServers = getMcpServers(config)
  const enabledMcpNames = getEnabledMcpServerNames(config)

  if (enabledMcpNames.length > 0) {
    console.log(`🔌 Enabled MCP servers: ${enabledMcpNames.join(', ')}`)
  }

  const workingDir = config.workingDirectory || process.cwd()
  console.log(`📂 Working directory: ${workingDir}`)
  console.log(`🔬 Mode: RESEARCH`)

  // Determine voice mode
  const voiceMode = getVoiceMode(config)
  const realtimeConfig = getRealtimeConfig(config)
  const directConfig = getDirectConfig(config)

  if (voiceMode === 'realtime') {
    console.log(`🎙️ REALTIME MODE: ${realtimeConfig.provider} native speech-to-speech`)
    console.log(`   Voice: ${realtimeConfig.provider === 'openai' ? realtimeConfig.openaiVoice : realtimeConfig.geminiVoice}`)
  } else {
    console.log(`🎯 DIRECT MODE: ${directConfig.stt.provider} STT → Claude Agent SDK → ${directConfig.tts.provider} TTS`)
    console.log('   🔥 Full coding capabilities!')
  }

  // Determine room code
  const roomCode = cliArgs.roomCode || generateRoomCode()
  const roomName = `osborn-${roomCode}`

  if (cliArgs.roomCode) {
    console.log(`🔗 Joining room: ${roomCode}`)
  } else {
    console.log(`\n✨ Created new room: ${roomCode}`)
    console.log(`\n📋 Share this with the frontend or run:`)
    console.log(`   Open: https://osborn.app?room=${roomCode}`)
    console.log(`   Or enter code "${roomCode}" in the frontend\n`)
  }

  // Start HTTP API server for frontend session browsing
  const apiPort = parseInt(process.env.OSBORN_API_PORT || '8741', 10)
  startApiServer(workingDir, apiPort)

  // ============================================================
  // Create Access Token for Agent
  // ============================================================
  console.log('🔑 Creating access token...')

  const token = new AccessToken(apiKey, apiSecret, {
    identity: 'osborn-agent',
    name: 'Osborn AI',
    metadata: JSON.stringify({ type: 'agent', version: '0.3.0' }),
  })

  token.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  })

  const jwt = await token.toJwt()

  // ============================================================
  // Connect to Room
  // ============================================================
  console.log('📡 Connecting to LiveKit...')

  const room = new Room()
  room.setMaxListeners(50)  // Prevent MaxListenersExceeded warnings on reconnect

  // Track state
  let currentSession: voice.AgentSession | null = null
  let currentAgent: voice.Agent | null = null  // For updateChatCtx() context injection
  let currentLLM: ReturnType<typeof createClaudeLLM> | null = null
  let localParticipant: LocalParticipant | null = null
  let agentState = 'initializing'
  let userState = 'listening'  // Track user speech state for queue safety
  let currentVoiceMode: VoiceMode = voiceMode  // Track active voice mode for data handlers
  let currentProvider: string = realtimeConfig.provider  // Track active realtime provider

  // Task deduplication guard - prevents Gemini re-execution loops
  let lastTaskRequest = ''
  let lastTaskTime = 0

  // Fast brain (ask_haiku) in-flight tracking — prevents ask_agent double-calling
  let haikuInFlight: { question: string, time: number } | null = null

  // Background research state - tracks async ask_agent execution
  let activeResearch: {
    researchLog: string[]
    pendingUpdates: string[] // Queue of updates waiting to be injected
    cleanup: () => void
    voiceUpdateCount: number // Track voice injection count (no cap — 8s debounce prevents flooding)
  } | null = null

  // No manual queuing — the Claude SDK handles sequential queries internally

  // ============================================================
  // Unified Voice Injection Queue
  // ============================================================
  // ALL system injections (research updates, completions, notifications, errors)
  // go through this queue. Never call generateReply directly for injections.
  // The queue only drains when the voice model is confirmed 'listening'.
  // After draining, the model transitions to thinking/speaking, and the queue
  // naturally pauses until the next 'listening' state.

  const voiceQueue: string[] = []
  let isProcessingQueue = false

  function queueVoiceInjection(instructions: string) {
    voiceQueue.push(instructions)
    console.log(`📥 Voice queue: +1 (total: ${voiceQueue.length}): ${instructions.substring(0, 80)}...`)
    processVoiceQueue()
  }

  function processVoiceQueue() {
    if (voiceQueue.length === 0) return
    if (!currentSession) return
    if (isProcessingQueue) {
      console.log(`⏸️ Voice queue: already processing, ${voiceQueue.length} items waiting`)
      return
    }
    if (agentState !== 'listening') {
      console.log(`⏸️ Voice queue: ${voiceQueue.length} items waiting (model: ${agentState})`)
      return // Will be called again when agent_state_changed → 'listening'
    }
    // Don't inject while user is speaking — server-side VAD will auto-create a response
    if (userState === 'speaking') {
      console.log(`⏸️ Voice queue: ${voiceQueue.length} items waiting (user speaking)`)
      return
    }

    isProcessingQueue = true

    // Safety timeout: if agent_state_changed never fires (e.g. Gemini state machine hang),
    // clear the guard after 30s so the queue isn't permanently stuck
    setTimeout(() => {
      if (isProcessingQueue) {
        console.log('⚠️ Voice queue: isProcessingQueue stuck for 30s, clearing')
        isProcessingQueue = false
        if (voiceQueue.length > 0 && agentState === 'listening') {
          processVoiceQueue()
        }
      }
    }, 30000)

    // Batch ALL queued items into one generateReply call
    const items = voiceQueue.splice(0)
    const batchedInstruction = items.length === 1
      ? items[0]
      : items.join('\n\n---\n\n')

    console.log(`📡 Voice queue: processing ${items.length} batched items (${batchedInstruction.length} chars)`)

    try {
      // Skip interrupt for Gemini — disrupts Gemini's state machine, causing it to
      // never transition back to 'listening' (hangs in speaking state indefinitely)
      if (currentProvider !== 'gemini') {
        currentSession.interrupt()
      }

      currentSession.generateReply({
        instructions: batchedInstruction,
        toolChoice: 'none' as any,
      })
      // Model transitions to thinking/speaking after this call.
      // When it returns to 'listening', agent_state_changed triggers processVoiceQueue() again.

      // Also inject into chatCtx as persistent context so the model remembers across turns
      injectIntoChatCtx(batchedInstruction)
    } catch (err) {
      console.log('⚠️ Voice queue generateReply failed, dropping items:', err)
      // Do NOT re-queue — re-queuing causes infinite retry cascades
      // The frontend still has the updates via claude_output events
      isProcessingQueue = false
    }
    // isProcessingQueue is cleared when agent_state_changed fires
  }

  // Inject content into the agent's ChatContext as persistent memory
  // This ensures the realtime model can reference prior research in follow-up questions
  // NOTE: Gemini doesn't support updateChatCtx (crashes with "Operation not implemented" code 1008).
  // For Gemini, generateReply({ instructions }) already injects as model turns, so context persists naturally.
  function injectIntoChatCtx(content: string) {
    if (!currentAgent) return
    // Skip for Gemini — updateChatCtx triggers unsupported operations on Gemini Live API
    if (currentVoiceMode === 'realtime' && currentProvider === 'gemini') return
    try {
      const chatCtx = currentAgent.chatCtx.copy()
      chatCtx.addMessage({
        role: 'assistant',
        content: content,
      })
      currentAgent.updateChatCtx(chatCtx)
      console.log(`🧠 ChatCtx updated (+${content.length} chars persistent context)`)
    } catch (err) {
      console.log('⚠️ ChatCtx injection failed:', err)
    }
  }

  // Research event batching — debounce rapid-fire tool events into a single voice queue entry
  let researchBatchTimer: ReturnType<typeof setTimeout> | null = null

  function scheduleResearchBatch() {
    if (researchBatchTimer) return // Already scheduled
    researchBatchTimer = setTimeout(() => {
      researchBatchTimer = null
      if (!activeResearch || activeResearch.pendingUpdates.length === 0) return

      const updates = activeResearch.pendingUpdates.splice(0)
      const batchText = updates.slice(-10).join('. ')
      console.log(`📡 [research] Batching ${updates.length} events: ${batchText.substring(0, 80)}...`)

      // Send to frontend for visibility
      sendToFrontend({
        type: 'claude_output',
        text: `[Research Progress] ${batchText}`,
        isStreaming: true,
        agentRole: 'research-progress',
      })

      // Push to unified voice queue (will be spoken when model is available)
      queueVoiceInjection(getResearchUpdateInjection(batchText))
    }, 8000) // 8s debounce: reduces voice queue flooding during research
  }

  // Helper to send data to frontend (with size limit handling)
  const MAX_MESSAGE_SIZE = 60000

  async function sendToFrontend(data: object) {
    if (!localParticipant) {
      console.log('⚠️ sendToFrontend: no localParticipant!')
      return
    }
    try {
      const encoder = new TextEncoder()
      let jsonData = JSON.stringify(data)

      // If message is too large, truncate the text content
      if (jsonData.length > MAX_MESSAGE_SIZE) {
        const truncatedData = { ...data } as any
        if (truncatedData.text && typeof truncatedData.text === 'string') {
          const overhead = JSON.stringify({ ...truncatedData, text: '' }).length
          const maxTextLength = MAX_MESSAGE_SIZE - overhead - 100
          truncatedData.text = truncatedData.text.substring(0, maxTextLength) + '\n\n[Message truncated due to size limit]'
          jsonData = JSON.stringify(truncatedData)
          console.log(`⚠️ Message truncated from ${(data as any).text?.length} to ${truncatedData.text.length} chars`)
        }
      }

      const payload = encoder.encode(jsonData)
      await localParticipant.publishData(payload, {
        reliable: true,
        topic: 'osborn-updates',
      })
      console.log(`📤 Sent to frontend: ${(data as any).type} (${payload.length} bytes)`)
    } catch (err) {
      console.error('❌ sendToFrontend error:', err)
    }
  }

  // Helper: announce via voice - uses voice queue for realtime, say() for direct
  async function announceViaVoice(text: string) {
    if (!currentSession) return
    if (currentVoiceMode === 'realtime') {
      queueVoiceInjection(getNotificationInjection(text))
    } else {
      try {
        await (currentSession as any).say(text)
      } catch (err) {
        console.log('⚠️ Voice announcement failed:', err)
      }
    }
  }

  // Create DIRECT session (STT + Claude Agent SDK + TTS)
  async function createDirectSession(resumeSessionId?: string): Promise<{ session: voice.AgentSession; agent: voice.Agent }> {
    console.log('🎯 Creating direct session...')

    const stt = createSTT({ provider: 'deepgram' })
    const tts = createTTS({ provider: 'deepgram', voice: 'aura-asteria-en' })
    const vad = await createVAD()

    // Create Claude LLM wrapper in research mode
    const directLLM = createClaudeLLM({
      workingDirectory: workingDir,
      mcpServers,
      resumeSessionId,
    })
    currentLLM = directLLM

    // For resumed sessions, eagerly create workspace (we know the real ID)
    if (resumeSessionId) {
      const workspace = ensureSessionWorkspace(workingDir, resumeSessionId)
      console.log(`📁 Session workspace (resumed): ${workspace}`)
    }

    // For new sessions, create workspace when SDK assigns real session ID
    directLLM.events.once('session_id', ({ sessionId }: { sessionId: string }) => {
      const workspace = ensureSessionWorkspace(workingDir, sessionId)
      console.log(`📁 Session workspace created: ${workspace}`)
    })

    // Wire up MCP server changes to frontend
    directLLM.events.on('mcp_servers_changed', (data) => {
      console.log(`🔌 MCP servers changed: ${data.enabledKeys.join(', ') || 'none'}`)
      sendToFrontend({
        type: 'mcp_servers_changed',
        enabledKeys: data.enabledKeys,
        mcpServers: getMcpServerStatusList(config),
      })
    })

    // Wire up events from the Claude SDK wrapper to frontend
    directLLM.events.on('tool_use', (data) => {
      console.log(`🔧 Claude: ${data.name}`)
      sendToFrontend({ type: 'tool_use', tool: data.name, agentRole: 'direct' })
    })

    directLLM.events.on('tool_result', (data) => {
      console.log(`✅ Done: ${data.name}`)
      sendToFrontend({ type: 'tool_use', tool: data.name, status: 'completed', agentRole: 'direct' })

      // Detect research artifact writes (session workspace or legacy research dir)
      if ((data.name === 'Write' || data.name === 'Edit') && data.input?.file_path) {
        const fp = data.input.file_path
        if (fp.includes('.osborn/sessions/') || fp.includes('.osborn/research/')) {
          sendToFrontend({
            type: 'research_artifact_updated',
            filePath: fp,
            fileName: fp.split('/').pop(),
          })
        }
      }
    })

    // Wire up Claude text output - RAW text goes to frontend for chat bubbles
    directLLM.events.on('assistant_text', (data) => {
      console.log(`💬 Claude text: ${data.text?.substring(0, 60)}...`)
      sendToFrontend({
        type: 'claude_output',
        text: data.text,
        isStreaming: true,
        agentRole: 'direct',
      })
    })

    // Wire up Claude final result - RAW result goes to frontend
    directLLM.events.on('assistant_result', (data) => {
      console.log(`📋 Claude result: ${data.text?.substring(0, 60)}...`)
      sendToFrontend({
        type: 'claude_output',
        text: data.text,
        isStreaming: false,
        isFinal: true,
        agentRole: 'direct',
      })
    })

    // Wire up permission requests - sends to frontend for user approval
    directLLM.events.on('permission_request', (data) => {
      console.log(`⚠️ Permission needed: ${data.toolName}`)
      const toolName = data.toolName
      const input = data.input || {}

      // Build descriptive message based on tool type
      let description = `I need permission to use ${toolName}.`
      if (toolName === 'Bash' && input.command) {
        const cmd = String(input.command).substring(0, 60)
        description = `I want to run the command: ${cmd}${String(input.command).length > 60 ? '...' : ''}`
      } else if (toolName === 'Write' && input.file_path) {
        description = `I want to create or overwrite the file: ${input.file_path}`
      } else if (toolName === 'Edit' && input.file_path) {
        description = `I want to edit the file: ${input.file_path}`
      } else if (toolName === 'WebFetch' && input.url) {
        description = `I want to fetch content from: ${input.url}`
      }

      sendToFrontend({
        type: 'permission_request',
        toolName: data.toolName,
        input: data.input,
        description,
        agentRole: 'direct',
      })
      // Speak the descriptive request so user knows to respond
      if (currentSession) {
        const ttsMessage = `${description} Say yes, no, or always.`
        ;(currentSession as any).say?.(ttsMessage).catch(() => {})
      }
    })

    // Wire up session resume failure - notify frontend when SDK creates new session instead
    directLLM.events.on('session_resume_failed', (data) => {
      console.error(`❌ Session resume failed: ${data.requestedSessionId} → ${data.actualSessionId}`)
      sendToFrontend({
        type: 'session_resume_failed',
        requestedSessionId: data.requestedSessionId,
        actualSessionId: data.actualSessionId,
      })
    })

    // Wire up file checkpoint capture - track restore points for file rewind
    directLLM.events.on('checkpoint_captured', (data) => {
      console.log(`📍 Checkpoint: ${data.checkpointId.substring(0, 8)}...`)
      sendToFrontend({
        type: 'checkpoint_captured',
        checkpointId: data.checkpointId,
      })
    })

    // Create the Agent with instructions, STT, LLM, TTS
    const agent = new voice.Agent({
      instructions: DIRECT_MODE_PROMPT,
      stt,
      llm: directLLM,
      tts,
      vad,
      turnDetection: 'vad',
    })

    // Create the session (no longer passes STT/LLM/TTS here)
    const session = new voice.AgentSession({
      turnDetection: 'vad',
    })

    return { session, agent }
  }

  // ============================================================
  // REALTIME MODE - OpenAI/Gemini native speech-to-speech
  // ============================================================

  // Claude handler for realtime mode tool execution
  let realtimeClaudeHandler: ReturnType<typeof createClaudeLLM> | null = null

  // Create REALTIME session (OpenAI/Gemini native speech-to-speech)
  async function createRealtimeSession(sessionRealtimeConfig?: typeof realtimeConfig, resumeSessionId?: string): Promise<{ session: voice.AgentSession; agent: voice.Agent }> {
    const rtConfig = sessionRealtimeConfig || realtimeConfig
    console.log(`🎯 Creating realtime session (${rtConfig.provider})...`)

    // Create Claude LLM for tool execution (research tasks)
    realtimeClaudeHandler = createClaudeLLM({
      workingDirectory: workingDir,
      mcpServers,
      resumeSessionId,
    })
    currentLLM = realtimeClaudeHandler

    // For resumed sessions, eagerly create workspace (we know the real ID)
    if (resumeSessionId) {
      const workspace = ensureSessionWorkspace(workingDir, resumeSessionId)
      console.log(`📁 Session workspace (resumed): ${workspace}`)
    }

    // For new sessions, create workspace when SDK assigns real session ID
    realtimeClaudeHandler.events.once('session_id', ({ sessionId }: { sessionId: string }) => {
      const workspace = ensureSessionWorkspace(workingDir, sessionId)
      console.log(`📁 Session workspace created: ${workspace}`)
    })

    // Wire up MCP server changes to frontend
    realtimeClaudeHandler.events.on('mcp_servers_changed', (data) => {
      console.log(`🔌 MCP servers changed: ${data.enabledKeys.join(', ') || 'none'}`)
      sendToFrontend({
        type: 'mcp_servers_changed',
        enabledKeys: data.enabledKeys,
        mcpServers: getMcpServerStatusList(config),
      })
    })

    // Wire up Claude events to frontend
    realtimeClaudeHandler.events.on('tool_use', (data) => {
      console.log(`🔧 Claude: ${data.name}`)
      sendToFrontend({ type: 'tool_use', tool: data.name, agentRole: 'realtime' })
    })

    realtimeClaudeHandler.events.on('tool_result', (data) => {
      console.log(`✅ Done: ${data.name}`)
      sendToFrontend({ type: 'tool_use', tool: data.name, status: 'completed', agentRole: 'realtime' })

      // Detect research artifact writes (session workspace or legacy research dir)
      if ((data.name === 'Write' || data.name === 'Edit') && data.input?.file_path) {
        const fp = data.input.file_path
        if (fp.includes('.osborn/sessions/') || fp.includes('.osborn/research/')) {
          sendToFrontend({
            type: 'research_artifact_updated',
            filePath: fp,
            fileName: fp.split('/').pop(),
          })
        }
      }
    })

    realtimeClaudeHandler.events.on('assistant_result', (data) => {
      console.log(`📋 Claude result: ${data.text?.substring(0, 60)}...`)
      sendToFrontend({
        type: 'claude_output',
        text: data.text,
        isStreaming: false,
        isFinal: true,
        agentRole: 'realtime',
      })
    })

    // Stream Claude's research text to frontend as progress updates
    realtimeClaudeHandler.events.on('assistant_text', (data) => {
      if (data.text && data.text.trim()) {
        sendToFrontend({
          type: 'claude_output',
          text: data.text,
          isStreaming: true,
          agentRole: 'realtime-agent',
        })
      }
    })

    realtimeClaudeHandler.events.on('permission_request', (data) => {
      console.log(`⚠️ Permission needed: ${data.toolName}`)
      const toolName = data.toolName
      const input = data.input || {}

      // Build descriptive message based on tool type
      let description = `I need permission to use ${toolName}.`
      if (toolName === 'Bash' && input.command) {
        const cmd = String(input.command).substring(0, 60)
        description = `I want to run the command: ${cmd}${String(input.command).length > 60 ? '...' : ''}`
      } else if (toolName === 'Write' && input.file_path) {
        description = `I want to create or overwrite the file: ${input.file_path}`
      } else if (toolName === 'Edit' && input.file_path) {
        description = `I want to edit the file: ${input.file_path}`
      } else if (toolName === 'WebFetch' && input.url) {
        description = `I want to fetch content from: ${input.url}`
      }

      sendToFrontend({
        type: 'permission_request',
        toolName: data.toolName,
        input: data.input,
        description,
        agentRole: 'realtime',
      })
    })

    // Wire up session resume failure for realtime mode
    realtimeClaudeHandler.events.on('session_resume_failed', (data) => {
      console.error(`❌ Session resume failed: ${data.requestedSessionId} → ${data.actualSessionId}`)
      sendToFrontend({
        type: 'session_resume_failed',
        requestedSessionId: data.requestedSessionId,
        actualSessionId: data.actualSessionId,
      })
    })

    // Wire up file checkpoint capture for realtime mode
    realtimeClaudeHandler.events.on('checkpoint_captured', (data) => {
      console.log(`📍 Checkpoint: ${data.checkpointId.substring(0, 8)}...`)
      sendToFrontend({
        type: 'checkpoint_captured',
        checkpointId: data.checkpointId,
      })
    })

    // Extract priority content from research results — preserves URLs, code blocks, and key details
    function extractPriorityContent(result: string, maxChars: number = 4000): string {
      if (result.length <= maxChars) return result

      // Extract URLs (preserve for voice relay)
      const urlRegex = /https?:\/\/[^\s\)\"\'>\]]+/g
      const urls = [...new Set(result.match(urlRegex) || [])]

      // Extract code blocks (first 2, up to 400 chars each)
      const codeBlockRegex = /```[\s\S]*?```/g
      const codeBlocks: string[] = []
      let match
      while ((match = codeBlockRegex.exec(result)) !== null && codeBlocks.length < 2) {
        const block = match[0].length > 400 ? match[0].substring(0, 397) + '```' : match[0]
        codeBlocks.push(block)
      }

      // Build sections
      const sections: string[] = []

      // Take the first ~2500 chars of narrative (intro + main findings)
      const narrativeEnd = Math.min(result.length, 2500)
      const narrativeTruncated = result.substring(0, narrativeEnd)
      const lastPeriod = narrativeTruncated.lastIndexOf('.')
      const narrative = lastPeriod > narrativeEnd * 0.6
        ? narrativeTruncated.substring(0, lastPeriod + 1)
        : narrativeTruncated
      sections.push(narrative)

      // Append conclusion (last ~500 chars) if result is long enough
      if (result.length > 3000) {
        const tail = result.substring(result.length - 500)
        const firstPeriod = tail.indexOf('.')
        const conclusion = firstPeriod > 0 ? tail.substring(firstPeriod + 1).trim() : tail.trim()
        if (conclusion.length > 50) {
          sections.push(`\n\n[CONCLUSION]\n${conclusion}`)
        }
      }

      // Append code blocks if not already in the narrative
      if (codeBlocks.length > 0) {
        const codeSection = codeBlocks.filter(cb => !narrative.includes(cb))
        if (codeSection.length > 0) {
          sections.push(`\n\n[CODE EXAMPLES]\n${codeSection.join('\n\n')}`)
        }
      }

      // Append URLs if not already in the narrative
      const newUrls = urls.filter(u => !narrative.includes(u))
      if (newUrls.length > 0) {
        sections.push(`\n\n[LINKS]\n${newUrls.slice(0, 5).join('\n')}`)
      }

      let assembled = sections.join('')

      // Final safety truncation if assembled exceeds maxChars
      if (assembled.length > maxChars) {
        const truncated = assembled.substring(0, maxChars)
        const lp = truncated.lastIndexOf('.')
        assembled = lp > maxChars * 0.7 ? truncated.substring(0, lp + 1) : truncated + '...'
      }

      return assembled
    }

    // Extracted research execution — called by ask_agent, SDK handles queuing internally
    function executeResearch(task: string): string {
      sendToFrontend({ type: 'system', text: `Executing: ${task}` })

      // Clean up previous research listeners to avoid duplicate event handlers
      if (activeResearch) {
        activeResearch.cleanup()
        if (researchBatchTimer) { clearTimeout(researchBatchTimer); researchBatchTimer = null }
      }

      // Set up research log batching — events push to queue for state-driven injection
      const researchLog: string[] = []
      const pendingUpdates: string[] = []
      const onToolUse = (data: any) => {
        const input = data.input || {}
        let entry: string

        if (data.name === 'Read' && input.file_path) {
          const fileName = input.file_path.split('/').pop() || input.file_path
          entry = `Reading ${fileName}`
        } else if (data.name === 'Bash' && input.command) {
          const cmd = input.command.substring(0, 80)
          entry = `Running: ${cmd}`
        } else if (data.name === 'Glob' && input.pattern) {
          entry = `Searching for files matching ${input.pattern}`
        } else if (data.name === 'Grep' && input.pattern) {
          entry = `Searching for "${input.pattern}" in files`
        } else if (data.name === 'WebSearch' && input.query) {
          entry = `Searching the web for "${input.query}"`
        } else if (data.name === 'WebFetch' && input.url) {
          const hostname = input.url.replace(/https?:\/\//, '').split('/')[0]
          entry = `Fetching content from ${hostname}`
        } else if (data.name === 'Write' && input.file_path) {
          const fileName = input.file_path.split('/').pop() || input.file_path
          entry = `Writing ${fileName}`
        } else if (data.name === 'Edit' && input.file_path) {
          const fileName = input.file_path.split('/').pop() || input.file_path
          entry = `Editing ${fileName}`
        } else if (data.name.startsWith('mcp__')) {
          const parts = data.name.split('__')
          const serverName = parts[1] || 'external'
          const toolAction = parts.slice(2).join(' ') || 'tool'
          entry = `Using ${serverName}: ${toolAction}`
        } else {
          entry = `Using ${data.name}`
        }

        researchLog.push(entry)
        pendingUpdates.push(entry)
        scheduleResearchBatch()
      }
      const onToolResult = (data: any) => {
        // Only log to researchLog for the final summary — don't push to pendingUpdates
        // This prevents redundant "Reading config.ts. Read done." voice updates
        researchLog.push(`${data.name} completed`)
        // Content is NOT captured here — JSONL has full untruncated tool results
        // The fast brain reads JSONL directly on completion via updateSpecFromJSONL()
      }
      const onText = (data: any) => {
        if (data.text?.trim()) {
          const text = data.text.trim()
          const preview = text.substring(0, 150)
          const firstSentence = preview.match(/^[^.!?\n]+[.!?]/)?.[0] || preview
          researchLog.push(firstSentence)
          pendingUpdates.push(firstSentence)
          scheduleResearchBatch()
          // Agent reasoning/analysis text is NOT captured here
          // JSONL has full untruncated assistant text — read on completion
        }
      }
      realtimeClaudeHandler!.events.on('tool_use', onToolUse)
      realtimeClaudeHandler!.events.on('tool_result', onToolResult)
      realtimeClaudeHandler!.events.on('assistant_text', onText)

      const cleanupListeners = () => {
        realtimeClaudeHandler?.events.off('tool_use', onToolUse)
        realtimeClaudeHandler?.events.off('tool_result', onToolResult)
        realtimeClaudeHandler?.events.off('assistant_text', onText)
      }

      // Track active research — updates drain when model enters 'listening' state
      activeResearch = {
        researchLog,
        pendingUpdates,
        cleanup: cleanupListeners,
        voiceUpdateCount: 0,
      }

      // Run research in the background (non-blocking)
      const researchPromise = (async () => {
        const stream = realtimeClaudeHandler!.chat({
          chatCtx: {
            items: [{ type: 'message', role: 'user', content: [task] }],
          } as any,
        })

        let result = ''
        for await (const chunk of stream) {
          if (chunk.delta?.content) {
            result += chunk.delta.content
          }
        }
        return result
      })()

      // Handle completion asynchronously
      researchPromise.then(async (result) => {
        console.log(`✅ [realtime] Research complete (${result.length} chars)`)

        // Clean up
        cleanupListeners()

        // Send to frontend
        await sendToFrontend({ type: 'assistant_response', text: result })
        const resultPreview = result.length > 150
          ? result.substring(0, 150) + '...'
          : result
        await sendToFrontend({ type: 'task_completed', task, resultPreview })

        // Build enhanced return with research log
        const logSummary = researchLog.length > 0
          ? `\n\n[RESEARCH LOG]\n${researchLog.slice(0, 25).join('\n')}`
          : ''

        // Extract priority content — preserves URLs, code blocks, and key details (4000 char limit)
        const resultForVoice = extractPriorityContent(result)

        const fullResult = (resultForVoice + logSummary) || 'Research completed successfully.'

        // Clear active research and timers before injecting final results
        if (researchBatchTimer) { clearTimeout(researchBatchTimer); researchBatchTimer = null }
        activeResearch = null

        // Send final results to frontend for visibility
        await sendToFrontend({
          type: 'claude_output',
          text: `[Research Complete] Injecting findings into voice model (${fullResult.length} chars)`,
          isStreaming: false,
          agentRole: 'research-progress',
        })

        // Queue final results for voice injection — the queue handles availability gating
        console.log(`📡 [realtime] Queuing final results (${fullResult.length} chars, agentState: ${agentState})`)
        queueVoiceInjection(getResearchCompleteInjection(task, fullResult))

        // Inject FULL untruncated result into ChatCtx so voice model can answer
        // follow-up questions ("tell me more", "what were those links?") from memory
        injectIntoChatCtx(`[FULL RESEARCH DETAILS for "${task}"]\n${result}`)

        // Fire-and-forget JSONL-based refinement pass via fast brain
        // Reads FULL untruncated data from JSONL — no content buffer, no truncation
        const postResearchSessionId = currentLLM?.sessionId || resumeSessionId
        if (postResearchSessionId) {
          updateSpecFromJSONL(workingDir, postResearchSessionId, task, researchLog)
            .then(updateResult => {
              if (!updateResult) return

              // Notify frontend about spec.md update
              if (updateResult.spec) {
                const specPath = `${workingDir}/.osborn/sessions/${postResearchSessionId}/spec.md`
                sendToFrontend({
                  type: 'research_artifact_updated',
                  filePath: specPath,
                  fileName: 'spec.md',
                })
                const truncated = getSpecForVoiceModel(workingDir, postResearchSessionId)
                if (truncated) {
                  injectIntoChatCtx(`[UPDATED SESSION SPEC]\n${truncated}`)
                  console.log(`📋 Re-injected spec.md into ChatCtx after fast brain update (${truncated.length} chars)`)
                }
              }

              // Notify frontend about each library file written by the fast brain
              for (const libFile of updateResult.libraryFiles) {
                const libPath = `${workingDir}/.osborn/sessions/${postResearchSessionId}/library/${libFile}`
                sendToFrontend({
                  type: 'research_artifact_updated',
                  filePath: libPath,
                  fileName: libFile,
                })
              }
            })
        }
      }).catch(async (err) => {
        console.error(`❌ [realtime] Research failed:`, err)

        // Clean up
        cleanupListeners()
        if (researchBatchTimer) { clearTimeout(researchBatchTimer); researchBatchTimer = null }
        activeResearch = null

        // Queue error notification — will be spoken when model is available
        queueVoiceInjection(`[NOTIFICATION] The research task encountered an error: ${(err as Error).message}. Let the user know briefly and ask if they want to try again. Do NOT call any tools.`)
      })

      // Return immediately to unblock the voice model
      return 'Research started. I\'ll relay findings as they come in — you can keep talking to the user while I work.'
    }

    // Create tools for the realtime voice LLM
    const askAgentTool = llm.tool({
      description: `Delegate a task to your backend agent (Claude), which has full research, analysis, reasoning, and coding capabilities.

Use for:
- Researching topics, technologies, concepts, or ideas in depth
- Fetching and analyzing web pages, articles, blog posts, YouTube transcripts
- Reading and summarizing documentation, papers, or reference materials
- Exploring and analyzing codebases, configs, architecture
- Comparing options, tools, approaches — with tradeoffs and recommendations
- Running bash commands, testing implementations
- Using MCP tools (GitHub, YouTube, and other external tools)
- Saving findings to the session library and updating the spec
- Any question requiring research, analysis, verification, or deeper reasoning

Reformulate the user's spoken request into a clear, specific task.
The more context you include (topic, constraints, what they want to learn), the better the results.
If the user wants specific details (examples, URLs, comparisons, step-by-step breakdown), mention that in your request.`,
      parameters: z.object({
        request: z.string().describe('The task or question to delegate to the agent'),
      }),
      execute: async ({ request: task }) => {
        console.log(`\n🔨 [realtime] Task: "${task}"`)

        // Guard: if ask_haiku is currently handling a similar question, skip ask_agent
        // This prevents the double-calling pattern where Gemini fires both in rapid succession
        if (haikuInFlight && (Date.now() - haikuInFlight.time) < 8000) {
          console.log(`⏭️ Skipping ask_agent — ask_haiku is already handling: "${haikuInFlight.question.substring(0, 60)}"`)
          return 'The fast brain is already looking into this. Wait for its answer first.'
        }

        // Deduplication guard: prevent re-execution of same task within 10s
        const now = Date.now()
        if (task === lastTaskRequest && (now - lastTaskTime) < 10000) {
          console.log('⏭️ Skipping duplicate task (within 10s window)')
          return 'This task was just completed. The results were already relayed.'
        }
        lastTaskRequest = task
        lastTaskTime = now

        return executeResearch(task)
      },
    })

    const respondPermissionTool = llm.tool({
      description: `Respond to a permission request. Call after hearing user's response.`,
      parameters: z.object({
        response: z.enum(['allow', 'deny', 'always_allow']),
      }),
      execute: async ({ response }) => {
        if (!realtimeClaudeHandler?.hasPendingPermission()) {
          return 'No pending permission.'
        }
        const pending = realtimeClaudeHandler.getPendingPermission()
        const allow = response === 'allow' || response === 'always_allow'
        realtimeClaudeHandler.respondToPermission(allow)
        await sendToFrontend({ type: 'permission_response', response, toolName: pending?.toolName })
        return `Permission ${response} for ${pending?.toolName || 'tool'}.`
      },
    })

    const readSpecTool = llm.tool({
      description: `Read the session spec (spec.md) — shared state between you and your backend agent.
Use when: checking decisions, reading open questions to ask the user, understanding architecture/context, seeing what research has been saved. Updated by your backend agent during research.`,
      parameters: z.object({}),
      execute: async () => {
        const sessionId = currentLLM?.sessionId || resumeSessionId
        if (!sessionId) return 'No session spec yet — session is still initializing.'
        const specContent = readSessionSpec(workingDir, sessionId)
        if (!specContent) return 'Spec is empty — no research done yet.'
        const libraryFiles = listLibraryFiles(workingDir, sessionId)
        const libSection = libraryFiles.length > 0
          ? `\n\n[LIBRARY FILES: ${libraryFiles.join(', ')}]`
          : ''
        const MAX = 4000
        const content = specContent.length > MAX
          ? specContent.substring(0, MAX) + '\n\n[... truncated]'
          : specContent
        return content + libSection
      },
    })

    const askHaikuTool = llm.tool({
      description: `Ask your fast brain — a quick knowledge assistant with access to session files and web search (~2 seconds).

Use for:
- Questions answerable from the session spec or research library (much faster than ask_agent)
- Quick web lookups for simple factual questions (definitions, current versions, basic how-to)
- Recording user decisions: "User decided: [decision]. Update the spec."
- Recording user preferences: "User prefers: [preference]. Update the spec."
- Checking what research has been done on a topic
- Reading specific library files for details

Do NOT use for: deep research, code analysis, multi-file codebase exploration, complex investigations → use ask_agent.
If the fast brain responds with NEEDS_DEEPER_RESEARCH, tell the user you need to look deeper, then call ask_agent with the context it provides.`,
      parameters: z.object({
        question: z.string().describe('The question to ask or instruction to execute'),
      }),
      execute: async ({ question }) => {
        const sessionId = currentLLM?.sessionId || resumeSessionId
        if (!sessionId) return 'Session not ready yet. Try ask_agent instead.'
        console.log(`🧠 [fast brain] Question: "${question.substring(0, 80)}..."`)

        // Track in-flight state to prevent ask_agent double-calling
        haikuInFlight = { question, time: Date.now() }

        // Build live research context if the agent is actively researching
        // This is a READ of the existing researchLog array — safe, no race conditions
        let researchContext: string | undefined
        if (activeResearch && activeResearch.researchLog.length > 0) {
          const recentLog = activeResearch.researchLog.slice(-15)
          researchContext = `Research topic: "${lastTaskRequest || 'unknown'}"\nSteps completed (${activeResearch.researchLog.length} total, showing last ${recentLog.length}):\n${recentLog.join('\n')}`
        }

        try {
          const answer = await askHaiku(workingDir, sessionId, question, researchContext)
          haikuInFlight = null // Clear in-flight state
          console.log(`🧠 [fast brain] Answer (${answer.length} chars)`)

          // Notify frontend if the fast brain likely wrote to spec.md
          // (fast brain writes bypass the SDK tool system, so no tool_result event fires)
          if (answer.includes('Written: spec.md') || question.toLowerCase().includes('update the spec') || question.toLowerCase().includes('user decided') || question.toLowerCase().includes('user prefers')) {
            const specPath = `${workingDir}/.osborn/sessions/${sessionId}/spec.md`
            sendToFrontend({
              type: 'research_artifact_updated',
              filePath: specPath,
              fileName: 'spec.md',
            })
          }

          // If research is active and this was a user decision/direction,
          // also queue it for the agent SDK so it picks up the context
          // when its queue reaches the next query
          if (activeResearch && (
            question.toLowerCase().includes('user decided') ||
            question.toLowerCase().includes('user prefers') ||
            question.toLowerCase().includes('update the spec') ||
            question.toLowerCase().includes('also check') ||
            question.toLowerCase().includes('focus on') ||
            question.toLowerCase().includes('redirect')
          )) {
            console.log(`📨 [fast brain] Passing user direction to agent SDK queue: "${question.substring(0, 60)}..."`)
            // Queue as a lightweight context update — agent reads spec.md
            // at the start of its next query and will see the updated direction
            executeResearch(`[USER DIRECTION during active research] ${question}. The user's spec.md has been updated with this. Acknowledge briefly and incorporate into your current research context.`)
          }

          return answer
        } catch (err) {
          haikuInFlight = null // Clear in-flight state on error
          console.error('❌ Fast brain failed:', err)
          return 'Fast brain lookup failed. Try ask_agent for a deeper search.'
        }
      },
    })

    // Instructions for realtime voice LLM
    const realtimeInstructions = getRealtimeInstructions(workingDir)

    // Create realtime model
    const realtimeModel = createRealtimeModelFromConfig(rtConfig, realtimeInstructions)

    // Create the Agent with realtime model and tools
    const agent = new voice.Agent({
      instructions: realtimeInstructions,
      llm: realtimeModel,
      tools: {
        ask_agent: askAgentTool,
        ask_haiku: askHaikuTool,
        read_spec: readSpecTool,
        respond_permission: respondPermissionTool,
      },
    })

    // Create the session
    const session = new voice.AgentSession({})

    return { session, agent }
  }

  // ============================================================
  // Room Event Handlers
  // ============================================================

  room.on(RoomEvent.Connected, () => {
    console.log('✅ Connected to room:', roomName)
    localParticipant = room.localParticipant
  })

  room.on(RoomEvent.Disconnected, () => {
    console.log('👋 Disconnected from room')
    // Clean up active research and voice queue
    voiceQueue.length = 0
    isProcessingQueue = false
    if (researchBatchTimer) { clearTimeout(researchBatchTimer); researchBatchTimer = null }
    if (activeResearch) {
      activeResearch.cleanup()
      activeResearch = null
    }
    currentSession = null
    currentAgent = null
    currentLLM = null
  })

  room.on(RoomEvent.ParticipantConnected, async (participant: RemoteParticipant) => {
    console.log(`\n👤 User joined: ${participant.identity}`)

    // Clean up any existing session before creating a new one
    voiceQueue.length = 0
    isProcessingQueue = false
    if (researchBatchTimer) { clearTimeout(researchBatchTimer); researchBatchTimer = null }
    if (activeResearch) {
      activeResearch.cleanup()
      activeResearch = null
    }
    if (currentSession) {
      console.log('🧹 Cleaning up previous session...')
      try {
        await currentSession.close()
      } catch {}
      try {
        currentSession.removeAllListeners()
      } catch {}
      currentSession = null
      currentAgent = null
      currentLLM = null
    }

    // Extract voice architecture, provider, and sessionId from participant metadata (sent by frontend)
    // This overrides the config file setting for per-session flexibility
    let sessionVoiceMode: VoiceMode = voiceMode  // Default to config
    let sessionRealtimeProvider: 'gemini' | 'openai' = realtimeConfig.provider  // Default to config
    let preSelectedSessionId: string | null = null
    try {
      const metadata = JSON.parse(participant.metadata || '{}')
      console.log(`📋 Participant metadata:`, metadata)
      if (metadata.voiceArch === 'realtime' || metadata.voiceArch === 'direct') {
        sessionVoiceMode = metadata.voiceArch
        console.log(`🎙️ Using voice mode from frontend: ${sessionVoiceMode}`)
      } else if (metadata.voiceArch) {
        console.log(`⚠️ Unknown voiceArch "${metadata.voiceArch}", using config: ${voiceMode}`)
      }
      // Read provider selection from frontend (openai or gemini)
      if (metadata.provider === 'openai' || metadata.provider === 'gemini') {
        sessionRealtimeProvider = metadata.provider
        console.log(`🎙️ Using provider from frontend: ${sessionRealtimeProvider}`)
      }
      // Read pre-selected session ID from frontend (session browser selection)
      if (metadata.sessionId && typeof metadata.sessionId === 'string' && metadata.sessionId.length > 0) {
        preSelectedSessionId = metadata.sessionId
        console.log(`📂 Pre-selected session from frontend: ${preSelectedSessionId}`)
      }
    } catch (err) {
      console.log('⚠️ Could not parse participant metadata, using config voiceMode:', voiceMode)
    }

    // Sync to outer scope so DataReceived handler can use it
    currentVoiceMode = sessionVoiceMode
    currentProvider = sessionRealtimeProvider

    // Resume session ID — only set when resuming an existing session
    const resumeSessionId = preSelectedSessionId || undefined
    if (resumeSessionId) {
      console.log(`🆔 Resuming session: ${resumeSessionId}`)
    } else {
      console.log(`🆔 New session (ID assigned by SDK)`)
    }

    // Create session based on voice mode (from frontend or config)
    let session: voice.AgentSession
    let agent: voice.Agent

    if (sessionVoiceMode === 'realtime') {
      // Override the config provider with the frontend's selection
      const sessionRealtimeConfig = { ...realtimeConfig, provider: sessionRealtimeProvider }
      console.log(`🎙️ REALTIME MODE: ${sessionRealtimeConfig.provider} native speech-to-speech`)
      const result = await createRealtimeSession(sessionRealtimeConfig, resumeSessionId)
      session = result.session
      agent = result.agent
    } else {
      console.log(`🎯 DIRECT MODE: Claude Agent SDK with full coding capabilities`)
      const result = await createDirectSession(resumeSessionId)
      session = result.session
      agent = result.agent
    }
    currentSession = session
    currentAgent = agent  // Store for updateChatCtx() context injection

    // ============================================================
    // Session event wiring — extracted into function for auto-recovery
    // ============================================================
    let lastRecoveryTime = 0
    const MIN_RECOVERY_INTERVAL = 10000  // 10 seconds between recovery attempts

    function wireSessionEvents(sess: voice.AgentSession, agt: voice.Agent) {
      // Transcript dedup state (reset per wiring)
      let lastSentUserTranscript = ''
      let lastSentAgentTranscript = ''

      function sendUserTranscript(transcript: string, source: string) {
        if (!transcript || transcript.length < 3) return
        const normalized = transcript.trim().replace(/\s+/g, ' ')
        if (normalized === lastSentUserTranscript) return
        if (normalized === '<noise>' || normalized.toLowerCase() === 'thank you') return

        console.log(`📝 User (${source}): "${transcript.substring(0, 60)}..."`)
        sendToFrontend({ type: 'user_transcript', text: transcript })
        lastSentUserTranscript = normalized
      }

      function sendAgentTranscript(text: string, source: string) {
        if (!text || text.length < 3) return
        const normalized = text.trim().replace(/\s+/g, ' ')
        if (normalized === lastSentAgentTranscript) return

        console.log(`💬 Agent (${source}): "${text.substring(0, 60)}..."`)
        sendToFrontend({ type: 'assistant_response', text })
        lastSentAgentTranscript = normalized
      }

      // PRIMARY: conversation_item_added is the authoritative source
      sess.on('conversation_item_added' as any, (ev: any) => {
        let text = ''
        if (Array.isArray(ev.item?.content)) {
          text = typeof ev.item.content[0] === 'string'
            ? ev.item.content.join('\n')
            : ev.item.content.map((c: any) => c.text).filter(Boolean).join('\n')
        } else if (typeof ev.item?.content === 'string') {
          text = ev.item.content
        } else if (ev.item?.text) {
          text = ev.item.text
        }

        if (ev.item?.role === 'user' && text) {
          sendUserTranscript(text, 'conv_item')
        } else if (ev.item?.role === 'assistant' && text) {
          sendAgentTranscript(text, 'conv_item')
        }
      })

      // FALLBACK: user_speech_committed
      sess.on('user_speech_committed' as any, (ev: any) => {
        const transcript = ev.transcript || ev.text || ''
        sendUserTranscript(transcript, 'committed')
      })

      // Agent state tracking
      sess.on('agent_state_changed' as any, (ev: any) => {
        agentState = ev.newState
        // Clear processing guard when model transitions to any new state
        isProcessingQueue = false
        console.log(`🤖 State: ${ev.newState}`)
        sendToFrontend({ type: 'agent_state', state: ev.newState })

        // When the model becomes available (listening), process any queued voice injections
        if (ev.newState === 'listening' && voiceQueue.length > 0) {
          setTimeout(() => processVoiceQueue(), 500)  // 500ms to let model settle
        }
      })

      // User state tracking — prevents queue from colliding with server-side VAD
      sess.on('user_state_changed' as any, (ev: any) => {
        userState = ev.newState
        console.log(`👤 User state: ${ev.newState}`)
      })

      // FALLBACK: playout_completed
      sess.on('playout_completed' as any, (ev: any) => {
        const message = ev.message || ev.text || ev.content
        if (message && message.length > 0) {
          sendAgentTranscript(message, 'playout')
        }
      })

      // Error handler
      sess.on('error' as any, (ev: any) => {
        const msg = ev.error?.message || String(ev.error)
        // OpenAI race: voice queue collided with server-side VAD auto-response
        if (msg.includes('conversation_already_has_active_response') || msg.includes('active_response')) {
          console.log('⚠️ OpenAI active response collision — queue will retry on next listening state')
          return
        }
        console.error('❌ Session error:', ev.error)
      })

      // Close handler with auto-recovery for Gemini 1008 crashes
      sess.on('close' as any, async (ev: any) => {
        console.log('🚪 Session closed:', ev.reason)

        // Auto-recover from crashes in realtime mode
        if (ev.reason === 'error' && currentVoiceMode === 'realtime') {
          const now = Date.now()
          if (now - lastRecoveryTime < MIN_RECOVERY_INTERVAL) {
            console.log('⚠️ Recovery too frequent — skipping to prevent loop')
            sendToFrontend({ type: 'agent_state', state: 'error' })
            return
          }
          lastRecoveryTime = now

          console.log('🔄 Auto-recovering from session crash...')

          // Clean up dead session
          try { sess.removeAllListeners() } catch {}
          currentSession = null
          currentAgent = null

          // Clear voice queue — stale injections from the crashed session
          voiceQueue.length = 0
          isProcessingQueue = false
          if (researchBatchTimer) { clearTimeout(researchBatchTimer); researchBatchTimer = null }
                if (activeResearch) { activeResearch.cleanup(); activeResearch = null }

          try {
            const recoveryConfig = { ...realtimeConfig, provider: currentProvider as 'gemini' | 'openai' }
            // Reuse existing session ID for workspace continuity during recovery
            // Prefer real SDK session ID, fall back to original resume ID
            const recoverySessionId = currentLLM?.sessionId || resumeSessionId
            const result = await createRealtimeSession(recoveryConfig, recoverySessionId)
            const newSession = result.session
            const newAgent = result.agent
            currentSession = newSession
            currentAgent = newAgent

            // Re-wire event listeners on the new session
            wireSessionEvents(newSession, newAgent)

            await newSession.start({ agent: newAgent, room })

            // Sync state
            agentState = 'listening'
            sendToFrontend({ type: 'agent_state', state: 'listening' })

            // Resume Claude session if one was active
            if (currentLLM?.sessionId) {
              currentLLM.setContinueSession(true)
            }

            // Inject conversation context into the recovered session
            const recoveredSessionId = currentLLM?.sessionId || recoverySessionId
            if (recoveredSessionId) {
              try {
                const summary = await getSessionSummary(recoveredSessionId, workingDir)
                const conversationHistory = await getConversationHistory(recoveredSessionId, workingDir, 30)
                if (summary && conversationHistory.length > 0) {
                  const contextBriefing = buildContextBriefing(summary, conversationHistory, currentProvider)
                  queueVoiceInjection(`[SESSION RECOVERED] The voice session crashed and was auto-recovered. Here's the conversation context from before the crash:\n${contextBriefing}\n\nBriefly tell the user the connection was interrupted and you still have context from the conversation. Ask if they can hear you and what they'd like to continue with. Do NOT call any tools.`)
                  console.log('📋 Injected conversation context into recovered session')
                } else {
                  queueVoiceInjection('[NOTIFICATION] The voice session was briefly interrupted but has been recovered. Ask the user if they can hear you and continue where you left off. Do NOT call any tools.')
                }
              } catch (err) {
                console.log('⚠️ Failed to load conversation context for recovery:', err)
                queueVoiceInjection('[NOTIFICATION] The voice session was briefly interrupted but has been recovered. Ask the user if they can hear you and continue where you left off. Do NOT call any tools.')
              }
            } else {
              // No session ID — generic notification
              queueVoiceInjection('[NOTIFICATION] The voice session was briefly interrupted but has been recovered. Ask the user if they can hear you and continue where you left off. Do NOT call any tools.')
            }

            console.log('✅ Auto-recovery complete')
          } catch (err) {
            console.error('❌ Auto-recovery failed:', err)
            sendToFrontend({ type: 'agent_state', state: 'error' })
          }
        }
      })
    }

    // Wire events on the initial session
    wireSessionEvents(session, agent)

    // Start voice session
    console.log('🎬 Starting voice session...')

    try {
      await session.start({ agent, room })
      console.log('✅ Voice session started!')
      console.log('🎤 Ready - speak to begin!\n')

      // Workspace is created later in the session_id event handler (when SDK assigns real ID)

      // Send ready signal with persistent retry
      console.log('💓 Sending agent_ready signal...')
      let readySent = false
      const provider = sessionVoiceMode === 'realtime' ? realtimeConfig.provider : 'claude'

      // Fetch full session list for startup session browser
      const allSessions = await listSessions(workingDir)
      const recentSessionId = allSessions.length > 0 ? allSessions[0].sessionId : null
      const hasRecentSession = allSessions.length > 0

      // Prepare sessions for frontend (up to 50)
      const sessionsForFrontend = allSessions.slice(0, 50).map(s => ({
        sessionId: s.sessionId,
        timestamp: s.timestamp.toISOString(),
        lastMessage: s.lastMessage,
        messageCount: s.messageCount,
      }))

      const sendReady = async () => {
        if (readySent) return
        await sendToFrontend({
          type: 'agent_ready',
          provider,
          voiceMode: sessionVoiceMode,
          hasRecentSession,
          recentSessionId,
          sessions: sessionsForFrontend,
          preSelectedSessionId,
          mcpServers: getMcpServerStatusList(config),
          enabledMcpServers: enabledMcpNames,
        })
      }
      const readyInterval = setInterval(sendReady, 2000)
      await sendReady()
      setTimeout(() => {
        clearInterval(readyInterval)
        console.log('✅ agent_ready retries complete')
      }, 20000)

      // Stop agent_ready retries on user speech
      session.on('input_speech_started' as any, () => {
        readySent = true
        clearInterval(readyInterval)
      })

      // Greet user via TTS (delayed if resume prompt will be shown)
      // For realtime mode: use generateReply() since there's no standalone TTS
      // For direct mode: use say() which goes through the configured TTS
      const greetViaVoice = async (text: string) => {
        if (sessionVoiceMode === 'realtime') {
          // Realtime models handle their own speech generation
          await session.generateReply({ userInput: text })
        } else {
          await (session as any).say(text)
        }
      }

      if (preSelectedSessionId && sessionExists(preSelectedSessionId, workingDir)) {
        // User pre-selected a session from the session browser — auto-resume immediately
        console.log(`📂 Auto-resuming pre-selected session: ${preSelectedSessionId}`)
        if (currentLLM) {
          currentLLM.setResumeSessionId(preSelectedSessionId)
          console.log(`🔄 Session resume configured: ${preSelectedSessionId}`)

          // Fetch context and greet with it
          const summary = await getSessionSummary(preSelectedSessionId, workingDir)
          const conversationHistory = await getConversationHistory(preSelectedSessionId, workingDir, 30)

          await sendToFrontend({
            type: 'session_resume_set',
            sessionId: preSelectedSessionId,
            success: true,
          })

          // Send existing workspace artifacts to frontend (session-scoped)
          const preArtifacts = listWorkspaceArtifacts(workingDir, preSelectedSessionId!)
          if (preArtifacts.length > 0) {
            console.log(`📁 Sending ${preArtifacts.length} workspace artifacts to frontend`)
            await sendToFrontend({
              type: 'session_artifacts',
              sessionId: preSelectedSessionId,
              artifacts: preArtifacts.map(a => ({
                filePath: a.filePath,
                fileName: a.fileName,
                type: a.type,
                updatedAt: a.updatedAt,
              }))
            })
          }

          // Load full session history into realtime model's context
          if (summary) {
            loadSessionHistoryIntoChatCtx(currentAgent, conversationHistory, currentProvider)
            const contextBriefing = buildContextBriefing(summary, conversationHistory, currentProvider)
            const specContent = getSpecForVoiceModel(workingDir, preSelectedSessionId)
            const specSection = specContent
              ? `\n\n=== SESSION SPEC ===\n${specContent}\n=== END SPEC ===\nCheck "Open Questions" — if any are unanswered, ask the user about them.`
              : ''
            try {
              if (sessionVoiceMode === 'realtime') {
                const contextPrompt = `[SESSION RESUMED] The user chose to continue a previous research session. Here's the context:\n${contextBriefing}${specSection}\n\nBriefly acknowledge the previous session. If there are open questions in the spec, ask the most important one. Otherwise ask what they'd like to continue with.`
                await session.generateReply({ instructions: contextPrompt })
              } else {
                await (session as any).say("Welcome back! Ready to continue our previous conversation.")
              }
            } catch (err) {
              console.log('⚠️ Pre-selected session greeting failed:', err)
            }
          }
        }
      } else if (!preSelectedSessionId && hasRecentSession) {
        // No pre-selected session but sessions exist — defer greeting for session gate
        console.log('⏳ Deferring greeting until session gate is completed')
      } else {
        // No sessions at all (or new session chosen) — greet as new user
        try {
          console.log('👋 Sending greeting...')
          await greetViaVoice("The user just connected for the first time. Briefly greet them as Osborn and ask what they're working on.")
          console.log('✅ Greeting sent')
        } catch (err) {
          console.log('⚠️ Greeting failed:', err)
        }
      }
    } catch (err) {
      console.error('❌ Failed to start session:', err)
    }
  })

  room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
    console.log(`👋 User left: ${participant.identity}`)
    if (currentSession) {
      currentSession.removeAllListeners()
      currentSession = null
      currentLLM = null
    }
    console.log('⏳ Waiting for new user...\n')
  })

  room.on(RoomEvent.DataReceived, async (payload, participant, kind, topic) => {
    if (topic !== 'user-input') return

    try {
      const data = JSON.parse(new TextDecoder().decode(payload))
      console.log('📨 Data:', data.type)

      if (data.type === 'permission_response') {
        // Handle permission response for direct mode
        if (currentLLM && currentLLM.hasPendingPermission?.()) {
          const allow = data.response === 'allow' || data.response === 'always_allow'
          currentLLM.respondToPermission(allow)
          console.log(`✅ Permission: ${data.response}`)
        }
      } else if (data.type === 'user_text' && currentSession) {
        console.log(`📝 Text: "${data.content}"`)
        // Skip interrupt for Gemini — disrupts state machine (hangs in speaking state)
        if (currentProvider !== 'gemini') {
          currentSession.interrupt()
        }
        await currentSession.generateReply({ userInput: data.content })
      }
      // ============================================================
      // SESSION MANAGEMENT HANDLERS
      // ============================================================
      else if (data.type === 'list_sessions') {
        // List available sessions for this project
        console.log('📋 Listing available sessions...')
        try {
          // Clean up orphaned metadata entries before listing
          await cleanupOrphanedMetadata(workingDir)

          const sessions = await listSessions(workingDir)
          await sendToFrontend({
            type: 'sessions_list',
            sessions: sessions.map(s => ({
              sessionId: s.sessionId,
              timestamp: s.timestamp.toISOString(),
              lastMessage: s.lastMessage,
              messageCount: s.messageCount,
            })),
            count: sessions.length,
          })
        } catch (err) {
          console.error('Failed to list sessions:', err)
          await sendToFrontend({
            type: 'sessions_list',
            sessions: [],
            count: 0,
            error: 'Failed to list sessions',
          })
        }
      }
      else if (data.type === 'resume_session' && currentLLM) {
        // Set session to resume
        const sessionId = data.sessionId as string
        if (sessionId && sessionExists(sessionId, workingDir)) {
          currentLLM.setResumeSessionId(sessionId)
          console.log(`🔄 Will resume session: ${sessionId}`)

          const summary = await getSessionSummary(sessionId, workingDir)
          const conversationHistory = await getConversationHistory(sessionId, workingDir, 30)

          await sendToFrontend({
            type: 'session_resume_set',
            sessionId,
            success: true,
          })

          // Send existing session artifacts to frontend (session-scoped)
          const artifacts = listWorkspaceArtifacts(workingDir, sessionId)
          if (artifacts.length > 0) {
            console.log(`📁 Sending ${artifacts.length} session artifacts to frontend`)
            await sendToFrontend({
              type: 'session_artifacts',
              sessionId,
              artifacts: artifacts.map(a => ({
                filePath: a.filePath,
                fileName: a.fileName,
                type: a.type,
                updatedAt: a.updatedAt,
              }))
            })
          }

          if (currentSession && summary) {
            loadSessionHistoryIntoChatCtx(currentAgent, conversationHistory, currentProvider)
            const contextBriefing = buildContextBriefing(summary, conversationHistory, currentProvider)
            const specContent = getSpecForVoiceModel(workingDir, sessionId)
            const specSection = specContent
              ? `\n\n=== SESSION SPEC ===\n${specContent}\n=== END SPEC ===\nCheck "Open Questions" — if any are unanswered, ask the user about them.`
              : ''
            console.log('📋 Injecting session context into voice agent...')
            try {
              if (currentVoiceMode === 'realtime') {
                const contextPrompt = `[SESSION RESUMED] The user chose to continue a previous research session. Here's the context:\n${contextBriefing}${specSection}\n\nBriefly acknowledge the previous session. If there are open questions in the spec, ask the most important one. Otherwise ask what they'd like to continue with.`
                await currentSession.generateReply({ instructions: contextPrompt })
              } else {
                await (currentSession as any).say("Ready to continue our previous conversation.")
              }
            } catch (err) {
              console.log('⚠️ Context injection failed:', err)
            }
          }
        } else {
          console.error(`❌ Session not found: ${sessionId}`)
          await sendToFrontend({
            type: 'session_resume_set',
            sessionId,
            success: false,
            error: 'Session not found',
          })
        }
      }
      else if (data.type === 'continue_session' && currentLLM) {
        const recentId = await getMostRecentSessionId(workingDir)
        if (recentId) {
          currentLLM.setResumeSessionId(recentId)
          console.log(`🔄 Continuing most recent session: ${recentId}`)

          const summary = await getSessionSummary(recentId, workingDir)
          const conversationHistory = await getConversationHistory(recentId, workingDir, 30)

          await sendToFrontend({
            type: 'session_resume_set',
            sessionId: recentId,
            success: true,
          })

          // Send existing session artifacts to frontend (session-scoped)
          const artifacts = listWorkspaceArtifacts(workingDir, recentId)
          if (artifacts.length > 0) {
            console.log(`📁 Sending ${artifacts.length} session artifacts to frontend`)
            await sendToFrontend({
              type: 'session_artifacts',
              sessionId: recentId,
              artifacts: artifacts.map(a => ({
                filePath: a.filePath,
                fileName: a.fileName,
                type: a.type,
                updatedAt: a.updatedAt,
              }))
            })
          }

          if (currentSession && summary) {
            loadSessionHistoryIntoChatCtx(currentAgent, conversationHistory, currentProvider)
            const contextBriefing = buildContextBriefing(summary, conversationHistory, currentProvider)
            const specContent = getSpecForVoiceModel(workingDir, recentId)
            const specSection = specContent
              ? `\n\n=== SESSION SPEC ===\n${specContent}\n=== END SPEC ===\nCheck "Open Questions" — if any are unanswered, ask the user about them.`
              : ''
            console.log('📋 Injecting session context into voice agent...')
            try {
              if (currentVoiceMode === 'realtime') {
                const contextPrompt = `[SESSION RESUMED] The user chose to continue their most recent research session. Here's the context:\n${contextBriefing}${specSection}\n\nBriefly acknowledge the previous session. If there are open questions in the spec, ask the most important one. Otherwise ask what they'd like to continue with.`
                await currentSession.generateReply({ instructions: contextPrompt })
              } else {
                await (currentSession as any).say("Continuing where we left off.")
              }
            } catch (err) {
              console.log('⚠️ Context injection failed:', err)
            }
          }
        } else {
          console.log('📋 No previous sessions found - starting fresh')
          await sendToFrontend({
            type: 'session_resume_set',
            sessionId: null,
            success: false,
            error: 'No previous sessions found',
          })
        }
      }
      else if (data.type === 'switch_session' && currentLLM) {
        // Switch to a different session mid-conversation
        const sessionId = data.sessionId as string

        if (sessionId && sessionExists(sessionId, workingDir)) {
          // Step 1: Get FULL context summary with conversation history
          const summary = await getSessionSummary(sessionId, workingDir)
          const conversationHistory = await getConversationHistory(sessionId, workingDir, 30)

          // Step 2: Reset LLM state and configure for new session
          currentLLM.resetForSessionSwitch()
          currentLLM.setResumeSessionId(sessionId)
          console.log(`🔄 Switched to session: ${sessionId}`)

          // Step 3: Send full context to frontend (including conversation history)
          await sendToFrontend({
            type: 'session_switched',
            sessionId,
            success: true,
            summary,
            conversationHistory,
          })

          // Step 3.5: Send existing session artifacts to frontend (session-scoped)
          const switchArtifacts = listWorkspaceArtifacts(workingDir, sessionId)
          if (switchArtifacts.length > 0) {
            console.log(`📁 Sending ${switchArtifacts.length} session artifacts to frontend`)
            await sendToFrontend({
              type: 'session_artifacts',
              sessionId,
              artifacts: switchArtifacts.map(a => ({
                filePath: a.filePath,
                fileName: a.fileName,
                type: a.type,
                updatedAt: a.updatedAt,
              }))
            })
          }

          // Step 4: Voice agent acknowledges context
          if (currentSession && summary) {
            loadSessionHistoryIntoChatCtx(currentAgent, conversationHistory, currentProvider)
            const contextBriefing = buildContextBriefing(summary, conversationHistory, currentProvider)
            try {
              if (currentVoiceMode === 'realtime') {
                const contextPrompt = `[SESSION SWITCHED] The user switched to a different research session. Here's the context:\n${contextBriefing}\n\nBriefly acknowledge the switch and summarize what was being worked on.`
                await currentSession.generateReply({ instructions: contextPrompt })
              } else {
                const acknowledgment = summary.lastMessages.length > 0
                  ? `I've switched to your previous session. You were working on: ${summary.lastMessages[summary.lastMessages.length - 1]?.substring(0, 100)}`
                  : `Switched to previous session with ${summary.messageCount} messages. What would you like to continue with?`
                await (currentSession as any).say(acknowledgment)
              }
            } catch (err) {
              console.log('⚠️ Switch acknowledgment failed:', err)
            }
          }
        } else {
          await sendToFrontend({
            type: 'session_switched',
            sessionId,
            success: false,
            error: 'Session not found',
          })
        }
      }
      else if (data.type === 'get_current_session' && currentLLM) {
        // Get current session ID
        await sendToFrontend({
          type: 'current_session',
          sessionId: currentLLM.sessionId,
          isResumingSession: currentLLM.isResumingSession,
        })
      }
      else if (data.type === 'get_session_artifacts') {
        const sessionId = data.sessionId as string
        if (sessionId) {
          const artifacts = listWorkspaceArtifacts(workingDir, sessionId)
          console.log(`📁 Sending ${artifacts.length} session artifacts for ${sessionId.substring(0, 8)}`)
          await sendToFrontend({
            type: 'session_artifacts',
            sessionId,
            artifacts: artifacts.map(a => ({
              filePath: a.filePath,
              fileName: a.fileName,
              type: a.type,
              updatedAt: a.updatedAt,
            }))
          })
        }
      }
      // ============================================================
      // SESSION GATE HANDLER (initial session selection before voice)
      // ============================================================
      else if (data.type === 'get_plan_file') {
        const filePath = data.filePath as string
        if (filePath && filePath.includes('.claude/plans/')) {
          try {
            const fs = await import('fs')
            const content = fs.readFileSync(filePath, 'utf-8')
            await sendToFrontend({ type: 'plan_file_content', filePath, content, fileName: filePath.split('/').pop() })
          } catch (err) {
            await sendToFrontend({ type: 'plan_file_content', filePath, content: '', error: (err as Error).message })
          }
        }
      }
      else if (data.type === 'get_research_artifact') {
        const filePath = data.filePath as string
        if (filePath && (filePath.includes('.osborn/sessions/') || filePath.includes('.osborn/research/'))) {
          try {
            const fs = await import('fs')
            const fileName = filePath.split('/').pop() || ''
            const ext = fileName.split('.').pop()?.toLowerCase() || ''
            const isImage = ['png', 'jpg', 'jpeg', 'svg', 'gif', 'webp'].includes(ext)
            if (isImage) {
              const base64 = fs.readFileSync(filePath, 'base64')
              await sendToFrontend({ type: 'research_artifact_content', filePath, content: base64, fileName, isImage: true, mimeType: `image/${ext}` })
            } else {
              const content = fs.readFileSync(filePath, 'utf-8')
              await sendToFrontend({ type: 'research_artifact_content', filePath, content, fileName, isImage: false })
            }
          } catch (err) {
            await sendToFrontend({ type: 'research_artifact_content', filePath, content: '', error: (err as Error).message })
          }
        }
      }
      // ============================================================
      // MCP SERVER TOGGLE HANDLERS
      // ============================================================
      else if (data.type === 'mcp_toggle' && currentLLM) {
        const serverKey = data.serverKey as string
        const enabled = data.enabled as boolean
        console.log(`🔌 MCP toggle: ${serverKey} → ${enabled ? 'ON' : 'OFF'}`)

        if (enabled) {
          try {
            // Check if this is a Smithery HTTP server — use proxy to bypass SDK bug
            const catalogEntry = MCP_CATALOG.find(e => e.serverKey === serverKey)
            const isSmitheryServer = catalogEntry?.url && isSmitheryUrl(catalogEntry.url)

            if (isSmitheryServer && catalogEntry?.url) {
              // Smithery cloud server: use in-process proxy (bypasses SDK HTTP bug #18296)
              const parsed = parseSmitheryUrl(catalogEntry.url)
              if (parsed) {
                const proxyConfig = await createSmitheryProxy({
                  name: serverKey,
                  namespace: parsed.namespace,
                  connectionId: parsed.connectionId,
                })
                currentLLM.enableMcpServer(serverKey, proxyConfig)
                await announceViaVoice(`${serverKey} tools enabled.`)
              } else {
                throw new Error(`Could not parse Smithery URL: ${catalogEntry.url}`)
              }
            } else {
              // Non-Smithery server: use standard config (stdio or direct http)
              const serverConfigs = buildMcpServersForKeys(config, [serverKey])
              const serverConfig = serverConfigs[serverKey]
              if (serverConfig) {
                currentLLM.enableMcpServer(serverKey, serverConfig)
                await announceViaVoice(`${serverKey} tools enabled.`)
              } else {
                throw new Error('Server configuration not found')
              }
            }
          } catch (err) {
            const errorMsg = err instanceof SmitheryAuthorizationError
              ? `OAuth required: ${err.authorizationUrl}`
              : (err as Error).message
            console.error(`❌ MCP toggle failed for ${serverKey}: ${errorMsg}`)
            await sendToFrontend({
              type: 'mcp_toggle_result',
              serverKey,
              success: false,
              error: errorMsg,
            })
          }
        } else {
          await destroySmitheryProxy(serverKey) // Clean up proxy if exists
          currentLLM.disableMcpServer(serverKey)
          await announceViaVoice(`${serverKey} tools disabled.`)
        }

        // Send updated status back
        await sendToFrontend({
          type: 'mcp_toggle_result',
          serverKey,
          enabled,
          success: true,
          mcpServers: getMcpServerStatusList(config),
          enabledKeys: currentLLM.getEnabledMcpServerKeys(),
        })
      }
      else if (data.type === 'get_mcp_status') {
        // Frontend requesting current MCP status
        const statusList = getMcpServerStatusList(config)
        const enabledKeys = currentLLM?.getEnabledMcpServerKeys() || []
        // Merge runtime enabled state into status list
        const mergedStatus = statusList.map(s => ({
          ...s,
          enabled: enabledKeys.includes(s.serverKey),
        }))
        await sendToFrontend({
          type: 'mcp_status',
          mcpServers: mergedStatus,
          enabledKeys,
        })
      }
      else if (data.type === 'session_selected') {
        const sessionId = data.sessionId as string | null
        console.log(`🚪 Session gate completed: ${sessionId ? `resume ${sessionId}` : 'fresh start'}`)

        if (sessionId && currentLLM && sessionExists(sessionId, workingDir)) {
          // Resume the selected session
          currentLLM.setResumeSessionId(sessionId)
          console.log(`🔄 Resuming session: ${sessionId}`)

          // Fetch context and greet with it
          const summary = await getSessionSummary(sessionId, workingDir)
          const conversationHistory = await getConversationHistory(sessionId, workingDir, 30)

          await sendToFrontend({
            type: 'session_resume_set',
            sessionId,
            success: true,
          })

          // Send existing session artifacts to frontend (session-scoped)
          const gateArtifacts = listWorkspaceArtifacts(workingDir, sessionId)
          if (gateArtifacts.length > 0) {
            console.log(`📁 Sending ${gateArtifacts.length} session artifacts to frontend`)
            await sendToFrontend({
              type: 'session_artifacts',
              sessionId,
              artifacts: gateArtifacts.map(a => ({
                filePath: a.filePath,
                fileName: a.fileName,
                type: a.type,
                updatedAt: a.updatedAt,
              }))
            })
          }

          // Load full session history and greet with context
          if (currentSession && summary) {
            loadSessionHistoryIntoChatCtx(currentAgent, conversationHistory, currentProvider)
            const contextBriefing = buildContextBriefing(summary, conversationHistory, currentProvider)
            const specContent = getSpecForVoiceModel(workingDir, sessionId)
            const specSection = specContent
              ? `\n\n=== SESSION SPEC ===\n${specContent}\n=== END SPEC ===\nCheck "Open Questions" — if any are unanswered, ask the user about them.`
              : ''
            try {
              if (currentVoiceMode === 'realtime') {
                const contextPrompt = `[SESSION RESUMED] The user chose to continue a previous research session. Here's the context:\n${contextBriefing}${specSection}\n\nBriefly acknowledge the previous session. If there are open questions in the spec, ask the most important one. Otherwise ask what they'd like to continue with.`
                await currentSession.generateReply({ instructions: contextPrompt })
              } else {
                await (currentSession as any).say("Welcome back! Ready to continue our previous conversation.")
              }
            } catch (err) {
              console.log('⚠️ Session gate greeting failed:', err)
            }
          }
        } else {
          // Fresh start - just greet normally
          console.log('🆕 Starting fresh session')
          if (currentSession) {
            try {
              if (currentVoiceMode === 'realtime') {
                await currentSession.generateReply({ userInput: "The user just connected and chose to start a fresh session. Briefly greet them as Osborn and ask what they're working on." })
              } else {
                await (currentSession as any).say("Hey! I'm Osborn. What are you working on?")
              }
            } catch (err) {
              console.log('⚠️ Fresh session greeting failed:', err)
            }
          }
        }
      }
    } catch {}
  })

  // ============================================================
  // Connect to Room
  // ============================================================

  try {
    await room.connect(livekitUrl, jwt, {
      autoSubscribe: true,
      dynacast: true,
    })

    localParticipant = room.localParticipant
    console.log('✅ Connected to room:', roomName)

    console.log('\n⏳ Waiting for user to connect...')
    console.log(`   Room: ${roomCode}\n`)

    // Keep process alive
    await new Promise(() => {})

  } catch (err) {
    console.error('❌ Failed to connect:', err)
    process.exit(1)
  }
}

// Run
main().catch(console.error)
