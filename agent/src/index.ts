import { type JobContext, ServerOptions, cli, defineAgent, llm, voice } from '@livekit/agents'
import * as openai from '@livekit/agents-plugin-openai'
import * as google from '@livekit/agents-plugin-google'
import { z } from 'zod'
import { fileURLToPath } from 'url'
import 'dotenv/config'

import { ClaudeHandler, type PermissionRequestEvent, type PermissionResponse } from './claude-handler.js'
import { CodexHandler } from './codex-handler.js'
import { loadConfig, getMcpServers, getEnabledMcpServerNames } from './config.js'

// Type for coding agent selection
type CodingAgent = 'claude' | 'codex'

// Parse CLI arguments for room code
function parseArgs(): { roomCode?: string } {
  const args = process.argv.slice(2)
  let roomCode: string | undefined

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--room' && args[i + 1]) {
      roomCode = args[i + 1]
    }
  }

  return { roomCode }
}

const cliArgs = parseArgs()
if (cliArgs.roomCode) {
  console.log(`🔗 Room code provided: ${cliArgs.roomCode}`)
}

// Global error handlers to catch silent failures
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection:', reason)
})

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error)
})

// Default provider (can be overridden by participant metadata)
const DEFAULT_PROVIDER = process.env.LLM_PROVIDER || 'openai'

// Debug mode
const DEBUG = process.env.DEBUG_LIVEKIT === 'true'
if (DEBUG) {
  console.log('🐛 Debug logging enabled')
}

console.log(`🤖 Default LLM Provider: ${DEFAULT_PROVIDER}`)

// Load configuration from ~/.osborn/config.yaml
console.log('📁 Loading configuration...')
const config = loadConfig()
const mcpServers = getMcpServers(config)
const enabledMcpNames = getEnabledMcpServerNames(config)

if (enabledMcpNames.length > 0) {
  console.log(`🔌 Enabled MCP servers: ${enabledMcpNames.join(', ')}`)
}

// ============================================================
// MULTI-AGENT POOL - 2 Claude handlers for parallel work
// ============================================================
const workingDir = config.workingDirectory || process.cwd()
console.log(`📂 Working directory: ${workingDir}`)

interface AgentSlot {
  id: number
  handler: ClaudeHandler
  busy: boolean
  currentTask: string | null
  context: string[] // Recent conversation context
}

// Create pool of 2 Claude agents
console.log('🔥 Pre-initializing Claude Code agents (x2)...')
const agentPool: AgentSlot[] = [1, 2].map(id => ({
  id,
  handler: new ClaudeHandler({
    workingDirectory: workingDir,
    permissionMode: 'default',
    mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
  }),
  busy: false,
  currentTask: null,
  context: [],
}))

// Get an available agent, or the least busy one
function getAvailableAgent(): AgentSlot {
  const free = agentPool.find(a => !a.busy)
  if (free) return free
  // All busy - return first one (will queue)
  console.log('⚠️ All agents busy, queuing on agent 1')
  return agentPool[0]
}

// Track current provider for API-specific behavior
let currentProvider = 'openai'

// Queue for messages to speak (permissions, status updates)
const speechQueue: string[] = []
let isSpeaking = false

// Process speech queue - speak next message when idle
async function processSpeechQueue() {
  if (isSpeaking || speechQueue.length === 0 || !currentSession) return
  if (currentProvider === 'gemini') {
    // Gemini doesn't support generateReply - just log
    while (speechQueue.length > 0) {
      console.log(`🔊 [Gemini] ${speechQueue.shift()}`)
    }
    return
  }

  isSpeaking = true
  const message = speechQueue.shift()!

  try {
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), 5000)
    )
    await Promise.race([
      currentSession.generateReply({ userInput: message }),
      timeout
    ])
  } catch (err) {
    console.log(`⚠️ Could not speak: ${message.substring(0, 50)}...`)
  } finally {
    isSpeaking = false
    // Process next in queue
    if (speechQueue.length > 0) {
      setTimeout(processSpeechQueue, 500)
    }
  }
}

// Queue permission request to be spoken
function speakPermissionRequest(toolName: string, description: string) {
  const message = `[SYSTEM: Tell user] I need permission to ${description}. Say yes, no, or always allow.`
  speechQueue.push(message)
  console.log(`🔊 Queued permission: ${toolName}`)
  processSpeechQueue()
}

