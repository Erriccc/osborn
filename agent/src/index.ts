// Load environment variables FIRST before any other imports
import 'dotenv/config'

import { voice, initializeLogger, type Agent } from '@livekit/agents'
import { Room, RoomEvent, RemoteParticipant, LocalParticipant } from '@livekit/rtc-node'
import { AccessToken } from 'livekit-server-sdk'

// Initialize logger before anything else
initializeLogger({ pretty: true, level: 'info' })

// Prevent MaxListenersExceededWarning on AbortSignal from Claude SDK query() calls
// Each resumed query() adds listeners to the shared signal; default limit is 10
import { setMaxListeners } from 'node:events'
setMaxListeners(50)

import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, getMcpServers, getEnabledMcpServerNames, getVoiceMode, getRealtimeConfig, getDirectConfig, listSessions, getMostRecentSessionId, sessionExists, cleanupOrphanedMetadata, getSessionSummary, getConversationHistory, ensureSessionWorkspace, getMcpServerStatusList, buildMcpServersForKeys, listWorkspaceArtifacts, listLibraryFiles, type VoiceMode, type SessionInfo, type SessionSummary, type ConversationExchange } from './config.js'
import { createSTT, createTTS, createVAD, createRealtimeModelFromConfig, DIRECT_MODE_STT, DIRECT_MODE_TTS } from './voice-io.js'
import { createClaudeLLM } from './claude-llm.js'
import { createSmitheryProxy, destroySmitheryProxy, parseSmitheryUrl, isSmitheryUrl, SmitheryAuthorizationError } from './smithery-proxy.js'
import { askHaiku, askFastBrain, updateSpecFromJSONL, processResearchCompletion, handleResearchBatch, prepareBriefingScript, prepareRecoveryScript, writeQuestionToSpec, checkOutputAgainstQuestions, generateProactivePrompt, clearFastBrainSession, type ConversationTurn, type FastBrainCallbacks } from './fast-brain.js'
import { DIRECT_MODE_PROMPT, getRealtimeInstructions, getScriptInjection, getProactiveInjection, getNotificationInjection, getResearchCompleteInjection, getResearchUpdateInjection } from './prompts.js'
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

