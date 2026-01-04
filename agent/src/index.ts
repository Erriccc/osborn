import { llm, voice, initializeLogger } from '@livekit/agents'
import * as openai from '@livekit/agents-plugin-openai'
import * as google from '@livekit/agents-plugin-google'
import { Room, RoomEvent, RemoteParticipant, LocalParticipant, DataPacketKind } from '@livekit/rtc-node'
import { AccessToken } from 'livekit-server-sdk'
import { z } from 'zod'
import 'dotenv/config'

// Initialize logger before anything else
initializeLogger({ pretty: true, level: 'info' })

import { ClaudeHandler, type PermissionRequestEvent, type PermissionResponse } from './claude-handler.js'
import { CodexHandler } from './codex-handler.js'
import { loadConfig, getMcpServers, getEnabledMcpServerNames } from './config.js'

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
process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled Rejection:', reason)
})

process.on('uncaughtException', (error) => {
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

  // Default provider
  const defaultProvider = cliArgs.provider || process.env.LLM_PROVIDER || 'openai'
  console.log(`🎯 Default voice provider: ${defaultProvider}`)

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

  // Plan Agent - Read-only, research
  const planAgent: AgentSlot = {
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

  // Execute Agent - Full access
  const executeAgent: AgentSlot = {
    id: 2,
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

  const agentPool: AgentSlot[] = [planAgent, executeAgent]

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
        if (executeAgent.busy && !planAgent.busy) {
          return planAgent
        }
        return executeAgent
      }
    }

    return planAgent.busy ? executeAgent : planAgent
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
  let currentCodingAgent: CodingAgent = 'claude'
  let codexHandler: CodexHandler | null = null
  let localParticipant: LocalParticipant | null = null
  let agentState = 'initializing'

  // Speech queue
  const speechQueue: string[] = []
  let isSpeaking = false

  // Helper to send data to frontend
  async function sendToFrontend(data: object) {
    if (!localParticipant) {
      console.log('⚠️ sendToFrontend: no localParticipant!')
      return
    }
    try {
      const encoder = new TextEncoder()
      const payload = encoder.encode(JSON.stringify(data))
      await localParticipant.publishData(payload, {
        reliable: true,
        topic: 'osborn-updates',
      })
      console.log(`📤 Sent to frontend: ${(data as any).type}`)
    } catch (err) {
      console.error('❌ sendToFrontend error:', err)
    }
  }

  // Process speech queue
  async function processSpeechQueue() {
    if (isSpeaking || speechQueue.length === 0 || !currentSession) return
    if (agentState !== 'listening') return
    if (currentProvider === 'gemini') {
      // Gemini doesn't support generateReply
      while (speechQueue.length > 0) {
        console.log(`🔊 [Would say] ${speechQueue.shift()}`)
      }
      return
    }

    isSpeaking = true
    const message = speechQueue.shift()!

    try {
      await Promise.race([
        currentSession.generateReply({ userInput: message }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
      ])
    } catch {
      // Ignore speech errors
    } finally {
      isSpeaking = false
      if (speechQueue.length > 0) {
        setTimeout(processSpeechQueue, 500)
      }
    }
  }

  // Setup agent event handlers
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

    slot.handler.on('tool_use', (tool: any) => {
      console.log(`🔧 [${slot.role}] Using: ${tool.name}`)
    })

    slot.handler.on('error', (err: any) => {
      console.error(`❌ [${slot.role}] Error:`, err)
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
      const slot = routeTask(task)
      console.log(`\n🔨 [${slot.role}] Task: "${task}"`)
      await sendToFrontend({ type: 'system', text: `${slot.role} agent: ${task}` })

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
        await sendToFrontend({ type: 'assistant_response', text: result })

        // Return a concise summary for the voice LLM
        const summary = result.length > 500
          ? result.substring(0, 500) + '... [truncated for voice]'
          : result
        return summary
      } catch (err) {
        return `Error: ${(err as Error).message}`
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

  // Shared context that both voice and coding agents contribute to
  const sharedContext = {
    recentActions: [] as string[],
    discoveredFiles: [] as string[],
    currentFocus: null as string | null,
    addAction(action: string) {
      this.recentActions.push(action)
      if (this.recentActions.length > 5) this.recentActions.shift()
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
  const getInstructions = () => `You are Osborn, a voice AI coding assistant.

WORKING DIRECTORY: ${workingDir}

STYLE: Keep responses SHORT (under 70 words). Sound natural. Say "Got it" when given a task.

CAPABILITIES (via run_code tool):
- Read/write/edit files, search codebase
- Run terminal commands (npm, git, etc)
- Fix bugs, refactor, explain code
- Search web/docs for solutions

TWO AGENTS AVAILABLE:
- Plan Agent: Research, explore, read files (fast, no permissions needed)
- Execute Agent: Write code, make changes (asks permission for writes)

${sharedContext.getContextSummary() ? `CONTEXT: ${sharedContext.getContextSummary()}` : ''}

PERMISSIONS: When you hear permission request, tell user what needs permission and ask "allow, deny, or always allow?" Then call respond_permission.`

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

  // Create voice model
  function createModel(provider: string) {
    if (provider === 'gemini') {
      console.log('📱 Using Gemini Live API')
      return new google.beta.realtime.RealtimeModel({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        voice: 'Puck',
        instructions: INSTRUCTIONS,
      })
    } else {
      console.log('📱 Using OpenAI Realtime API')
      return new openai.realtime.RealtimeModel({
        voice: 'alloy',
      })
    }
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

    // Get provider from participant metadata
    let provider = defaultProvider
    let codingAgent: CodingAgent = 'claude'

    if (participant.metadata) {
      try {
        const meta = JSON.parse(participant.metadata)
        provider = meta.provider || defaultProvider
        codingAgent = meta.codingAgent || 'claude'
      } catch {}
    }

    currentProvider = provider
    currentCodingAgent = codingAgent
    console.log(`🎯 Provider: ${provider}, Agent: ${codingAgent}`)

    if (codingAgent === 'codex') {
      codexHandler = new CodexHandler({ workingDirectory: workingDir })
    }

    // Create voice session
    const model = createModel(provider)
    const session = new voice.AgentSession({ llm: model })
    currentSession = session

    // Session events
    session.on('agent_state_changed' as any, (ev: any) => {
      agentState = ev.newState
      console.log(`🤖 State: ${ev.newState}`)
      if (ev.newState === 'listening' && speechQueue.length > 0) {
        processSpeechQueue()
      }
    })

    session.on('user_input_transcribed' as any, (ev: any) => {
      console.log(`📝 User: "${ev.transcript}"`)
    })

    session.on('user_state_changed' as any, (ev: any) => {
      console.log(`👤 User state: ${ev.oldState} → ${ev.newState}`)
    })

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
      await session.start({
        agent,
        room,
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
      session.on('input_speech_started', () => {
        readySent = true
        clearInterval(readyInterval)
      })
      console.log('✅ agent_ready sent (with retries scheduled)')

      // Greet user (OpenAI only)
      if (provider !== 'gemini') {
        try {
          await session.generateReply({
            userInput: '[Greet the user: "Hey, I\'m Osborn. What are you working on?"]'
          })
        } catch {
          console.log('⚠️ Greeting skipped')
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
        const slot = agentPool.find(s => s.handler.hasPendingPermission())
        if (slot) {
          slot.handler.respondToPermission(data.response)
          console.log(`✅ Permission: ${data.response}`)
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

    // Warm up agents in background
    console.log('🔥 Warming up agents...')
    Promise.all([
      planAgent.handler.run('ready').then(() => console.log('✅ Plan agent ready')),
      executeAgent.handler.run('ready').then(() => console.log('✅ Execute agent ready')),
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