// Speak status updates (streaming feedback)
let quietMode = false
let lastStatusTime = 0
const STATUS_THROTTLE_MS = 5000 // Throttle to every 5s

function speakStatus(status: string) {
  if (quietMode) return
  const now = Date.now()
  if (now - lastStatusTime < STATUS_THROTTLE_MS) {
    console.log(`🔇 [Throttled] ${status}`)
    return
  }
  lastStatusTime = now

  const message = `[STATUS - say briefly: ${status}]`
  speechQueue.push(message)
  console.log(`🔊 Queued status: ${status}`)
  processSpeechQueue()
}

// Setup event handlers for each agent
agentPool.forEach(slot => {
  const agent = slot.handler

  // Permission requests
  agent.on('permission_request', (req: PermissionRequestEvent) => {
    console.log(`\n⚠️ [Agent ${slot.id}] PERMISSION REQUIRED: ${req.toolName}`)
    sendToFrontend({
      type: 'permission_request',
      toolName: req.toolName,
      description: req.description,
      agentId: slot.id,
    })
    speakPermissionRequest(req.toolName, req.description)
  })

  // Tool use - streaming feedback
  agent.on('tool_use', (tool: any) => {
    console.log(`🔧 [Agent ${slot.id}] Using: ${tool.name}`)
    const statusMsg = getToolStatusMessage(tool.name, tool.input)
    if (statusMsg) {
      sendToFrontend({ type: 'status', agentId: slot.id, message: statusMsg })
      speakStatus(statusMsg)
    }
  })

  // Tool results
  agent.on('tool_result', (result: any) => {
    console.log(`✅ [Agent ${slot.id}] Done: ${result.name || 'tool'}`)
  })

  // Text output
  agent.on('text', (text: string) => {
    if (text.length > 0) {
      console.log(`💬 [Agent ${slot.id}]: ${text.substring(0, 100)}...`)
    }
  })

  // Errors
  agent.on('error', (err: any) => {
    console.error(`❌ [Agent ${slot.id}] Error:`, err)
  })
})

// Convert tool usage to human-readable status
function getToolStatusMessage(toolName: string, input: any): string | null {
  switch (toolName) {
    case 'Read':
      return `Reading ${input?.file_path?.split('/').pop() || 'file'}`
    case 'Write':
      return `Writing to ${input?.file_path?.split('/').pop() || 'file'}`
    case 'Edit':
      return `Editing ${input?.file_path?.split('/').pop() || 'file'}`
    case 'Glob':
      return `Searching for ${input?.pattern || 'files'}`
    case 'Grep':
      return `Searching for "${input?.pattern?.substring(0, 20) || 'pattern'}"`
    case 'Bash':
      const cmd = input?.command?.substring(0, 30) || 'command'
      return `Running: ${cmd}`
    case 'WebSearch':
      return `Searching web for "${input?.query?.substring(0, 30) || 'query'}"`
    case 'WebFetch':
      return `Fetching ${input?.url?.substring(0, 40) || 'URL'}`
    case 'Task':
      return `Starting sub-task`
    default:
      return null // Don't announce every tool
  }
}

// Pre-warm both agents
console.log('🔥 Warming up agents...')
Promise.all(agentPool.map(slot =>
  slot.handler.run('Respond with just: ready')
    .then(() => console.log(`✅ Agent ${slot.id} ready!`))
    .catch(err => console.log(`⚠️ Agent ${slot.id} warm-up failed:`, err.message))
))

// Track job context and session for data channel
let jobContext: JobContext | null = null
let currentSession: voice.AgentSession | null = null

// Track the current coding handler (can be Claude or Codex)
let currentCodingAgent: CodingAgent = 'claude'
let codexHandler: CodexHandler | null = null

// Helper to cleanup previous session before starting new one
async function cleanupSession() {
  if (currentSession) {
    console.log('🧹 Cleaning up previous session...')
    try {
      currentSession.removeAllListeners()
      // Close session gracefully if method exists
      if (typeof (currentSession as any).close === 'function') {
        await (currentSession as any).close()
      }
    } catch (err) {
      console.log('⚠️ Session cleanup error (non-fatal):', (err as Error).message)
    }
    currentSession = null
  }
}