// Load skills list with name + description for frontend display
function loadSkillsList(agentDir: string): { name: string; description: string }[] {
  const skillsDir = join(agentDir, '.claude', 'skills')
  if (!existsSync(skillsDir)) return []
  const skills: { name: string; description: string }[] = []
  try {
    for (const skillName of readdirSync(skillsDir)) {
      const skillFile = join(skillsDir, skillName, 'SKILL.md')
      if (existsSync(skillFile)) {
        const content = readFileSync(skillFile, 'utf-8')
        // Extract title from first # heading, or use folder name
        const titleMatch = content.match(/^#\s+(?:Skill:\s*)?(.+)/m)
        const name = titleMatch ? titleMatch[1].trim() : skillName
        // Extract description from first paragraph after heading
        const descMatch = content.match(/^#[^\n]+\n+([^\n#]+)/m)
        const description = descMatch ? descMatch[1].trim() : ''
        skills.push({ name, description })
      }
    }
  } catch (err) {
    console.warn('⚠️ Failed to load skills list:', err)
  }
  return skills
}

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
  // LiveKit SDK internal error after participant disconnect — safe to suppress
  if (msg.includes("reading 'source'") || msg.includes("reading 'type'")) {
    console.log('⚠️ Post-disconnect cleanup error (harmless)')
    return
  }
  // generateReply timeout — realtime LLM called a tool instead of speaking (toolChoice:'none' ignored)
  // or Superseded — new generateReply cancelled a pending one
  if (msg.includes('generateReply timed out') || msg.includes('generation_created') || msg.includes('Superseded')) {
    console.log('⚠️ generateReply failed:', msg.substring(0, 80))
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

  // Two directory concepts:
  // 1. workingDir (cwd) — where Claude Code operates. Configurable per-session.
  //    Priority: OSBORN_CWD env > config.workingDirectory > process.cwd()
  // 2. sessionBaseDir — where session artifacts live (spec.md, library/).
  //    Always the Osborn agent install directory (where this process started).
  //    This ensures .osborn/sessions/ doesn't scatter across random directories.
  const sessionBaseDir = process.cwd() // Always the Osborn install dir
  const defaultWorkingDir = process.env.OSBORN_CWD || config.workingDirectory || process.cwd()
  let workingDir = defaultWorkingDir
  console.log(`📂 Working directory (cwd): ${workingDir}`)
  console.log(`📂 Session base directory: ${sessionBaseDir}`)
  if (process.env.OSBORN_CWD) {
    console.log(`   (cwd from OSBORN_CWD env var)`)
  }
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

  // Track the active resume session ID across scopes (ParticipantConnected + DataReceived)
  // Updated by resume_session, session_selected, continue_session, switch_session handlers
  let currentResumeSessionId: string | undefined

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
    abortController: AbortController // Abort SDK query on disconnect
  } | null = null

  // Persist last completed research context so follow-up questions can reference it
  // (activeResearch is set to null on completion — this preserves the context)
  let lastCompletedResearch: {
    task: string
    researchLog: string[]
    completedAt: number
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
    // Don't inject while fast brain tool call is in flight — the tool response will
    // race with our generateReply, causing Gemini to drop our content and only speak
    // the tool response. Wait for the tool call to complete first.
    if (haikuInFlight) {
      console.log(`⏸️ Voice queue: ${voiceQueue.length} items waiting (fast brain in flight: "${haikuInFlight.question.substring(0, 40)}...")`)
      return // Will be retried when haikuInFlight clears (see tool execute handler)
    }

    isProcessingQueue = true

    // Batch ALL queued items into one generateReply call
    const items = voiceQueue.splice(0)
    const batchedInstruction = items.length === 1
      ? items[0]
      : items.join('\n\n---\n\n')

    console.log(`📡 Voice queue: processing ${items.length} batched items (${batchedInstruction.length} chars)`)

    // Safety timeout: if agent_state_changed never fires (edge case — e.g. Gemini
    // WebSocket drops, or state machine hangs). 15s gives the model time to process.
    setTimeout(() => {
      if (isProcessingQueue) {
        console.log('⚠️ Voice queue: safety timeout — clearing guard')
        isProcessingQueue = false
        if (voiceQueue.length > 0 && agentState === 'listening') {
          processVoiceQueue()
        }
      }
    }, 15000)

    try {
      // Skip interrupt for Gemini — disrupts Gemini's state machine, causing it to
      // never transition back to 'listening' (hangs in speaking state indefinitely)
      if (currentProvider !== 'gemini') {
        currentSession.interrupt()
      }

      if (currentProvider === 'gemini') {
        // LiveKit SDK v1.0.51: generateReply({ instructions }) sends a system turn +
        // synthetic "." user turn. After Gemini processes a tool call in this flow,
        // autoToolReplyGeneration does NOT trigger continuation (system-only limitation).
        // Using userInput instead makes it a "user-initiated" request where auto-continuation
        // works. The ask_fast_brain injection bypass handles [SCRIPT]/[PROACTIVE]/[NOTIFICATION]
        // prefixes and returns the content directly as a tool response.
        currentSession.generateReply({
          userInput: batchedInstruction,
        })
      } else {
        // OpenAI respects toolChoice:'none' — speaks instructions directly
        currentSession.generateReply({
          instructions: batchedInstruction,
          toolChoice: 'none' as any,
        })
      }
      // Model transitions to thinking/speaking after this call.
      // When it returns to 'listening', agent_state_changed triggers processVoiceQueue() again.

      // Also inject into chatCtx as persistent context so the model remembers across turns
      injectIntoChatCtx(batchedInstruction)
    } catch (err) {
      console.log('⚠️ Voice queue generateReply failed:', err)
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

  // Extract recent voice conversation turns from the realtime LLM's in-memory ChatContext.
  // Replaces the internal conversationHistory array in fast-brain.ts.
  function getChatHistory(maxTurns: number = 20): ConversationTurn[] {
    if (!currentAgent) return []
    try {
      const items = currentAgent.chatCtx.items
      const turns: ConversationTurn[] = []
      for (const item of items) {
        if ((item as any).type !== 'message') continue
        const msg = item as any
        if (msg.role !== 'user' && msg.role !== 'assistant') continue
        const text = msg.textContent ?? ''
        if (!text.trim()) continue
        turns.push({ role: msg.role, text: text.trim() })
      }
      return turns.slice(-maxTurns)
    } catch (err) {
      console.log('⚠️ getChatHistory: failed to read chatCtx:', err)
      return []
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

      // Route through fast brain — it decides whether to speak (usually silent)
      if (activeResearch.voiceUpdateCount < 2) {
        const voiceSid = currentLLM?.sessionId
        if (voiceSid) {
          const chatHistory = getChatHistory(10)
          handleResearchBatch(workingDir, voiceSid, lastTaskRequest || '', updates, activeResearch.researchLog, chatHistory, sessionBaseDir)
            .then(script => {
              if (script && activeResearch) {
                activeResearch.voiceUpdateCount++
                queueVoiceInjection(getScriptInjection(script))
              }
            })
            .catch(() => {}) // Silent fail — updates are optional
        }
      }
    }, 8000) // 8s debounce: reduces voice queue flooding during research
  }

  // Proactive conversational loop — keeps conversation alive during research
  let proactiveTimer: ReturnType<typeof setInterval> | null = null
  let proactivePromptHistory: string[] = []
  const PROACTIVE_INTERVAL = 15000  // 15 seconds (offset from 8s batch timer)
  const MAX_PROACTIVE_PROMPTS = 2   // Cap per research task (reduced from 4 to minimize realtime LLM tokens)

  function startProactiveLoop(task: string, sessionId: string) {
    stopProactiveLoop()
    proactivePromptHistory = []
    let proactiveCount = 0

    proactiveTimer = setInterval(async () => {
      if (!activeResearch) { stopProactiveLoop(); return }
      if (proactiveCount >= MAX_PROACTIVE_PROMPTS) return
      if (agentState !== 'listening' || userState === 'speaking') return
      if (researchBatchTimer) return  // Don't collide with batch updates
      if (isProcessingQueue) return   // Don't collide with voice queue

      try {
        const prompt = await generateProactivePrompt(
          workingDir, sessionId, task,
          activeResearch.researchLog,
          proactivePromptHistory,
          sessionBaseDir,
        )
        if (prompt && prompt !== 'NOTHING') {
          proactivePromptHistory.push(prompt)
          proactiveCount++
          queueVoiceInjection(getProactiveInjection(prompt))
        }
      } catch {} // Silent fail — proactive prompts are optional
    }, PROACTIVE_INTERVAL)
  }

  function stopProactiveLoop() {
    if (proactiveTimer) { clearInterval(proactiveTimer); proactiveTimer = null }
    proactivePromptHistory = []
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

    const stt = createSTT(DIRECT_MODE_STT)
    const tts = createTTS(DIRECT_MODE_TTS)
    const vad = await createVAD()

    // Create Claude LLM wrapper — direct mode uses speech-optimized system prompt
    // skipTTSQueue: bypass LiveKit's BufferedTokenStream, use session.say() instead
    const directLLM = createClaudeLLM({
      workingDirectory: workingDir,
      sessionBaseDir,
      mcpServers,
      resumeSessionId,
      voiceMode: 'direct',
      skipTTSQueue: true,
    })
    currentLLM = directLLM

    // For resumed sessions, eagerly create workspace (we know the real ID)
    if (resumeSessionId) {
      const workspace = ensureSessionWorkspace(sessionBaseDir, resumeSessionId)
      console.log(`📁 Session workspace (resumed): ${workspace}`)
    }

    // For new sessions, create workspace when SDK assigns real session ID
    directLLM.events.once('session_id', ({ sessionId }: { sessionId: string }) => {
      const workspace = ensureSessionWorkspace(sessionBaseDir, sessionId)
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

    // Wire up TTS say — bypass LiveKit's BufferedTokenStream, speak directly via session.say()
    // Each text block from Claude gets spoken immediately as it arrives, no internal buffering
    directLLM.events.on('tts_say', (data) => {
      // Guard: session must be alive — TTS errors can kill the session while background query runs
      if (!currentSession) {
        console.warn(`⚠️ tts_say fired but currentSession is null — text dropped: "${data.text?.substring(0, 60)}"`)
        return
      }
      if (!data.text?.trim()) {
        console.log(`🔇 tts_say fired but text is empty — skipping`)
        return
      }

      const sayId = Date.now() // simple ID to correlate start/end logs
      console.log(`🗣️ [${sayId}] session.say START (${data.text.length} chars): "${data.text.substring(0, 60)}..."`)

      try {
        const handle = (currentSession as any).say(data.text)

        // Log when speech completes successfully
        if (handle && typeof handle.then === 'function') {
          handle
            .then(() => {
              console.log(`✅ [${sayId}] session.say DONE`)
            })
            .catch((err: any) => {
              console.error(`❌ [${sayId}] session.say FAILED:`, err?.message || err)
            })
        } else if (handle && handle._markDone) {
          // say() returned a SpeechHandle (not a Promise)
          console.log(`🗣️ [${sayId}] session.say queued (SpeechHandle returned)`)
        }
      } catch (err: any) {
        // Catch synchronous "AgentSession is not running" errors
        console.warn(`⚠️ [${sayId}] session.say threw — session likely dead: ${err?.message}`)
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

    // Create the session
    // minEndpointingDelay: After STT finalizes a transcript, wait this long before
    // considering the turn complete. Default is 500ms which cuts off mid-thought.
    // 3000ms matches our VAD minSilenceDuration so both agree on when the user is done.
    const session = new voice.AgentSession({
      turnDetection: 'vad',
      voiceOptions: {
        minEndpointingDelay: 3000, // 3s - gives user more time to finish speaking before we cut off
      },
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
      sessionBaseDir,
      mcpServers,
      resumeSessionId,
    })
    currentLLM = realtimeClaudeHandler

    // For resumed sessions, eagerly create workspace (we know the real ID)
    if (resumeSessionId) {
      const workspace = ensureSessionWorkspace(sessionBaseDir, resumeSessionId)
      console.log(`📁 Session workspace (resumed): ${workspace}`)
    }

    // For new sessions, create workspace when SDK assigns real session ID
    realtimeClaudeHandler.events.once('session_id', ({ sessionId }: { sessionId: string }) => {
      const workspace = ensureSessionWorkspace(sessionBaseDir, sessionId)
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
    // Skips during active research to avoid duplication with per-task onText handler
    realtimeClaudeHandler.events.on('assistant_text', (data) => {
      if (data.text && data.text.trim()) {
        if (activeResearch) return
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


    // Extracted research execution — called by ask_agent, SDK handles queuing internally
    function executeResearch(task: string): string {
      sendToFrontend({ type: 'system', text: `Executing: ${task}` })

      // Fire-and-forget: write user question to spec.md BEFORE agent starts
      const questionSid = currentLLM?.sessionId || resumeSessionId
      if (questionSid) {
        writeQuestionToSpec(sessionBaseDir, questionSid, task).catch(err =>
          console.error('❌ writeQuestionToSpec failed:', err)
        )
      }

      // Clean up previous research UI tracking — but let the SDK query complete in background.
      // The SDK has an internal queue: new query() calls enqueue behind running ones.
      // Old research results land in JSONL and fast brain can access them later.
      if (activeResearch) {
        activeResearch.cleanup() // Remove event listeners so UI tracks new task
        if (researchBatchTimer) { clearTimeout(researchBatchTimer); researchBatchTimer = null }
        // NOTE: NOT aborting — old SDK process continues writing to JSONL
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
      const ANSWER_CHECK_THRESHOLD = 300 // chars — only check substantial outputs
      const onToolResult = (data: any) => {
        // Only log to researchLog for the final summary — don't push to pendingUpdates
        // This prevents redundant "Reading config.ts. Read done." voice updates
        researchLog.push(`${data.name} completed`)
        // Fire-and-forget: check if substantial tool results answer any spec questions
        // Note: PostToolUse emits { name, input, response } — use data.response (not data.result)
        const resultText = typeof data.response === 'string' ? data.response : JSON.stringify(data.response || '')
        if (resultText.length > ANSWER_CHECK_THRESHOLD) {
          const sid = currentLLM?.sessionId || resumeSessionId
          if (sid) checkOutputAgainstQuestions(sessionBaseDir, sid, resultText, 'tool_result').catch(() => {})
        }
        // When AskUserQuestion completes, the user's answer is a decision — track it in spec
        if (data.name === 'AskUserQuestion' && data.response) {
          const sid = currentLLM?.sessionId || resumeSessionId
          if (sid) {
            const questionText = JSON.stringify(data.input?.questions || data.input || {})
            const answerText = typeof data.response === 'string' ? data.response : JSON.stringify(data.response)
            const specUpdate = `User answered a clarifying question during research.\nQuestion: ${questionText}\nAnswer: ${answerText}\nRecord this as a user decision in spec.md.`
            askHaiku(workingDir, sid, specUpdate, undefined, undefined, undefined, sessionBaseDir).catch(err =>
              console.error('❌ Failed to record AskUserQuestion answer in spec:', err)
            )
            console.log(`📝 AskUserQuestion answer forwarded to fast brain for spec tracking`)
          }
        }
      }
      const onText = (data: any) => {
        if (data.text?.trim()) {
          const text = data.text.trim()
          const preview = text.substring(0, 150)
          const firstSentence = preview.match(/^[^.!?\n]+[.!?]/)?.[0] || preview
          researchLog.push(firstSentence)
          pendingUpdates.push(firstSentence)
          scheduleResearchBatch()
          // Fire-and-forget: check if substantial agent reasoning answers any spec questions
          if (text.length > ANSWER_CHECK_THRESHOLD) {
            const sid = currentLLM?.sessionId || resumeSessionId
            if (sid) checkOutputAgainstQuestions(sessionBaseDir, sid, text, 'assistant_text').catch(() => {})
          }
        }
      }
      // Capture the SDK's requestId for this query — identifies this research task
      // in the JSONL file for targeted retrieval by fast brain
      let sdkRequestId: string | null = null
      const onQueryRequestId = (data: any) => {
        if (!sdkRequestId && data.requestId) {
          sdkRequestId = data.requestId
          console.log(`📋 [research] SDK requestId: ${sdkRequestId}`)
        }
      }
      realtimeClaudeHandler!.events.on('tool_use', onToolUse)
      realtimeClaudeHandler!.events.on('tool_result', onToolResult)
      realtimeClaudeHandler!.events.on('assistant_text', onText)
      realtimeClaudeHandler!.events.on('query_request_id', onQueryRequestId)

      const cleanupListeners = () => {
        realtimeClaudeHandler?.events.off('tool_use', onToolUse)
        realtimeClaudeHandler?.events.off('tool_result', onToolResult)
        realtimeClaudeHandler?.events.off('assistant_text', onText)
        realtimeClaudeHandler?.events.off('query_request_id', onQueryRequestId)
      }

      // Create AbortController for this research task — abort on disconnect/cleanup
      const researchAbortController = new AbortController()

      // Track active research — updates drain when model enters 'listening' state
      const thisResearch = {
        researchLog,
        pendingUpdates,
        cleanup: cleanupListeners,
        voiceUpdateCount: 0,
        abortController: researchAbortController,
      }
      activeResearch = thisResearch

      // Start proactive conversational loop
      const proactiveSid = currentLLM?.sessionId || resumeSessionId
      if (proactiveSid) {
        startProactiveLoop(task, proactiveSid)
      }

      // Run research in the background (non-blocking)
      // Pass AbortController so research can be stopped on disconnect
      const researchPromise = (async () => {
        const stream = realtimeClaudeHandler!.chat({
          chatCtx: {
            items: [{ type: 'message', role: 'user', content: [task] }],
          } as any,
          abortController: researchAbortController,
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
        // Check if aborted — empty result means clean abort, skip pipeline
        if (researchAbortController.signal.aborted || !result.trim()) {
          console.log(`🛑 [realtime] Research aborted or empty: ${task.substring(0, 60)}`)
          cleanupListeners()
          if (activeResearch === thisResearch) {
            activeResearch = null
          }
          return
        }

        const isStillCurrent = activeResearch === thisResearch
        console.log(`✅ [realtime] Research complete (${result.length} chars${isStillCurrent ? '' : ', superseded by newer task'})`)

        // Clean up
        cleanupListeners()

        // Send raw result to frontend as a log entry (not assistant_response — that's reserved
        // for the voice model's spoken response, avoiding duplication in chat)
        await sendToFrontend({ type: 'claude_output', text: result, isStreaming: false, agentRole: 'research-result' })
        const resultPreview = result.length > 150
          ? result.substring(0, 150) + '...'
          : result
        await sendToFrontend({ type: 'task_completed', task, resultPreview })

        // Only modify global state if we're still the current research task.
        // If a newer task replaced us, don't clobber its timers/state.
        if (isStillCurrent) {
          if (researchBatchTimer) { clearTimeout(researchBatchTimer); researchBatchTimer = null }
          stopProactiveLoop()
        }

        // Preserve research context for follow-up questions
        lastCompletedResearch = {
          task,
          researchLog: [...researchLog],
          completedAt: Date.now(),
        }

        // Only clear activeResearch if we're still the current task
        if (isStillCurrent) {
          activeResearch = null
        }

        // Send research_task_complete to frontend for inline chat tracking
        await sendToFrontend({
          type: 'research_task_complete',
          task,
          summary: result.substring(0, 500),
        })

        // Route through fast brain to generate a teleprompter script from the findings
        // Fast brain reads full JSONL and writes a spoken monologue
        const voiceSid = currentLLM?.sessionId || resumeSessionId
        const chatHistory = getChatHistory(10)
        console.log(`📡 [realtime] Generating teleprompter script via fast brain (result: ${result.length} chars, agentState: ${agentState})`)
        // Create sendToChat for research completion to send structured data to frontend
        const completionSendToChat = (text: string) => {
          sendToFrontend({ type: 'assistant_response', text })
        }
        if (voiceSid) {
          processResearchCompletion(workingDir, voiceSid, task, result, chatHistory, completionSendToChat, sessionBaseDir)
            .then(script => {
              queueVoiceInjection(getScriptInjection(script))
            })
            .catch(() => {
              // Fallback: use truncated result directly if fast brain fails
              queueVoiceInjection(getScriptInjection(result.substring(0, 500)))
            })
        } else {
          queueVoiceInjection(getScriptInjection(result.substring(0, 500)))
        }

        // Fire-and-forget JSONL-based refinement pass via fast brain
        // Reads FULL untruncated data from JSONL — no content buffer, no truncation
        const postResearchSessionId = currentLLM?.sessionId || resumeSessionId
        if (postResearchSessionId) {
          updateSpecFromJSONL(workingDir, postResearchSessionId, task, researchLog, sessionBaseDir)
            .then(updateResult => {
              if (!updateResult) return

              // Notify frontend about spec.md update
              if (updateResult.spec) {
                const specPath = `${sessionBaseDir}/.osborn/sessions/${postResearchSessionId}/spec.md`
                sendToFrontend({
                  type: 'research_artifact_updated',
                  filePath: specPath,
                  fileName: 'spec.md',
                })
                // Voice model is a teleprompter — fast brain reads spec directly, no ChatCtx injection needed
              }

              // Notify frontend about each library file written by the fast brain
              for (const libFile of updateResult.libraryFiles) {
                const libPath = `${sessionBaseDir}/.osborn/sessions/${postResearchSessionId}/library/${libFile}`
                sendToFrontend({
                  type: 'research_artifact_updated',
                  filePath: libPath,
                  fileName: libFile,
                })
              }
            })
        }
      }).catch(async (err) => {
        // Clean up
        cleanupListeners()
        const isStillCurrent = activeResearch === thisResearch
        if (isStillCurrent) {
          if (researchBatchTimer) { clearTimeout(researchBatchTimer); researchBatchTimer = null }
          stopProactiveLoop()
          activeResearch = null
        }

        // If aborted (user disconnected), log quietly
        if (researchAbortController.signal.aborted) {
          console.log(`🛑 [realtime] Research aborted: ${task.substring(0, 60)}`)
          return
        }

        console.error(`❌ [realtime] Research failed:`, err)
        // Queue error notification — will be spoken when model is available
        queueVoiceInjection(getNotificationInjection(`Research encountered an error: ${(err as Error).message}. You could try asking again.`))
      })

      // Return immediately to unblock the voice model
      return 'Research started. I\'ll relay findings as they come in — you can keep talking to the user while I work.'
    }

    // Create tools for the realtime voice LLM
    // The realtime model is a thin teleprompter — only 2 tools:
    // 1. ask_fast_brain: ALL user questions route here (the fast brain decides everything)
    // 2. respond_permission: voice permission flow for Claude SDK blocked operations

    const askFastBrainTool = llm.tool({
      description: `Ask your brain. Call this for EVERY user message — greetings, questions, decisions, requests, everything. No exceptions. Returns what you should say.`,
      parameters: z.object({
        question: z.string().describe('The user\'s question or statement'),
      }),
      execute: async ({ question }) => {
        // INJECTION BYPASS: When Gemini receives a system injection via generateReply(),
        // it calls ask_fast_brain with the injection content (Gemini always calls tools).
        // For Gemini: this is the INTENDED path — we deliberately don't set toolChoice:'none'
        //   so the tool call goes through and we return the content as a tool response.
        // For OpenAI: this is a fallback guard — OpenAI normally speaks instructions directly
        //   with toolChoice:'none', but if it somehow calls the tool, we handle it here.
        const injectionMatch = question.match(/\[(SCRIPT|PROACTIVE|NOTIFICATION)\]\s*([\s\S]*)/)
        if (injectionMatch) {
          const content = injectionMatch[2].trim()
          console.log(`⚡ [fast brain] BYPASS: injection [${injectionMatch[1]}] → returning content directly (${content.length} chars)`)
          return content || question
        }

        // Use pending sessionId for fresh sessions where SDK hasn't assigned one yet
        const sessionId = currentLLM?.sessionId || currentResumeSessionId || resumeSessionId || 'pending'
        console.log(`🧠 [fast brain] Question: "${question.substring(0, 80)}..."`)

        // Track in-flight state
        haikuInFlight = { question, time: Date.now() }

        // Build research context — from active research or last completed research
        let researchContext: string | undefined
        if (activeResearch && activeResearch.researchLog.length > 0) {
          const recentLog = activeResearch.researchLog.slice(-15)
          researchContext = `Research topic: "${lastTaskRequest || 'unknown'}"\nSteps completed (${activeResearch.researchLog.length} total, showing last ${recentLog.length}):\n${recentLog.join('\n')}`
        } else if (lastCompletedResearch && (Date.now() - lastCompletedResearch.completedAt) < 600000) {
          // Include context from last completed research (within 10 minutes)
          const recentLog = lastCompletedResearch.researchLog.slice(-15)
          researchContext = `[COMPLETED RESEARCH] Topic: "${lastCompletedResearch.task}"\nSteps completed (${lastCompletedResearch.researchLog.length} total, showing last ${recentLog.length}):\n${recentLog.join('\n')}\n\n(Research completed — results are in JSONL and spec.md. Answer from those, do NOT trigger new research on this topic.)`
        }

        const callbacks: FastBrainCallbacks = {
          triggerResearch: (task: string) => {
            // Deduplication guard
            const now = Date.now()
            if (task === lastTaskRequest && (now - lastTaskTime) < 10000) {
              console.log('⏭️ Skipping duplicate research task (within 10s window)')
              return
            }
            lastTaskRequest = task
            lastTaskTime = now
            executeResearch(task)
          },
          queueVoice: (script: string) => {
            queueVoiceInjection(getScriptInjection(script))
          },
          sendToFrontend: (data: any) => {
            sendToFrontend(data)
          },
        }

        try {
          const chatHistory = getChatHistory(20)
          const result = await askFastBrain(workingDir, sessionId, question, {
            chatHistory,
            researchContext,
            callbacks,
            sessionBaseDir,
          })
          haikuInFlight = null
          // Voice queue items may have been held while fast brain was in flight — retry now
          if (voiceQueue.length > 0) {
            setTimeout(() => processVoiceQueue(), 500)
          }

          console.log(`🧠 [fast brain] Response type: ${result.type}, script: ${result.script.length} chars`)

          // If this was a user direction during active research,
          // pass it to the agent SDK so it picks up the context
          if (activeResearch && result.type === 'recorded' && (
            question.toLowerCase().includes('decided') ||
            question.toLowerCase().includes('prefers') ||
            question.toLowerCase().includes('focus on') ||
            question.toLowerCase().includes('redirect')
          )) {
            console.log(`📨 [fast brain] Passing user direction to agent SDK queue`)
            executeResearch(`[USER DIRECTION during active research] ${question}. The user's spec.md has been updated. Acknowledge briefly and incorporate.`)
          }

          return result.script
        } catch (err) {
          haikuInFlight = null
          // Voice queue items may have been held while fast brain was in flight — retry now
          if (voiceQueue.length > 0) {
            setTimeout(() => processVoiceQueue(), 500)
          }
          console.error('❌ Fast brain failed:', err)
          return 'I\'m having trouble processing that. Could you try again?'
        }
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

    // Instructions for realtime voice LLM
    const realtimeInstructions = getRealtimeInstructions(workingDir)

    // Create realtime model
    const realtimeModel = createRealtimeModelFromConfig(rtConfig, realtimeInstructions)

    // Create the Agent with MINIMAL tools — fast brain handles all routing
    const agent = new voice.Agent({
      instructions: realtimeInstructions,
      llm: realtimeModel,
      tools: {
        ask_fast_brain: askFastBrainTool,
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
    stopProactiveLoop()
    if (activeResearch) {
      activeResearch.abortController.abort()
      activeResearch.cleanup()
      activeResearch = null
    }
    lastCompletedResearch = null
    currentSession = null
    currentAgent = null
    currentLLM = null
    clearFastBrainSession()
  })

  room.on(RoomEvent.ParticipantConnected, async (participant: RemoteParticipant) => {
    console.log(`\n👤 User joined: ${participant.identity}`)

    // Clean up any existing session before creating a new one
    voiceQueue.length = 0
    isProcessingQueue = false

    if (researchBatchTimer) { clearTimeout(researchBatchTimer); researchBatchTimer = null }
    stopProactiveLoop()
    clearFastBrainSession()
    if (activeResearch) {
      activeResearch.abortController.abort()
      activeResearch.cleanup()
      activeResearch = null
    }
    lastCompletedResearch = null
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
      // Read working directory override from frontend
      if (metadata.workingDirectory && typeof metadata.workingDirectory === 'string' && metadata.workingDirectory.length > 0) {
        workingDir = metadata.workingDirectory
        console.log(`📂 Working directory from frontend: ${workingDir}`)
      } else {
        // Reset to default for new connections (in case previous session changed it)
        workingDir = defaultWorkingDir
      }
    } catch (err) {
      console.log('⚠️ Could not parse participant metadata, using config voiceMode:', voiceMode)
    }

    // Sync to outer scope so DataReceived handler can use it
    currentVoiceMode = sessionVoiceMode
    currentProvider = sessionRealtimeProvider

    // Resume session ID — only set when resuming an existing session
    const resumeSessionId = preSelectedSessionId || undefined
    currentResumeSessionId = resumeSessionId
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
        // Filter out voice injection content that appears as user transcript
        // (Gemini v1.0.51: userInput in generateReply creates a user conversation item)
        if (normalized.startsWith('[SCRIPT]') || normalized.startsWith('[PROACTIVE]') || normalized.startsWith('[NOTIFICATION]')) return

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
        // When user stops speaking, retry voice queue — items may be waiting
        if (ev.newState === 'listening' && voiceQueue.length > 0) {
          setTimeout(() => processVoiceQueue(), 500)
        }
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

      // Capture voice mode at session creation — prevents state confusion
      // if currentVoiceMode changes between session start and crash recovery
      const sessionVoiceMode = currentVoiceMode

      // Close handler with auto-recovery for crashes (both realtime and direct modes)
      sess.on('close' as any, async (ev: any) => {
        console.log('🚪 Session closed:', ev.reason)

        // Auto-recover from crashes in direct mode (TTS timeout, speech interruption, disconnect, etc.)
        if ((ev.reason === 'error' || ev.reason === 'disconnected') && sessionVoiceMode === 'direct') {
          const now = Date.now()
          if (now - lastRecoveryTime < MIN_RECOVERY_INTERVAL) {
            console.log(`⚠️ Recovery too frequent — scheduling retry in ${MIN_RECOVERY_INTERVAL}ms`)
            setTimeout(async () => {
              // Re-check: if session was already recovered or user left, skip
              if (currentSession || !room.remoteParticipants.size) return
              console.log('🔄 Retrying direct mode recovery after guard interval...')
              // Trigger recovery by emitting a synthetic close
              sess.emit('close' as any, { reason: 'error' })
            }, MIN_RECOVERY_INTERVAL)
            return
          }
          lastRecoveryTime = now

          console.log(`🔄 Auto-recovering direct mode session (reason: ${ev.reason})...`)

          // Clean up dead session — match realtime recovery's thoroughness
          try { sess.removeAllListeners() } catch {}
          currentSession = null
          currentAgent = null

          // Clear stale state from crashed session
          voiceQueue.length = 0
          isProcessingQueue = false
          haikuInFlight = null
          if (researchBatchTimer) { clearTimeout(researchBatchTimer); researchBatchTimer = null }
          stopProactiveLoop()
          if (activeResearch) { activeResearch.abortController.abort(); activeResearch.cleanup(); activeResearch = null }

          try {
            // Reuse existing session ID so Claude SDK resumes where it left off
            const recoverySessionId = currentLLM?.sessionId || resumeSessionId
            const result = await createDirectSession(recoverySessionId)
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

            console.log('✅ Direct mode auto-recovery complete')

            // Notify user via TTS
            try {
              const recoveredId = currentLLM?.sessionId || recoverySessionId
              if (recoveredId) {
                const conversationHistory = await getConversationHistory(recoveredId, workingDir, 10)
                const historyForScript = conversationHistory.map(e => ({ role: e.role, text: e.content }))
                const script = await prepareRecoveryScript(historyForScript)
                // Direct mode: use session.say() for recovery notification
                newSession.say(script, { allowInterruptions: true })
              } else {
                newSession.say('Voice session was briefly interrupted but I\'m back. What were we working on?', { allowInterruptions: true })
              }
            } catch (err) {
              console.log('⚠️ Failed to generate recovery script:', err)
              try { newSession.say('I\'m back after a brief interruption. What were we working on?', { allowInterruptions: true }) } catch {}
            }
          } catch (err) {
            console.error('❌ Direct mode auto-recovery failed:', err)
            sendToFrontend({ type: 'agent_state', state: 'error' })
          }
          return
        }

        // Auto-recover from crashes in realtime mode
        if (ev.reason === 'error' && sessionVoiceMode === 'realtime') {
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
          stopProactiveLoop()
                if (activeResearch) { activeResearch.abortController.abort(); activeResearch.cleanup(); activeResearch = null }

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

            // Generate recovery script via fast brain
            const recoveredSessionId = currentLLM?.sessionId || recoverySessionId
            if (recoveredSessionId) {
              try {
                const conversationHistory = await getConversationHistory(recoveredSessionId, workingDir, 10)
                const historyForScript = conversationHistory.map(e => ({ role: e.role, text: e.content }))
                const script = await prepareRecoveryScript(historyForScript)
                queueVoiceInjection(getScriptInjection(script))
                console.log('📋 Injected recovery script into recovered session')
              } catch (err) {
                console.log('⚠️ Failed to generate recovery script:', err)
                queueVoiceInjection(getNotificationInjection('Voice session was briefly interrupted but I\'m back. What were we working on?'))
              }
            } else {
              queueVoiceInjection(getNotificationInjection('Voice session was briefly interrupted but I\'m back. What were we working on?'))
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
          workingDirectory: workingDir,
          skills: loadSkillsList(sessionBaseDir),
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
          // Use instructions (not userInput) to avoid system text appearing as user transcript
          await session.generateReply({ instructions: getScriptInjection(text) })
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
          const preArtifacts = listWorkspaceArtifacts(sessionBaseDir, preSelectedSessionId!)
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

          // Generate briefing script via fast brain
          if (summary) {
            loadSessionHistoryIntoChatCtx(currentAgent, conversationHistory, currentProvider)
            try {
              if (sessionVoiceMode === 'realtime') {
                const historyForScript = conversationHistory.map(e => ({ role: e.role, text: e.content }))
                const script = await prepareBriefingScript(sessionBaseDir, preSelectedSessionId, historyForScript)
                await session.generateReply({ instructions: getScriptInjection(script) })
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
          await greetViaVoice("Hey! I'm Osborn, your AI research assistant. What are you working on today?")
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

    // Full cleanup — stop all background work to avoid accumulating API usage
    voiceQueue.length = 0
    isProcessingQueue = false

    if (researchBatchTimer) { clearTimeout(researchBatchTimer); researchBatchTimer = null }
    stopProactiveLoop()
    if (activeResearch) {
      activeResearch.abortController.abort()
      activeResearch.cleanup()
      activeResearch = null
    }

    if (currentSession) {
      try { currentSession.close() } catch {}
      currentSession.removeAllListeners()
      currentSession = null
    }
    currentAgent = null
    currentLLM = null
    clearFastBrainSession()

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
        // Lightweight: set resume ID and send artifacts to frontend only
        // Context injection (generateReply) happens in session_selected handler
        // to avoid double generateReply calls that cause timeouts
        const sessionId = data.sessionId as string
        if (sessionId && sessionExists(sessionId, workingDir)) {
          currentLLM.setResumeSessionId(sessionId)
          currentResumeSessionId = sessionId
          console.log(`🔄 Will resume session: ${sessionId}`)

          await sendToFrontend({
            type: 'session_resume_set',
            sessionId,
            success: true,
          })

          // Send existing session artifacts to frontend (session-scoped)
          const artifacts = listWorkspaceArtifacts(sessionBaseDir, sessionId)
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
          currentResumeSessionId = recentId
          console.log(`🔄 Continuing most recent session: ${recentId}`)

          const summary = await getSessionSummary(recentId, workingDir)
          const conversationHistory = await getConversationHistory(recentId, workingDir, 30)

          await sendToFrontend({
            type: 'session_resume_set',
            sessionId: recentId,
            success: true,
          })

          // Send existing session artifacts to frontend (session-scoped)
          const artifacts = listWorkspaceArtifacts(sessionBaseDir, recentId)
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
            console.log('📋 Injecting session context into voice agent...')
            try {
              if (currentVoiceMode === 'realtime') {
                const historyForScript = conversationHistory.map(e => ({ role: e.role, text: e.content }))
                const script = await prepareBriefingScript(sessionBaseDir, recentId, historyForScript)
                await currentSession.generateReply({ instructions: getScriptInjection(script) })
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
          currentResumeSessionId = sessionId
          clearFastBrainSession()
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
          const switchArtifacts = listWorkspaceArtifacts(sessionBaseDir, sessionId)
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

          // Step 4: Voice agent acknowledges context via fast brain
          if (currentSession && summary) {
            loadSessionHistoryIntoChatCtx(currentAgent, conversationHistory, currentProvider)
            try {
              if (currentVoiceMode === 'realtime') {
                const historyForScript = conversationHistory.map(e => ({ role: e.role, text: e.content }))
                const briefingScript = await prepareBriefingScript(sessionBaseDir, sessionId, historyForScript, 'switch')
                queueVoiceInjection(getScriptInjection(briefingScript))
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
          const artifacts = listWorkspaceArtifacts(sessionBaseDir, sessionId)
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
            const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)
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
      else if (data.type === 'get_skills') {
        await sendToFrontend({
          type: 'skills_status',
          skills: loadSkillsList(sessionBaseDir),
        })
      }
      else if (data.type === 'skill_add') {
        const skillName = (data.name as string || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-')
        const skillContent = (data.content as string || '').trim()
        if (!skillName || !skillContent) {
          await sendToFrontend({ type: 'skill_add_result', success: false, error: 'Name and content are required' })
        } else {
          try {
            const skillDir = join(sessionBaseDir, '.claude', 'skills', skillName)
            mkdirSync(skillDir, { recursive: true })
            writeFileSync(join(skillDir, 'SKILL.md'), skillContent, 'utf-8')
            console.log(`📚 Skill added: ${skillName}`)
            const skills = loadSkillsList(sessionBaseDir)
            await sendToFrontend({ type: 'skill_add_result', success: true, skills })
          } catch (err) {
            console.error('❌ Failed to add skill:', err)
            await sendToFrontend({ type: 'skill_add_result', success: false, error: String(err) })
          }
        }
      }
      else if (data.type === 'session_selected') {
        const sessionId = data.sessionId as string | null
        console.log(`🚪 Session gate completed: ${sessionId ? `resume ${sessionId}` : 'fresh start'}`)

        if (sessionId && currentLLM && sessionExists(sessionId, workingDir)) {
          // Resume the selected session
          currentLLM.setResumeSessionId(sessionId)
          currentResumeSessionId = sessionId
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
          const gateArtifacts = listWorkspaceArtifacts(sessionBaseDir, sessionId)
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

          // Load full session history and greet with context via fast brain
          if (currentSession && summary) {
            loadSessionHistoryIntoChatCtx(currentAgent, conversationHistory, currentProvider)
            try {
              if (currentVoiceMode === 'realtime') {
                const historyForScript = conversationHistory.map(e => ({ role: e.role, text: e.content }))
                const briefingScript = await prepareBriefingScript(sessionBaseDir, sessionId, historyForScript, 'resume')
                queueVoiceInjection(getScriptInjection(briefingScript))
              } else {
                await (currentSession as any).say("Welcome back! Ready to continue our previous conversation.")
              }
            } catch (err) {
              console.log('⚠️ Session gate greeting failed:', err)
            }
          }
        } else {
          // Fresh start - greet via voice queue (not userInput, which creates a user transcript)
          currentResumeSessionId = undefined
          console.log('🆕 Starting fresh session')
          if (currentSession) {
            try {
              if (currentVoiceMode === 'realtime') {
                queueVoiceInjection(getScriptInjection("Hey! I'm Osborn, your AI research assistant. What are you working on today?"))
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
