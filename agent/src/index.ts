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

// Pre-initialize Claude handler at module load (before any connections)
console.log('🔥 Pre-initializing Claude Code...')
const workingDir = config.workingDirectory || process.cwd()
const claude = new ClaudeHandler({
  workingDirectory: workingDir,
  permissionMode: 'default', // Ask for permission on dangerous tools (Bash, Write, Edit)
  mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
})

console.log(`📂 Working directory: ${workingDir}`)

// Listen for permission requests from Claude - will be handled by speakPermissionRequest
claude.on('permission_request', (req: PermissionRequestEvent) => {
  console.log(`\n⚠️ PERMISSION REQUIRED ⚠️`)
  console.log(`🔧 Tool: ${req.toolName}`)
  console.log(`📝 Action: ${req.description}`)
  console.log(`⏳ Waiting for user response (say: allow, deny, or always allow)...`)
  // Send to frontend for UI display
  sendToFrontend({
    type: 'permission_request',
    toolName: req.toolName,
    description: req.description,
  })
  // Speak the permission request through the voice agent
  speakPermissionRequest(req.toolName, req.description)
})

// Speak permission requests through voice
async function speakPermissionRequest(toolName: string, description: string) {
  if (!currentSession) return
  try {
    // Interrupt current speech and ask for permission
    currentSession.interrupt()
    const message = `I need permission to ${description}. Should I allow this, deny it, or always allow ${toolName}?`
    await currentSession.generateReply({ userInput: `[SYSTEM: Ask user for permission] ${message}` })
  } catch (err) {
    console.error('Failed to speak permission request:', err)
  }
}

// Pre-warm Claude immediately on server start
claude.run('Respond with just: ready')
  .then(() => console.log('✅ Claude pre-warmed and ready!'))
  .catch((err) => console.log('⚠️ Pre-warm failed:', err.message))

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
    const agentName = currentCodingAgent === 'claude' ? 'Claude Code' : 'OpenAI Codex'
    console.log(`\n🔨 ${agentName}: "${task}"`)
    await sendToFrontend({ type: 'system', text: `Working on: ${task}` })

    try {
      let result: string
      if (currentCodingAgent === 'codex' && codexHandler) {
        result = await codexHandler.run(task)
      } else {
        result = await claude.run(task)
      }
      console.log(`✅ Done: ${result.length} chars`)
      await sendToFrontend({ type: 'assistant_response', text: result })
      return result
    } catch (err) {
      console.error('❌ Error:', err)
      return `Error: ${(err as Error).message}`
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
    if (!claude.hasPendingPermission()) {
      return 'No pending permission request.'
    }
    const pending = claude.getPendingPermission()
    claude.respondToPermission(response as PermissionResponse)
    await sendToFrontend({
      type: 'permission_response',
      response,
      toolName: pending?.toolName
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
      instructions: OSBORN_INSTRUCTIONS,
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

    // Claude verbose logging
    claude.on('tool_use', (tool) => {
      console.log(`\n🔧 Claude Tool Started: ${tool.name}`)
      if (tool.input) {
        const inputStr = JSON.stringify(tool.input).substring(0, 200)
        console.log(`   Input: ${inputStr}${inputStr.length >= 200 ? '...' : ''}`)
      }
    })
    claude.on('tool_result', (result) => {
      console.log(`✅ Claude Tool Completed: ${result.name || 'unknown'}`)
    })
    claude.on('text', (text) => {
      if (text.length > 0) {
        console.log(`💬 Claude says: ${text.substring(0, 100)}${text.length > 100 ? '...' : ''}`)
      }
    })
    claude.on('error', (err) => {
      console.error(`❌ Claude Error:`, err)
    })

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
            // Handle permission response from UI
            if (claude.hasPendingPermission()) {
              claude.respondToPermission(data.response)
              console.log(`✅ Permission ${data.response} from UI`)
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
    try {
      await session.generateReply({
        userInput: '[SYSTEM: Greet the user briefly. Say something like "Hey, I\'m Osborn, ready to help with coding. What are you working on?"]'
      })
      console.log('👋 Greeting sent')
    } catch (err) {
      console.error('Failed to send greeting:', err)
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