// Helper to send data to frontend
async function sendToFrontend(data: object) {
  if (!jobContext) return
  try {
    const encoder = new TextEncoder()
    const payload = encoder.encode(JSON.stringify(data))
    await jobContext.room.localParticipant?.publishData(payload, {
      reliable: true,
      topic: 'osborn-updates',
    })
  } catch (err) {
    // Ignore send errors
  }
}

// Define the run_code tool (works with both Claude and Codex)
const runCodeTool = llm.tool({
  description: `Execute coding tasks using the coding agent.
IMPORTANT: Before calling this tool, ALWAYS say "Got it" or "On it" first so the user knows you heard them.
Use for: file operations, code tasks, terminal commands, web searches, project analysis.`,
  parameters: z.object({
    task: z.string().describe('The coding task to execute'),
  }),
  execute: async ({ task }) => {
    // Check for quiet mode trigger
    if (task.toLowerCase().includes('let me know when done') ||
        task.toLowerCase().includes('tell me when finished')) {
      quietMode = true
      console.log('🤫 Quiet mode enabled')
    }
    if (task.toLowerCase().includes('keep me updated') ||
        task.toLowerCase().includes('give me updates')) {
      quietMode = false
      console.log('🔊 Updates enabled')
    }

    // Get available agent from pool
    const slot = getAvailableAgent()
    const agentName = currentCodingAgent === 'claude' ? `Claude ${slot.id}` : 'Codex'
    console.log(`\n🔨 [Agent ${slot.id}] Task: "${task}"`)
    await sendToFrontend({ type: 'system', text: `Agent ${slot.id} working on: ${task}`, agentId: slot.id })

    // Mark agent as busy
    slot.busy = true
    slot.currentTask = task

    try {
      let result: string
      if (currentCodingAgent === 'codex' && codexHandler) {
        result = await codexHandler.run(task)
      } else {
        // Add context from recent conversation
        const contextPrefix = slot.context.length > 0
          ? `Context from conversation: ${slot.context.slice(-3).join(' | ')}\n\nTask: `
          : ''
        result = await slot.handler.run(contextPrefix + task)
      }

      // Store task in context for future reference
      slot.context.push(`Task: ${task.substring(0, 50)} → Done`)
      if (slot.context.length > 10) slot.context.shift()

      console.log(`✅ [Agent ${slot.id}] Done: ${result.length} chars`)
      await sendToFrontend({ type: 'assistant_response', text: result, agentId: slot.id })
      return result
    } catch (err) {
      console.error(`❌ [Agent ${slot.id}] Error:`, err)
      return `Error: ${(err as Error).message}`
    } finally {
      slot.busy = false
      slot.currentTask = null
    }
  },
})

// Define the permission response tool
const respondPermissionTool = llm.tool({
  description: `Respond to a pending permission request from Claude Code.
Use this ONLY when there is a pending permission request.
Call this after hearing the user's response to a permission prompt.`,
  parameters: z.object({
    response: z.enum(['allow', 'deny', 'always_allow']).describe(
      'The user response: "allow" for one-time approval, "deny" to reject, "always_allow" to permanently allow this tool type'
    ),
  }),
  execute: async ({ response }) => {
    // Find agent with pending permission
    const slotWithPending = agentPool.find(s => s.handler.hasPendingPermission())
    if (!slotWithPending) {
      return 'No pending permission request.'
    }
    const pending = slotWithPending.handler.getPendingPermission()
    slotWithPending.handler.respondToPermission(response as PermissionResponse)
    await sendToFrontend({
      type: 'permission_response',
      response,
      toolName: pending?.toolName,
      agentId: slotWithPending.id
    })
    return `Permission ${response} for ${pending?.toolName || 'tool'}.`
  },
})

// Agent instructions - optimized for fast, natural responses
const OSBORN_INSTRUCTIONS = `You are Osborn, a voice-enabled AI coding assistant.

RESPONSE STYLE:
- Keep responses SHORT (under 70 words unless explaining code)
- Sound natural and conversational
- Say "Got it" or "On it" immediately when given a task, THEN work on it
- Ask clarifying questions if the request is ambiguous

CAPABILITIES (via run_code tool):
- Files: read, write, edit, search, find
- Code: fix bugs, refactor, explain, review
- Terminal: run commands, git, install packages
- Web: search documentation, APIs, errors

PERMISSION HANDLING:
When you receive a permission request, you MUST:
1. Immediately tell the user what action needs permission
2. Ask: "Should I allow this, deny it, or always allow?"
3. Listen for their response (yes/allow, no/deny, always)
4. Call respond_permission with their choice

VOICE RESPONSES TO PERMISSIONS:
- "yes", "yeah", "allow", "go ahead", "do it" → call respond_permission with "allow"
- "no", "deny", "don't", "stop" → call respond_permission with "deny"
- "always", "always allow", "trust" → call respond_permission with "always_allow"

Be helpful and proactive. If something fails, explain why briefly.`

