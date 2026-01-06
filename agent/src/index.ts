// Load environment variables FIRST before any other imports
import 'dotenv/config'

import { llm, voice, initializeLogger } from '@livekit/agents'
import * as openai from '@livekit/agents-plugin-openai'
import * as google from '@livekit/agents-plugin-google'
import { Room, RoomEvent, RemoteParticipant, LocalParticipant, DataPacketKind } from '@livekit/rtc-node'
import { AccessToken } from 'livekit-server-sdk'
import { z } from 'zod'

// Initialize logger before anything else
initializeLogger({ pretty: true, level: 'info' })

import { ClaudeHandler, type PermissionRequestEvent, type PermissionResponse } from './claude-handler.js'
import { CodexHandler } from './codex-handler.js'
import { loadConfig, getMcpServers, getEnabledMcpServerNames, getVoiceMode, type VoiceMode } from './config.js'
import { createSTT, createTTS, createVAD, type VoiceIOConfig } from './voice-io.js'
import { createBridgeLLM } from './bridge-llm.js'
import { createClaudeLLM } from './claude-llm.js'
import { createCodexLLM } from './codex-llm.js'
import { statusManager } from './status-manager.js'

// ============================================================
// DIRECT CONNECTION ARCHITECTURE
// ============================================================
// This agent connects DIRECTLY to LiveKit rooms without using
// the worker dispatch pattern. This is ideal for CLI tools that
// users install locally and connect to cloud-hosted frontends.
// ============================================================

// Type for coding agent selection
type CodingAgent = 'claude' | 'codex'

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
function parseArgs(): { roomCode?: string; provider?: string } {
  const args = process.argv.slice(2)
  let roomCode: string | undefined
  let provider: string | undefined

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--room' && args[i + 1]) {
      roomCode = args[i + 1]
    }
    if (args[i] === '--provider' && args[i + 1]) {
      provider = args[i + 1]
    }
    // Short code detection (e.g., `npm run dev abc123`)
    if (!args[i].startsWith('-') && args[i].length >= 4 && args[i].length <= 10 &&
        !['dev', 'start'].includes(args[i])) {
      roomCode = args[i]
    }
  }

  return { roomCode, provider }
}

// Global error handlers
process.on('unhandledRejection', (reason: any) => {
  // Suppress known Google LLM abort errors (happens when user interrupts)
  const msg = reason?.message || String(reason)
  if (msg.includes('aborted') || msg.includes('AbortError')) {
    console.log('⚠️ LLM request aborted (user interrupted)')
    return
  }
  // Log other errors but don't crash
  console.error('❌ Unhandled Rejection:', msg)
})

