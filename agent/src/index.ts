import { type JobContext, ServerOptions, cli, defineAgent, llm, voice } from '@livekit/agents'
import * as openai from '@livekit/agents-plugin-openai'
import * as google from '@livekit/agents-plugin-google'
import { z } from 'zod'
import { fileURLToPath } from 'url'
import 'dotenv/config'

import { ClaudeHandler, type PermissionRequestEvent, type PermissionResponse } from './claude-handler.js'
import { CodexHandler } from './codex-handler.js'

// Type for coding agent selection
type CodingAgent = 'claude' | 'codex'

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

// Pre-initialize Claude handler at module load (before any connections)
console.log('🔥 Pre-initializing Claude Code...')
const claude = new ClaudeHandler({
  workingDirectory: '/Users/newupgrade/Desktop/Developer/osborn',
  permissionMode: 'default', // Ask for permission on dangerous tools (Bash, Write, Edit)
})

// Listen for permission requests from Claude
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
})

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
  description: `Execute coding tasks using the coding agent. Use for:
- Files: read, write, create, edit, list, search
- Directories: current directory, list contents
- Code: fix bugs, refactor, explain, review
- Terminal: run commands, install packages, git
- Project: analyze codebase, make changes
- Web: search the web for information`,
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

// Agent instructions - dynamically includes available tools
const OSBORN_INSTRUCTIONS = `You are Osborn, a voice-enabled AI assistant with coding superpowers.
Keep responses under 50 words. Sound natural and human.

AVAILABLE CAPABILITIES via run_code tool:
- Read, Write, Edit, MultiEdit files
- Glob (find files by pattern), Grep (search content)
- Bash (run terminal commands)
- WebSearch (search the web), WebFetch (fetch URLs)
- NotebookEdit (edit Jupyter notebooks)
- Task (delegate complex tasks), TodoWrite (track tasks)
- LSP (code intelligence - go to definition, find references)

WHEN TO USE run_code:
- File operations (read, write, create, edit, list, find)
- Code tasks (fix, refactor, explain, review, debug)
- Terminal commands (run, install, test, build, git)
- Web searches (look up documentation, APIs, errors)
- Project analysis (understand codebase, find patterns)

WHEN TO RESPOND DIRECTLY:
- Greetings and small talk
- General knowledge questions
- Clarifying what the user wants

PERMISSION HANDLING:
When the coding agent needs permission, you MUST:
1. Tell the user: "[Agent] wants to [action]. Allow, deny, or always allow?"
2. When they respond, call respond_permission with their choice

Be conversational and helpful. Ask follow-up questions when needed.`

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
      model: 'gemini-2.5-flash-native-audio-preview-12-2025', // From official docs
      voice: 'Puck',
      instructions: OSBORN_INSTRUCTIONS,
    })
    console.log('✅ Gemini model created with gemini-2.5-flash-native-audio-preview-12-2025')
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
        workingDirectory: '/Users/newupgrade/Desktop/Developer/osborn',
      })
      console.log('✅ Codex handler ready')
    }

    // Create model based on user's choice
    const model = createModel(provider)

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
  },
})

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }))