// Voice assistant with tools
class OsbornAssistant extends voice.Agent {
  constructor() {
    super({
      instructions: OSBORN_INSTRUCTIONS,
      tools: {
        run_code: runCodeTool,
        respond_permission: respondPermissionTool,
      },
    })
  }
}

// Create the appropriate model based on provider
function createModel(provider: string) {
  if (provider === 'gemini') {
    console.log('📱 Using Gemini Live API')
    console.log('🔑 GOOGLE_API_KEY:', process.env.GOOGLE_API_KEY ? 'set' : 'NOT SET')
    // From official docs: https://docs.livekit.io/agents/models/realtime/plugins/gemini/
    // Package v1.0.31 uses google.beta.realtime (not google.realtime yet)
    const model = new google.beta.realtime.RealtimeModel({
      model: 'gemini-2.5-flash-native-audio-preview',
      voice: 'Puck',
      // Instructions tell Gemini to greet proactively
      instructions: OSBORN_INSTRUCTIONS + `

IMPORTANT: When the session starts and you hear the user connect (even silence),
immediately greet them with: "Hey, I'm Osborn, ready to help with coding. What are you working on?"
Don't wait for them to speak first.`,
    })
    console.log('✅ Gemini model created')
    return model
  } else {
    console.log('📱 Using OpenAI Realtime API')
    console.log('🔑 OPENAI_API_KEY:', process.env.OPENAI_API_KEY ? 'set' : 'NOT SET')
    const model = new openai.realtime.RealtimeModel({
      voice: 'alloy',
    })
    console.log('✅ OpenAI model created')
    return model
  }
}

// Helper to get provider from participant metadata
function getProviderFromParticipant(metadata?: string): string {
  if (!metadata) return DEFAULT_PROVIDER
  try {
    const data = JSON.parse(metadata)
    return data.provider || DEFAULT_PROVIDER
  } catch {
    return DEFAULT_PROVIDER
  }
}