process.on('uncaughtException', (error) => {
  // Suppress abort errors
  if (error.message?.includes('aborted') || error.message?.includes('AbortError')) {
    console.log('⚠️ Operation aborted')
    return
  }
  console.error('❌ Uncaught Exception:', error)
})

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

  // Default provider and voice mode (can be overridden by frontend)
  const defaultProvider = cliArgs.provider || process.env.LLM_PROVIDER || 'openai'
  const voiceMode = getVoiceMode(config)
  console.log(`🎯 Default voice provider: ${defaultProvider}`)
  console.log(`🎙️ Default voice mode: ${voiceMode} (can be changed from frontend)`)

  // ============================================================
  // Initialize Claude Agents (Dual Architecture)
  // ============================================================
  console.log('\n🔥 Initializing Claude agents...')

  interface AgentSlot {
    id: number
    role: 'plan' | 'execute'
    handler: ClaudeHandler
    busy: boolean
    currentTask: string | null
    context: string[]
  }

  // Plan Agents (2-3 for parallel background research)
  const planAgent1: AgentSlot = {
    id: 1,
    role: 'plan',
    handler: new ClaudeHandler({
      workingDirectory: workingDir,
      permissionMode: 'plan',
      agentRole: 'plan',
      mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
    }),
    busy: false,
    currentTask: null,
    context: [],
  }

  const planAgent2: AgentSlot = {
    id: 2,
    role: 'plan',
    handler: new ClaudeHandler({
      workingDirectory: workingDir,
      permissionMode: 'plan',
      agentRole: 'plan',
      mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
    }),
    busy: false,
    currentTask: null,
    context: [],
  }

  const planAgent3: AgentSlot = {
    id: 3,
    role: 'plan',
    handler: new ClaudeHandler({
      workingDirectory: workingDir,
      permissionMode: 'plan',
      agentRole: 'plan',
      mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
    }),
    busy: false,
    currentTask: null,
    context: [],
  }

  // Execute Agent - Single writer for actual code changes
  const executeAgent: AgentSlot = {
    id: 4,
    role: 'execute',
    handler: new ClaudeHandler({
      workingDirectory: workingDir,
      permissionMode: 'default',
      agentRole: 'execute',
      mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
    }),
    busy: false,
    currentTask: null,
    context: [],
  }

  // Pool: 3 Plan agents (research) + 1 Execute agent (writing)
  const agentPool: AgentSlot[] = [planAgent1, planAgent2, planAgent3, executeAgent]
  console.log(`🧠 Agent pool: ${agentPool.filter(a => a.role === 'plan').length} Plan + ${agentPool.filter(a => a.role === 'execute').length} Execute`)

  // Smart routing
  function routeTask(task: string): AgentSlot {
    const taskLower = task.toLowerCase()

    const executeKeywords = [
      'create', 'make', 'build', 'implement', 'add', 'write',
      'fix', 'update', 'change', 'modify', 'edit', 'refactor',
      'delete', 'remove', 'run', 'execute', 'install', 'deploy',
      'commit', 'push', 'test', 'debug', 'start', 'stop',
    ]

    for (const keyword of executeKeywords) {
      if (taskLower.includes(keyword)) {
        // If execute agent is busy, find an available plan agent
        if (executeAgent.busy) {
          const freePlan = agentPool.find(s => s.role === 'plan' && !s.busy)
          if (freePlan) return freePlan
        }
        return executeAgent
      }
    }

    // For non-execute tasks, find any available plan agent
    const freePlan = agentPool.find(s => s.role === 'plan' && !s.busy)
    return freePlan || executeAgent
  }

  // ============================================================
  // Create Access Token for Agent
  // ============================================================
  console.log('🔑 Creating access token...')

  const token = new AccessToken(apiKey, apiSecret, {
    identity: 'osborn-agent',
    name: 'Osborn AI',
    metadata: JSON.stringify({ type: 'agent', version: '0.1.5' }),
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
  // Connect to Room Directly
  // ============================================================
  console.log('📡 Connecting to LiveKit...')

  const room = new Room()

  // Track state
  let currentSession: voice.AgentSession | null = null
  let currentProvider = defaultProvider
  let currentVoiceArch: 'realtime' | 'pipelined' = voiceMode
  let currentCodingAgent: CodingAgent = 'claude'
  let codexHandler: CodexHandler | null = null
  let localParticipant: LocalParticipant | null = null
  let agentState = 'initializing'

  // Speech queue
  const speechQueue: string[] = []
  let isSpeaking = false

  // ============================================================
  // TASK DEDUPLICATION - Prevents duplicate research tasks
  // ============================================================
  const activeTaskHashes = new Map<string, { startTime: number; slot: AgentSlot }>()
  const recentTaskHashes = new Set<string>() // Tasks completed in last 30 seconds

  function hashTask(task: string): string {
    // Normalize task for comparison (lowercase, trim, remove extra spaces)
    return task.toLowerCase().trim().replace(/\s+/g, ' ').substring(0, 100)
  }

  function isTaskDuplicate(task: string): boolean {
    const hash = hashTask(task)

    // Check if exact same task is currently running
    if (activeTaskHashes.has(hash)) {
      const active = activeTaskHashes.get(hash)!
      const elapsed = Date.now() - active.startTime
      if (elapsed < 60000) { // Within 60 seconds
        console.log(`⏭️ Skipping duplicate task (running for ${elapsed}ms): "${task.substring(0, 50)}..."`)
        return true
      }
    }

    // Check if task was recently completed
    if (recentTaskHashes.has(hash)) {
      console.log(`⏭️ Skipping recently completed task: "${task.substring(0, 50)}..."`)
      return true
    }

    return false
  }

  function registerTask(task: string, slot: AgentSlot): void {
    const hash = hashTask(task)
    activeTaskHashes.set(hash, { startTime: Date.now(), slot })
  }

  function completeTask(task: string): void {
    const hash = hashTask(task)
    activeTaskHashes.delete(hash)
    recentTaskHashes.add(hash)

    // Clear from recent after 30 seconds
    setTimeout(() => {
      recentTaskHashes.delete(hash)
    }, 30000)
  }

  // Helper to send data to frontend (with size limit handling)
  const MAX_MESSAGE_SIZE = 60000 // Leave some headroom below 65535 limit

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
          // Truncate text to fit within limit
          const overhead = JSON.stringify({ ...truncatedData, text: '' }).length
          const maxTextLength = MAX_MESSAGE_SIZE - overhead - 100 // Extra buffer
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

  // Process speech queue - supports both realtime and pipelined modes
  async function processSpeechQueue() {
    if (isSpeaking || speechQueue.length === 0 || !currentSession) return
    if (agentState !== 'listening') return

    isSpeaking = true
    const message = speechQueue.shift()!

    try {
      if (currentVoiceArch === 'pipelined') {
        // Pipelined mode: Use session.say() with TTS
        await Promise.race([
          (currentSession as any).say(message),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000))
        ])
      } else if (currentProvider !== 'gemini') {
        // Realtime mode: Use generateReply (only OpenAI supports this)
        await Promise.race([
          currentSession.generateReply({ userInput: message }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
        ])
      } else {
        // Gemini realtime doesn't support generateReply - just log
        console.log(`🔊 [Would say] ${message}`)
      }
    } catch (err) {
      console.log('⚠️ Speech queue error:', err)
    } finally {
      isSpeaking = false
      if (speechQueue.length > 0) {
        setTimeout(processSpeechQueue, 300)
      }
    }
  }

  // Setup agent event handlers - Stream Claude progress to frontend
  agentPool.forEach(slot => {
    slot.handler.on('permission_request', (req: PermissionRequestEvent) => {
      console.log(`\n⚠️ [${slot.role}] PERMISSION: ${req.toolName}`)
      sendToFrontend({
        type: 'permission_request',
        toolName: req.toolName,
        description: req.description,
        agentId: slot.id,
      })
      speechQueue.push(`[Tell user] I need permission to ${req.description}. Say yes, no, or always allow.`)
      processSpeechQueue()
    })

    // Stream tool usage to frontend in real-time
    slot.handler.on('tool_use', (tool: any) => {
      console.log(`🔧 [${slot.role}] Using: ${tool.name}`)
      // Send tool usage to frontend for display
      const toolDesc = tool.description || tool.input?.substring?.(0, 100) || ''
      sendToFrontend({
        type: 'tool_use',
        tool: tool.name,
        description: toolDesc,
        agentRole: slot.role,
      })

      // For pipelined mode, speak brief updates via TTS
      if (currentVoiceArch === 'pipelined' && currentSession && agentState === 'listening') {
        const briefDesc = `Using ${tool.name}`
        ;(currentSession as any).say?.(briefDesc).catch(() => {})
      }
    })

    // Stream progress updates
    slot.handler.on('progress', (progress: any) => {
      console.log(`📊 [${slot.role}] Progress: ${progress.text || progress.message}`)
      sendToFrontend({
        type: 'progress_update',
        text: progress.text || progress.message,
        source: slot.role,
      })
    })

    // Stream Claude's text output (thinking/reasoning)
    slot.handler.on('text', (text: string) => {
      if (text && text.length > 10) {
        console.log(`💭 [${slot.role}] Claude: ${text.substring(0, 100)}...`)
        sendToFrontend({
          type: 'progress_update',
          text: text.substring(0, 300),
          source: `claude_${slot.role}`,
        })
      }
    })

    // Stream tool results
    slot.handler.on('tool_result', (result: any) => {
      console.log(`✅ [${slot.role}] Tool done: ${result.name} (${result.duration}ms)`)
      sendToFrontend({
        type: 'tool_use',
        tool: result.name,
        description: `Completed in ${result.duration}ms`,
        status: 'completed',
        agentRole: slot.role,
      })
    })

    // Stream final result
    slot.handler.on('result', (result: string) => {
      if (result && result.length > 10) {
        console.log(`📋 [${slot.role}] Result: ${result.substring(0, 100)}...`)
        // Don't send result here - it's sent via run_code tool return
      }
    })

    slot.handler.on('error', (err: any) => {
      console.error(`❌ [${slot.role}] Error:`, err)
      sendToFrontend({
        type: 'system',
        text: `⚠️ ${slot.role} error: ${err.message || err}`,
      })
    })
  })

  // Define tools for voice LLM
  const runCodeTool = llm.tool({
    description: `Execute ANY coding task by delegating to Claude agents. YOU MUST USE THIS for:
- Reading files ("read package.json", "show me the code")
- Writing/editing files ("fix this bug", "add a function")
- Running commands ("run npm test", "git status")
- Searching code ("find where X is defined")
- Explaining code ("what does this function do")

You DON'T need permission to use this - it routes to the right agent automatically.
Plan Agent = reading/research. Execute Agent = writing (will ask user for permission).`,
    parameters: z.object({
      task: z.string().describe('The coding task to execute'),
    }),
    execute: async ({ task }) => {
      // DEDUPLICATION: Skip if same task is already running or recently completed
      if (isTaskDuplicate(task)) {
        return `Task already running or recently completed: ${task.substring(0, 50)}...`
      }

      const slot = routeTask(task)
      console.log(`\n🔨 [${slot.role}] Task: "${task}"`)

      // Register task to prevent duplicates
      registerTask(task, slot)

      // Send to frontend immediately
      await sendToFrontend({ type: 'system', text: `🔧 ${slot.role} agent: ${task}` })

      slot.busy = true
      slot.currentTask = task
      sharedContext.currentFocus = task.substring(0, 50)

      try {
        let result: string
        if (currentCodingAgent === 'codex' && codexHandler) {
          result = await codexHandler.run(task)
        } else {
          const contextPrefix = slot.context.length > 0
            ? `Context: ${slot.context.slice(-3).join(' | ')}\n\nTask: `
            : ''
          result = await slot.handler.run(contextPrefix + task)
        }

        slot.context.push(`${task.substring(0, 50)} → Done`)
        if (slot.context.length > 10) slot.context.shift()

        // Update shared context
        sharedContext.addAction(`${slot.role}: ${task.substring(0, 30)}`)

        // Extract file references from result
        const fileMatches = result.match(/(?:\/[\w\-\.\/]+|src\/[\w\-\.\/]+|\.\/[\w\-\.\/]+)/g)
        if (fileMatches) {
          fileMatches.slice(0, 3).forEach(f => sharedContext.addFile(f))
        }

        console.log(`✅ [${slot.role}] Done`)

        // Mark task as complete (for deduplication)
        completeTask(task)

        // Send full result to frontend
        await sendToFrontend({ type: 'assistant_response', text: result, source: 'run_code' })

        // Return a concise summary for the voice LLM
        const summary = result.length > 500
          ? result.substring(0, 500) + '... [truncated for voice]'
          : result
        return summary
      } catch (err) {
        const errorMsg = `Error: ${(err as Error).message}`
        completeTask(task) // Still mark as complete to avoid retries
        await sendToFrontend({ type: 'assistant_response', text: errorMsg, source: 'run_code_error' })
        return errorMsg
      } finally {
        slot.busy = false
        slot.currentTask = null
      }
    },
  })

  const respondPermissionTool = llm.tool({
    description: `Respond to a permission request. Call after hearing user's response.`,
    parameters: z.object({
      response: z.enum(['allow', 'deny', 'always_allow']),
    }),
    execute: async ({ response }) => {
      const slot = agentPool.find(s => s.handler.hasPendingPermission())
      if (!slot) return 'No pending permission.'
      const pending = slot.handler.getPendingPermission()
      slot.handler.respondToPermission(response as PermissionResponse)
      await sendToFrontend({ type: 'permission_response', response, toolName: pending?.toolName })
      return `Permission ${response} for ${pending?.toolName || 'tool'}.`
    },
  })

  // ============================================================
  // SHARED CONTEXT
  // ============================================================
  // Tracks conversation state across voice and coding agents
  // ============================================================

  // Shared context that both voice and coding agents contribute to
  const sharedContext = {
    recentActions: [] as string[],
    discoveredFiles: [] as string[],
    currentFocus: null as string | null,
    addAction(action: string) {
      this.recentActions.push(action)
      if (this.recentActions.length > 5) this.recentActions.shift()
      statusManager.addContext(action)
    },
    addFile(file: string) {
      if (!this.discoveredFiles.includes(file)) {
        this.discoveredFiles.push(file)
        if (this.discoveredFiles.length > 10) this.discoveredFiles.shift()
      }
    },
    getContextSummary() {
      const parts = []
      if (this.currentFocus) parts.push(`Focus: ${this.currentFocus}`)
      if (this.recentActions.length) parts.push(`Recent: ${this.recentActions.slice(-3).join(', ')}`)
      if (this.discoveredFiles.length) parts.push(`Files: ${this.discoveredFiles.slice(-5).join(', ')}`)
      return parts.join(' | ')
    }
  }

  // Dynamic instructions with working directory context
  const getInstructions = () => `You are Osborn, a friendly voice AI coding assistant.

WORKING DIRECTORY: ${workingDir}

PERSONALITY: Conversational, helpful, proactive.
- Keep responses SHORT (<50 words for voice)
- ALWAYS speak tool results to the user verbally
- Do NOT add markdown formatting like **bold** headers

CAPABILITIES:
- FULL INTERNET ACCESS (web search, fetch URLs, APIs)
- Read/write files, run commands, search code
- Multiple Claude Code agents for parallel research

TOOLS:
1. run_code - Execute ANY coding task (reading, writing, commands, research)
   Routes automatically: Plan agents for reading/research, Execute agent for writing
2. respond_permission - Handle permission responses (yes/no/always allow)

USAGE:
- Use run_code for ALL coding requests
- The tool handles routing to the right agent automatically
- Tasks may take time - that's normal
- Speak the results naturally to the user

${sharedContext.getContextSummary() ? `CONTEXT: ${sharedContext.getContextSummary()}` : ""}`

  const INSTRUCTIONS = getInstructions()

  // Voice agent class
  class OsbornVoiceAgent extends voice.Agent {
    constructor() {
      super({
        instructions: INSTRUCTIONS,
        tools: {
          run_code: runCodeTool,
          respond_permission: respondPermissionTool,
        },
      })
    }
  }

  // Create voice model for realtime mode
  function createRealtimeModel(provider: string) {
    if (provider === 'gemini') {
      console.log('📱 Using Gemini Live API (realtime)')
      return new google.beta.realtime.RealtimeModel({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        voice: 'Puck',
        instructions: INSTRUCTIONS,
        // Enable transcription so we get text of what the agent says
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      })
    } else {
      console.log('📱 Using OpenAI Realtime API')
      return new openai.realtime.RealtimeModel({
        voice: 'alloy',
      })
    }
  }

  // Create pipelined session (STT + LLM + TTS)
  async function createPipelinedSession(provider: string): Promise<voice.AgentSession> {
    // PIPELINE CONFIGURATION:
    // - STT: Deepgram Nova-3 (native streaming, no "audio too short" errors)
    // - LLM: Gemini 2.5 Pro (smart conversation manager)
    // - TTS: Gemini (fast, same API key)
    // Note: OpenAI Whisper is batch-only and causes fragmentation issues
    const isOpenAI = provider === 'openai'

    const sttProvider = 'deepgram' // Native streaming - no short audio errors
    const llmProvider = isOpenAI ? 'gpt-4o' : 'gemini-pro'
    const ttsProvider = 'gemini' // Better streaming for long responses
    const ttsVoice = 'Zephyr'

    console.log(`📱 Pipeline: ${sttProvider} STT → ${llmProvider} → ${ttsProvider} TTS`)
    console.log('   ✨ session.say() ENABLED for interim voice updates!')

    const stt = createSTT({
      provider: sttProvider as any,
    })
    const bridgeLLM = createBridgeLLM({
      provider: llmProvider as any,
    })
    const tts = createTTS({
      provider: ttsProvider as any,
      voice: ttsVoice,
    })
    const vad = await createVAD()

    return new voice.AgentSession({
      vad,
      stt,
      llm: bridgeLLM,
      tts,
      turnDetection: 'vad' as any,
    })
  }

  // Create DIRECT session (STT + Claude/Codex SDK + TTS) - No middle layer!
  async function createDirectSession(codingAgent: CodingAgent): Promise<voice.AgentSession> {
    // DIRECT CONFIGURATION:
    // - STT: Deepgram Nova-3 (native streaming, no "audio too short" errors)
    // - LLM: Claude Agent SDK or Codex Agent SDK (direct!)
    // - TTS: Gemini (fast)
    // Note: OpenAI Whisper is batch-only and causes fragmentation issues
    console.log(`🎯 DIRECT MODE: Deepgram STT → ${codingAgent.toUpperCase()} Agent SDK → Gemini TTS`)
    console.log('   🔥 No middle layer - direct voice to coding agent!')

    const stt = createSTT({ provider: 'deepgram' })
    const tts = createTTS({ provider: 'gemini', voice: 'Zephyr' })
    const vad = await createVAD()

    // Create the appropriate LLM wrapper
    const directLLM = codingAgent === 'codex'
      ? createCodexLLM({ workingDirectory: workingDir })
      : createClaudeLLM({ workingDirectory: workingDir })

    // Wire up events from the SDK wrapper to frontend
    directLLM.events.on('tool_use', (data) => {
      console.log(`🔧 [direct] Tool: ${data.name}`)
      sendToFrontend({ type: 'tool_use', tool: data.name, agentRole: 'direct' })
    })
    directLLM.events.on('tool_result', (data) => {
      console.log(`✅ [direct] Done: ${data.name}`)
      sendToFrontend({ type: 'tool_use', tool: data.name, status: 'completed', agentRole: 'direct' })
    })

    // Wire up permission requests - sends to frontend for user approval
    directLLM.events.on('permission_request', (data) => {
      console.log(`⚠️ [direct] Permission needed: ${data.toolName}`)
      sendToFrontend({
        type: 'permission_request',
        toolName: data.toolName,
        input: data.input,
        agentRole: 'direct',
      })
      // Also speak the request so user knows to respond
      if (currentSession) {
        const desc = `I need permission to use ${data.toolName}. Say yes or no.`
        ;(currentSession as any).say?.(desc).catch(() => {})
      }
    })

    // Store directLLM reference for permission responses
    ;(createDirectSession as any).currentLLM = directLLM

    return new voice.AgentSession({
      vad,
      stt,
      llm: directLLM,
      tts,
      turnDetection: 'vad' as any,
    })
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
    currentSession = null
  })

  room.on(RoomEvent.ParticipantConnected, async (participant: RemoteParticipant) => {
    console.log(`\n👤 User joined: ${participant.identity}`)

    // Clean up any existing session before creating a new one
    if (currentSession) {
      console.log('🧹 Cleaning up previous session...')
      try {
        currentSession.removeAllListeners()
      } catch {}
      currentSession = null
    }

    // Get settings from participant metadata
    let provider = defaultProvider
    let userVoiceArch: 'realtime' | 'pipelined' | 'direct' = voiceMode as any // Default to config
    let codingAgent: CodingAgent = 'claude'

    if (participant.metadata) {
      try {
        const meta = JSON.parse(participant.metadata)
        provider = meta.provider || defaultProvider
        userVoiceArch = meta.voiceArch || voiceMode
        codingAgent = meta.codingAgent || 'claude'
      } catch {}
    }

    currentProvider = provider
    currentVoiceArch = userVoiceArch as any
    currentCodingAgent = codingAgent
    console.log(`🎯 Provider: ${provider}, Voice: ${userVoiceArch}, Agent: ${codingAgent}`)

    if (codingAgent === 'codex') {
      codexHandler = new CodexHandler({ workingDirectory: workingDir })
    }

    // Create voice session based on user's voice architecture choice
    let session: voice.AgentSession
    if (userVoiceArch === 'direct') {
      // DIRECT MODE: Voice → Claude/Codex Agent SDK → TTS (no middle layer!)
      session = await createDirectSession(codingAgent)
    } else if (userVoiceArch === 'pipelined') {
      session = await createPipelinedSession(provider)
    } else {
      const model = createRealtimeModel(provider)
      session = new voice.AgentSession({ llm: model })
    }
    currentSession = session

    // ============================================================
    // SIMPLIFIED TRANSCRIPT HANDLING
    // Single source of truth to avoid duplicates
    // ============================================================
    let lastTranscript = ''
    let lastSentUserTranscript = ''
    let lastSentAgentTranscript = ''

    // Helper to send user transcript (with deduplication)
    function sendUserTranscript(transcript: string, source: string) {
      if (!transcript || transcript.length < 3) return
      // Normalize for comparison
      const normalized = transcript.trim().replace(/\s+/g, ' ')
      if (normalized === lastSentUserTranscript) return
      if (normalized === '<noise>' || normalized.toLowerCase() === 'thank you') return // Skip noise

      console.log(`📝 User (${source}): "${transcript.substring(0, 60)}..."`)
      sendToFrontend({ type: 'user_transcript', text: transcript })
      lastSentUserTranscript = normalized
    }

    // Helper to send agent transcript (with deduplication)
    function sendAgentTranscript(text: string, source: string) {
      if (!text || text.length < 3) return
      const normalized = text.trim().replace(/\s+/g, ' ')
      if (normalized === lastSentAgentTranscript) return

      console.log(`💬 Agent (${source}): "${text.substring(0, 60)}..."`)
      sendToFrontend({ type: 'assistant_response', text })
      lastSentAgentTranscript = normalized
    }

    // Incremental transcription (for display while speaking)
    session.on('user_input_transcribed' as any, (ev: any) => {
      const transcript = ev.transcript || ''
      if (transcript && transcript !== lastTranscript && transcript.length > lastTranscript.length + 3) {
        lastTranscript = transcript
      }
    })

    // PRIMARY: conversation_item_added is the authoritative source
    session.on('conversation_item_added' as any, (ev: any) => {
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

    // FALLBACK: user_speech_committed for when conversation_item doesn't fire
    session.on('user_speech_committed' as any, (ev: any) => {
      const transcript = ev.transcript || ev.text || lastTranscript
      sendUserTranscript(transcript, 'committed')
      lastTranscript = ''
    })

    // Agent state tracking
    session.on('agent_state_changed' as any, (ev: any) => {
      agentState = ev.newState
      console.log(`🤖 State: ${ev.newState}`)
      sendToFrontend({ type: 'agent_state', state: ev.newState })

      // Process speech queue when agent becomes available
      if (ev.newState === 'listening' && speechQueue.length > 0) {
        processSpeechQueue()
      }
    })

    // FALLBACK: playout_completed for final agent message (Gemini realtime)
    session.on('playout_completed' as any, (ev: any) => {
      const message = ev.message || ev.text || ev.content
      if (message && message.length > 0) {
        sendAgentTranscript(message, 'playout')
      }
    })

    // FALLBACK: Gemini transcription events (if conversation_item doesn't fire)
    session.on('input_audio_transcription_completed' as any, (ev: any) => {
      const transcript = ev.transcript || ev.text
      if (transcript) sendUserTranscript(transcript, 'input_transcription')
    })

    session.on('output_audio_transcription_completed' as any, (ev: any) => {
      const text = ev.transcript || ev.text
      if (text) sendAgentTranscript(text, 'output_transcription')
    })

    // Error and close handlers
    session.on('error' as any, (ev: any) => {
      console.error('❌ Session error:', ev.error)
    })

    session.on('close' as any, (ev: any) => {
      console.log('🚪 Session closed:', ev.reason)
    })

    // Start voice session
    console.log('🎬 Starting voice session...')
    const agent = new OsbornVoiceAgent()

    try {
      // Enable video for Gemini realtime (supports vision)
      const inputOptions = provider === 'gemini' ? {
        videoEnabled: true,  // Enable video/vision for Gemini
        audioEnabled: true,
        textEnabled: true,
      } : undefined

      await session.start({
        agent,
        room,
        inputOptions,
      })
      console.log('✅ Voice session started!')
      console.log('🎤 Ready - speak to begin!\n')

      // Send ready signal with persistent retry (frontend might not be subscribed yet)
      console.log('💓 Sending agent_ready signal...')
      let readySent = false
      const sendReady = async () => {
        if (readySent) return
        await sendToFrontend({ type: 'agent_ready', provider, codingAgent })
      }
      // Keep sending every 2 seconds for 20 seconds total
      const readyInterval = setInterval(sendReady, 2000)
      await sendReady()
      setTimeout(() => {
        clearInterval(readyInterval)
        console.log('✅ agent_ready retries complete')
      }, 20000)

      // Mark as sent when user first speaks (no need to keep sending)
      session.on('input_speech_started' as any, () => {
        readySent = true
        clearInterval(readyInterval)
      })
      console.log('✅ agent_ready sent (with retries scheduled)')

      // Greet user
      const greeting = "Hey! I'm Osborn. What are you working on?"
      if (userVoiceArch === 'pipelined') {
        // Pipelined mode: Use session.say() with TTS
        try {
          console.log('👋 Sending greeting via TTS...')
          await (session as any).say(greeting)
          console.log('✅ Greeting sent')
        } catch (err) {
          console.log('⚠️ Greeting via TTS failed:', err)
        }
      } else if (provider !== 'gemini') {
        // Realtime mode: Only OpenAI supports generateReply
        try {
          await session.generateReply({
            userInput: `[Greet the user: "${greeting}"]`
          })
        } catch {
          console.log('⚠️ Greeting skipped (Gemini)')
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
    }
    console.log('⏳ Waiting for new user...\n')
  })

  room.on(RoomEvent.DataReceived, async (payload, participant, kind, topic) => {
    if (topic !== 'user-input') return

    try {
      const data = JSON.parse(new TextDecoder().decode(payload))
      console.log('📨 Data:', data.type)

      if (data.type === 'permission_response') {
        // Check pipelined mode agent pool first
        const slot = agentPool.find(s => s.handler.hasPendingPermission())
        if (slot) {
          slot.handler.respondToPermission(data.response)
          console.log(`✅ Permission (pipelined): ${data.response}`)
        }
        // Also check direct mode LLM
        const directLLM = (createDirectSession as any).currentLLM
        if (directLLM && directLLM.hasPendingPermission?.()) {
          const allow = data.response === 'allow' || data.response === 'always_allow'
          directLLM.respondToPermission(allow)
          console.log(`✅ Permission (direct): ${data.response}`)
        }
      } else if (data.type === 'user_text' && currentSession) {
        console.log(`📝 Text: "${data.content}"`)
        currentSession.interrupt()
        await currentSession.generateReply({ userInput: data.content })
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

    // Set localParticipant immediately after connection
    localParticipant = room.localParticipant
    console.log('✅ Connected to room:', roomName)

    console.log('\n⏳ Waiting for user to connect...')
    console.log(`   Room: ${roomCode}\n`)

    // Warm up agents in background (just the first Plan + Execute to save resources)
    console.log('🔥 Warming up agents...')
    const warmupPrompt = 'Say "ready" and nothing else.'
    Promise.all([
      planAgent1.handler.run(warmupPrompt)
        .then(() => console.log('✅ Plan agent 1 ready'))
        .catch((err) => console.log('⚠️ Plan agent warmup skipped:', err.message?.substring(0, 50) || 'error')),
      executeAgent.handler.run(warmupPrompt)
        .then(() => console.log('✅ Execute agent ready'))
        .catch((err) => console.log('⚠️ Execute agent warmup skipped:', err.message?.substring(0, 50) || 'error')),
    ]).catch(() => {})

    // Keep process alive
    await new Promise(() => {})

  } catch (err) {
    console.error('❌ Failed to connect:', err)
    process.exit(1)
  }
}

// Run
main().catch(console.error)