// Helper to get coding agent from participant metadata
function getCodingAgentFromParticipant(metadata?: string): CodingAgent {
  if (!metadata) return 'claude'
  try {
    const data = JSON.parse(metadata)
    return data.codingAgent || 'claude'
  } catch {
    return 'claude'
  }
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    console.log('🚀 Agent starting for room:', ctx.room.name)

    // If room code was provided via CLI, validate room name
    if (cliArgs.roomCode) {
      const expectedRoom = `osborn-${cliArgs.roomCode}`
      if (ctx.room.name !== expectedRoom) {
        console.log(`⏭️ Skipping room ${ctx.room.name} (waiting for ${expectedRoom})`)
        return // Don't handle this room
      }
      console.log(`✅ Room matches expected: ${expectedRoom}`)
    }

    jobContext = ctx

    // Note: Agent event handlers are set up in agentPool initialization above

    // Connect FIRST so we can wait for participants
    console.log('📡 Connecting to room...')
    await ctx.connect()
    console.log('✅ Connected to room')

    // Wait for a participant to join using LiveKit's built-in method
    console.log('⏳ Waiting for participant...')
    const participant = await ctx.waitForParticipant()

    console.log('👤 Participant joined:', participant.identity)
    console.log('📋 Participant metadata:', participant.metadata)
    const provider = getProviderFromParticipant(participant.metadata)
    const codingAgent = getCodingAgentFromParticipant(participant.metadata)
    console.log(`🎯 User selected provider: ${provider}`)
    console.log(`🔧 User selected coding agent: ${codingAgent}`)

    // Set the current provider for API-specific behavior
    currentProvider = provider

    // Set the current coding agent and initialize if needed
    currentCodingAgent = codingAgent
    if (codingAgent === 'codex') {
      console.log('🔧 Initializing Codex handler...')
      codexHandler = new CodexHandler({
        workingDirectory: workingDir,
      })
      console.log('✅ Codex handler ready')
    }

    // Create model based on user's choice
    const model = createModel(provider)

    // Clean up any previous session before creating new one
    await cleanupSession()

    const session = new voice.AgentSession({
      llm: model,
    })
    currentSession = session

    // Add session event listeners for debugging
    // Using string literals as AgentSessionEventTypes is not directly exported
    session.on('user_state_changed' as any, (ev: any) => {
      console.log(`👤 User state: ${ev.oldState} → ${ev.newState}`)
    })
    session.on('agent_state_changed' as any, (ev: any) => {
      console.log(`🤖 Agent state: ${ev.oldState} → ${ev.newState}`)
      // When agent becomes idle (listening), process speech queue
      if (ev.newState === 'listening' && !isSpeaking) {
        setTimeout(processSpeechQueue, 300)
      }
    })
    session.on('user_input_transcribed' as any, (ev: any) => {
      console.log(`📝 Transcribed: "${ev.transcript}" (final: ${ev.isFinal})`)
    })
    session.on('error' as any, (ev: any) => {
      console.error('❌ Session error:', ev.error)
    })
    session.on('close' as any, (ev: any) => {
      console.log('🚪 Session closed:', ev.reason)
    })

    ctx.room.on('trackSubscribed', (track, publication, p) => {
      console.log(`📥 Track subscribed: ${track.kind} from ${p.identity}`)
    })

    ctx.room.on('participantDisconnected', async (p) => {
      console.log(`👋 Participant disconnected: ${p.identity}`)
      // Clean up session when user disconnects to prepare for next connection
      await cleanupSession()
    })

    // Listen for data channel messages from frontend
    ctx.room.on('dataReceived', async (payload, participant, kind, topic) => {
      if (topic === 'user-input') {
        try {
          const data = JSON.parse(new TextDecoder().decode(payload))
          console.log(`📨 Received from frontend:`, data)

          if (data.type === 'permission_response') {
            // Handle permission response from UI - find agent with pending permission
            const slotWithPending = agentPool.find(s => s.handler.hasPendingPermission())
            if (slotWithPending) {
              slotWithPending.handler.respondToPermission(data.response)
              console.log(`✅ Permission ${data.response} from UI for Agent ${slotWithPending.id}`)
            }
          } else if (data.type === 'user_text') {
            // Handle text input from frontend
            console.log(`📝 Text input: "${data.content}"`)
            // Inject text into the session as user input
            if (currentSession) {
              try {
                // Interrupt any current speech first
                currentSession.interrupt()
                // Generate a reply to the text input
                await currentSession.generateReply({
                  userInput: data.content,
                })
                console.log(`✅ Injected text to session`)
              } catch (err) {
                console.error(`❌ Failed to inject text:`, err)
              }
            }
          }
        } catch (e) {
          // Not JSON, ignore
        }
      }
    })

    // Create the agent
    const agent = new OsbornAssistant()

    // Start session
    console.log('🎬 Starting voice session...')
    const startTime = Date.now()
    await session.start({
      agent,
      room: ctx.room,
    })
    console.log(`✅ Session started in ${Date.now() - startTime}ms with ${provider.toUpperCase()} + Claude tools`)
    console.log('🎤 Ready for voice input! Speak to start.')

    // Greet user immediately so they know it's working
    // Note: Gemini doesn't support generateReply well, so we skip for now
    if (provider !== 'gemini') {
      try {
        const timeout = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 5000)
        )
        await Promise.race([
          session.generateReply({
            userInput: '[SYSTEM: Greet the user briefly. Say "Hey, I\'m Osborn, ready to help. What are you working on?"]'
          }),
          timeout
        ])
        console.log('👋 Greeting sent')
      } catch (err) {
        console.log('⚠️ Greeting skipped (timeout or unsupported)')
      }
    } else {
      console.log('👋 Gemini ready - waiting for user to speak first')
    }
  },
})

// Configure server options
const serverOptions: any = {
  agent: fileURLToPath(import.meta.url),
}

// If room code is provided, filter to only handle that room
if (cliArgs.roomCode) {
  const targetRoom = `osborn-${cliArgs.roomCode}`
  console.log(`🎯 Filtering for room: ${targetRoom}`)
  // The agent will be dispatched to rooms matching this pattern
  serverOptions.workerOptions = {
    // Note: Room filtering is handled by LiveKit dispatch
    // For local development, we validate the room in the entry function
  }
}

cli.runApp(new ServerOptions(serverOptions))
