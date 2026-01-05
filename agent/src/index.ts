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
import { loadConfig, getMcpServers, getEnabledMcpServerNames, getVoiceMode, type VoiceMode } from './config.js'
import { createSTT, createTTS, createVAD, type VoiceIOConfig } from './voice-io.js'
import { createBridgeLLM, getBridgeInstructions, BridgeContext, createBridgeTools, type BridgeLLMConfig } from './bridge-llm.js'
import { createConversationBrain, type ConversationBrain, type BrainDecision, type ResearchTask } from './conversation-brain.js'
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
        await sendToFrontend({ type: 'assistant_response', text: result, source: 'run_code' })

        // Return a concise summary for the voice LLM
        const summary = result.length > 500
          ? result.substring(0, 500) + '... [truncated for voice]'
          : result
        return summary
      } catch (err) {
        const errorMsg = `Error: ${(err as Error).message}`
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
  // SMART BRAIN: Conversation Manager with Background Research
  // ============================================================
  // Uses Gemini 2.5 Pro to:
  // 1. Keep conversation alive with relevant questions
  // 2. Build context until we understand what user wants
  // 3. Dispatch background research agents (2-3 parallel)
  // 4. Decide when we have enough info to execute
  // 5. Handle direct commands immediately
  // ============================================================

  // Create the Conversation Brain (Gemini 2.5 Pro)
  const conversationBrain = createConversationBrain({
    workingDir,
    onSpeak: async (text) => {
      // This will be called when brain wants to say something
      speechQueue.push(text)
      processSpeechQueue()
    },
    onStateChange: async (state) => {
      await sendToFrontend({ type: 'agent_state', state })
    },
  })

  // Background research runner - uses Plan agents in parallel
  async function runBackgroundResearch(task: ResearchTask): Promise<void> {
    const planSlot = agentPool.find(s => s.role === 'plan' && !s.busy)
    if (!planSlot) {
      console.log(`⚠️ No available plan agent for research: ${task.query}`)
      conversationBrain.receiveResearchResult(task.id, 'No agent available', false)
      statusManager.completeTask(task.id, 'No agent available', false)
      return
    }

    // Register with status manager using the brain's task ID
    statusManager.registerTask(task.id, 'research', task.query)

    // Track in both systems
    conversationBrain.markResearchRunning(task.id)
    statusManager.markRunning(task.id)
    planSlot.busy = true
    planSlot.currentTask = task.query

    console.log(`🔍 [Research ${task.id.substring(0, 8)}] Starting: "${task.query}"`)
    await sendToFrontend({ type: 'system', text: `Researching: ${task.query.substring(0, 50)}...` })

    try {
      const result = await planSlot.handler.run(task.query)
      conversationBrain.receiveResearchResult(task.id, result, true)
      statusManager.completeTask(task.id, result, true)
      console.log(`✅ [Research ${task.id.substring(0, 8)}] Completed`)
    } catch (err) {
      const errorMsg = (err as Error).message
      conversationBrain.receiveResearchResult(task.id, errorMsg, false)
      statusManager.completeTask(task.id, errorMsg, false)
      console.log(`❌ [Research ${task.id.substring(0, 8)}] Failed:`, err)
    } finally {
      planSlot.busy = false
      planSlot.currentTask = null
    }
  }

  // Process brain decisions
  async function processBrainDecision(decision: BrainDecision): Promise<string> {
    console.log(`🧠 Decision: ${decision.action} - ${decision.reasoning || ''}`)

    switch (decision.action) {
      case 'direct_command':
        // Simple command - execute immediately via Plan agent
        if (decision.directCommand) {
          const slot = routeTask(decision.directCommand)
          slot.busy = true
          await sendToFrontend({ type: 'system', text: `Running: ${decision.directCommand.substring(0, 50)}...` })
          try {
            const result = await slot.handler.run(decision.directCommand)
            await sendToFrontend({ type: 'assistant_response', text: result, source: 'direct_command' })
            sharedContext.addAction(`Direct: ${decision.directCommand.substring(0, 30)}`)
            return result.length > 400 ? result.substring(0, 400) + '...' : result
          } finally {
            slot.busy = false
          }
        }
        // Send fallback speech to frontend
        const directSpeech = decision.speech || 'Done.'
        await sendToFrontend({ type: 'assistant_response', text: directSpeech, source: 'direct_command_ack' })
        return directSpeech

      case 'research': {
        // Start background research tasks and wait for completion
        if (decision.researchQueries) {
          const tasks = conversationBrain.getPendingResearchTasks()

          // Note: Brain already created task IDs. We'll use those IDs in statusManager.
          // Don't create duplicate tasks - the brain's task IDs will be used for tracking.

          // Send initial acknowledgment to frontend (Gemini will speak this)
          const ackSpeech = decision.speech || "Let me look into that..."
          await sendToFrontend({ type: 'assistant_response', text: ackSpeech, source: 'research_ack' })

          // Run all research tasks in parallel and wait for completion
          const researchPromises = tasks.map(task => runBackgroundResearch(task))
          await Promise.all(researchPromises)

          console.log(`✅ Research completed, generating voice summary...`)

          // Generate conversational summary - Gemini speaks tool return values
          const statusUpdate = await conversationBrain.generateStatusUpdate()
          if (statusUpdate) {
            await sendToFrontend({ type: 'assistant_response', text: statusUpdate, source: 'research_complete' })
            return statusUpdate  // Just the findings - Gemini speaks this
          }

          // Fallback: summarize raw results
          const brainState = conversationBrain.getState()
          if (brainState.completedResearch.length > 0) {
            const findings = brainState.completedResearch
              .map(r => r.result?.substring(0, 200) || '')
              .filter(r => r.length > 0)
              .join(' ')
            const summary = `Here's what I found: ${findings.substring(0, 350)}`
            await sendToFrontend({ type: 'assistant_response', text: summary, source: 'research_summary' })
            return summary
          }
          return "I looked into that but couldn't find specifics. Can you clarify?"
        }
        const researchSpeech = decision.speech || "Let me look into that..."
        await sendToFrontend({ type: 'assistant_response', text: researchSpeech, source: 'research_fallback' })
        return researchSpeech
      }

      case 'execute':
        // Full execution - use Execute agent (single writer)
        if (decision.executeTask) {
          const executeSlot = agentPool.find(s => s.role === 'execute')
          if (!executeSlot) {
            return "I'm ready to execute but the agent isn't available."
          }

          await sendToFrontend({ type: 'agent_state', state: 'thinking' })
          await sendToFrontend({ type: 'system', text: `Executing: ${decision.executeTask.substring(0, 50)}...` })
          executeSlot.busy = true
          executeSlot.currentTask = decision.executeTask

          try {
            console.log(`🚀 [Execute] Starting: "${decision.executeTask.substring(0, 60)}..."`)
            const result = await executeSlot.handler.run(decision.executeTask)
            await sendToFrontend({ type: 'assistant_response', text: result, source: 'execute' })
            sharedContext.addAction(`Execute: ${decision.executeTask.substring(0, 30)}`)
            console.log(`✅ [Execute] Completed`)
            return result.length > 400 ? result.substring(0, 400) + '...' : result
          } finally {
            executeSlot.busy = false
            executeSlot.currentTask = null
            await sendToFrontend({ type: 'agent_state', state: 'listening' })
          }
        }
        // Send fallback speech to frontend
        const executeSpeech = decision.speech || "Execution complete."
        await sendToFrontend({ type: 'assistant_response', text: executeSpeech, source: 'execute_ack' })
        return executeSpeech

      case 'clarify':
      case 'speak':
      default: {
        // Send speech to frontend for chat display
        const speech = decision.speech || "I'm here to help!"
        await sendToFrontend({ type: 'assistant_response', text: speech, source: 'speak' })
        return speech
      }
    }
  }

  // The main tool that Gemini Realtime calls
  // Key insight: Tool return values are given to the model but NOT automatically spoken.
  // We need to return text that the model will naturally want to speak aloud.
  // ALSO: We must explicitly send tool results to frontend since Gemini events may be unreliable
  const thinkAndDecideTool = llm.tool({
    description: `Use this for ANY user request that needs coding work.
Returns a response you should speak to the user.

IMPORTANT: The text returned from this tool is what you should say to the user.
Speak the returned text naturally - it contains the answer or status update.

Call this for:
- Complex requests ("help me add auth", "fix this bug")
- Questions about the code ("what does this do", "where is X")
- Direct commands ("read file X", "run npm test")
- ANY coding-related request

The tool handles research and execution, then returns what to tell the user.`,
    parameters: z.object({
      userInput: z.string().describe('What the user said'),
    }),
    execute: async ({ userInput }) => {
      console.log(`\n🧠 [Brain] Processing: "${userInput.substring(0, 80)}..."`)
      await sendToFrontend({ type: 'agent_state', state: 'thinking' })

      try {
        // Let the brain analyze and decide
        const decision = await conversationBrain.processUserInput(userInput)

        // Process the decision and get speakable result
        const result = await processBrainDecision(decision)

        // Format result for speech - ensure it's conversational
        const speakableResult = formatForSpeech(result, decision)

        console.log(`🔊 [Tool Result] "${speakableResult.substring(0, 100)}..."`)

        // IMPORTANT: Always send the tool result to frontend
        // This ensures the chat gets updated even if Gemini voice events don't fire
        await sendToFrontend({ type: 'assistant_response', text: speakableResult, source: 'tool_result' })

        return speakableResult

      } catch (err) {
        console.error(`❌ [Brain] Error:`, err)
        const errorMsg = "I ran into an issue processing that. Could you try rephrasing?"
        await sendToFrontend({ type: 'assistant_response', text: errorMsg, source: 'tool_error' })
        return errorMsg
      } finally {
        await sendToFrontend({ type: 'agent_state', state: 'listening' })
      }
    },
  })

  // Helper to format results for natural speech
  function formatForSpeech(result: string, decision: BrainDecision): string {
    // If decision has speech and we have additional results, combine them
    const speech = decision.speech || ''

    // If result is very long, summarize it
    if (result.length > 500) {
      // Extract key info for voice
      const lines = result.split('\n').filter(l => l.trim())
      const keyLines = lines.slice(0, 3).join('. ')
      return speech ? `${speech} ${keyLines}` : keyLines
    }

    // If result differs from speech, it likely has new info
    if (result !== speech && result.length > 0) {
      return result
    }

    return speech || "Done."
  }

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

  // Check status tool - allows Gemini to poll for background task updates
  const checkStatusTool = llm.tool({
    description: `Check the status of background research and tasks.
Call this tool when:
- User asks "how's it going?", "are you done?", "what did you find?"
- You want to check if background research has completed
- You need to provide an update on running tasks
- A few seconds have passed since starting a task

This returns current task status and any results ready to share.`,
    parameters: z.object({
      reason: z.string().optional().describe('Why checking status (for logging)'),
    }),
    execute: async ({ reason }) => {
      console.log(`📊 [Status Check] ${reason || 'Checking status...'}`)
      const status = statusManager.getStatusUpdate()

      // Log what we found
      if (status.hasUpdates) {
        console.log(`📊 [Status] Found ${status.completedTasks.length} completed tasks`)
      } else if (status.runningTasks.length > 0) {
        console.log(`📊 [Status] ${status.runningTasks.length} tasks still running`)
      }

      // Send status to frontend
      await sendToFrontend({ type: 'status_update', ...status })

      // Clear old completed tasks
      statusManager.clearReportedTasks()

      return status.summary
    },
  })

  // Dynamic instructions with working directory context
  const getInstructions = () => `You are Osborn, a friendly voice AI coding assistant.

WORKING DIRECTORY: ${workingDir}

PERSONALITY: Conversational, helpful, proactive.
- Keep responses SHORT (<50 words for voice)
- ALWAYS speak tool results to the user verbally
- Be specific about what you found
- Do NOT add markdown formatting like **bold** headers in your speech

CRITICAL: After ANY tool call completes, you MUST speak the result to the user.

CAPABILITIES:
- You have FULL INTERNET ACCESS via the coding agents
- You can search the web, fetch URLs, look up documentation
- You can read/write files, run commands, search code
- You can research topics, find information online, check APIs

TOOLS:
1. think_and_decide - For ANY request (coding, research, web search, questions). Returns findings you MUST speak.
2. run_code - For direct commands. Returns results you MUST speak.
3. check_status - For progress. Returns status you MUST speak.
4. respond_permission - For permission responses.

FLOW:
1. User asks → call appropriate tool
2. Tool returns result → SPEAK the result to user
3. Never stay silent after a tool completes

EXAMPLE:
User: "What's in the codebase?"
You: "Let me look." [calls think_and_decide]
Tool returns: "Found a React app with src/, components/, pages/"
You: "I found a React app with source, components, and pages folders. Want details?"

${sharedContext.getContextSummary() ? `CURRENT CONTEXT: ${sharedContext.getContextSummary()}` : ""}`

  const INSTRUCTIONS = getInstructions()

  // Voice agent class
  class OsbornVoiceAgent extends voice.Agent {
    constructor() {
      super({
        instructions: INSTRUCTIONS,
        tools: {
          run_code: runCodeTool,
          respond_permission: respondPermissionTool,
          think_and_decide: thinkAndDecideTool,
          check_status: checkStatusTool,
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
  // Bridge context for tracking conversation state
  const bridgeContext = new BridgeContext()

  async function createPipelinedSession(provider: string): Promise<voice.AgentSession> {
    // Configure pipeline based on provider choice:
    // OpenAI: OpenAI Whisper + GPT-4o + OpenAI TTS (all OpenAI - single API key)
    // Gemini: Groq Whisper + Gemini LLM + OpenAI TTS (uses Groq for fast STT, OpenAI for quality TTS)
    const isOpenAI = provider === 'openai'

    const sttProvider = isOpenAI ? 'openai-whisper' : 'groq-whisper'
    const llmProvider = isOpenAI ? 'gpt-4o' : 'gemini-pro'
    const ttsProvider = 'openai'  // OpenAI TTS for both (reliable, good quality)
    const ttsVoice = isOpenAI ? 'alloy' : 'nova'  // Different voices for each provider

    console.log(`📱 Using Pipelined Mode (${sttProvider} + ${llmProvider} + ${ttsProvider} TTS)`)

    const stt = createSTT({
      provider: sttProvider,
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

    // Get settings from participant metadata
    let provider = defaultProvider
    let userVoiceArch: 'realtime' | 'pipelined' = voiceMode // Default to config
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
    currentVoiceArch = userVoiceArch
    currentCodingAgent = codingAgent
    console.log(`🎯 Provider: ${provider}, Voice: ${userVoiceArch}, Agent: ${codingAgent}`)

    if (codingAgent === 'codex') {
      codexHandler = new CodexHandler({ workingDirectory: workingDir })
    }

    // Create voice session based on user's voice architecture choice
    let session: voice.AgentSession
    if (userVoiceArch === 'pipelined') {
      session = await createPipelinedSession(provider)
    } else {
      const model = createRealtimeModel(provider)
      session = new voice.AgentSession({ llm: model })
    }
    currentSession = session

    // Track last transcript to avoid duplicates
    let lastTranscript = ''
    let lastSentTranscript = ''

    session.on('user_input_transcribed' as any, (ev: any) => {
      const transcript = ev.transcript || ''
      // Only log if it's different and substantial (avoid incremental updates)
      if (transcript && transcript !== lastTranscript && transcript.length > lastTranscript.length + 3) {
        console.log(`📝 User: "${transcript}"`)
        lastTranscript = transcript
      }
    })

    // Send final transcript when user stops speaking
    session.on('user_speech_committed' as any, (ev: any) => {
      const transcript = ev.transcript || ev.text || lastTranscript
      if (transcript && transcript !== lastSentTranscript) {
        console.log(`📝 User (final): "${transcript}"`)
        sendToFrontend({ type: 'user_transcript', text: transcript })
        lastSentTranscript = transcript
        lastTranscript = ''
      }
    })

    // For Gemini realtime, send transcript when user state changes from speaking to listening
    session.on('user_state_changed' as any, (ev: any) => {
      console.log(`👤 User state: ${ev.oldState} → ${ev.newState}`)
      // When user stops speaking, send the accumulated transcript
      if (ev.oldState === 'speaking' && ev.newState === 'listening' && lastTranscript && lastTranscript !== lastSentTranscript) {
        console.log(`📝 User (state change): "${lastTranscript}"`)
        sendToFrontend({ type: 'user_transcript', text: lastTranscript })
        lastSentTranscript = lastTranscript
        // Don't clear lastTranscript yet - might need it for retry
      }
    })

    // Backup: also listen to input_speech_stopped
    session.on('input_speech_stopped' as any, (ev: any) => {
      // If there's a final transcript in the event, use it
      const transcript = ev.transcript || ev.text
      if (transcript && transcript.length > 0 && transcript !== lastSentTranscript) {
        console.log(`📝 User (stopped): "${transcript}"`)
        sendToFrontend({ type: 'user_transcript', text: transcript })
        lastSentTranscript = transcript
        lastTranscript = ''
      }
    })

    // Capture agent speech for chat display
    let currentAgentMessage = ''
    let lastSentAgentMessage = ''

    session.on('agent_speech_started' as any, (ev: any) => {
      console.log(`🔊 Agent speaking...`, JSON.stringify(ev || {}).substring(0, 200))
      currentAgentMessage = ev.text || ev.message || ev.content || ''
    })

    session.on('agent_speech_committed' as any, (ev: any) => {
      const message = ev.text || ev.message || ev.content || currentAgentMessage
      console.log(`💬 Agent committed: "${message?.substring(0, 100)}..."`)
      if (message && message !== lastSentAgentMessage) {
        sendToFrontend({ type: 'assistant_response', text: message })
        lastSentAgentMessage = message
      }
      currentAgentMessage = ''
    })

    // Also capture from playout completed (for Gemini realtime)
    session.on('playout_completed' as any, (ev: any) => {
      const message = ev.message || ev.text || ev.content
      console.log(`💬 Playout completed: "${message?.substring(0, 100)}..."`)
      if (message && message.length > 0 && message !== lastSentAgentMessage) {
        sendToFrontend({ type: 'assistant_response', text: message })
        lastSentAgentMessage = message
      }
    })

    // Capture agent state change to speaking -> listening (agent finished speaking)
    session.on('agent_state_changed' as any, (ev: any) => {
      agentState = ev.newState
      console.log(`🤖 State: ${ev.newState}`)
      sendToFrontend({ type: 'agent_state', state: ev.newState })

      // When agent finishes speaking, check if we have a message to send
      if (ev.oldState === 'speaking' && ev.newState === 'listening' && currentAgentMessage && currentAgentMessage !== lastSentAgentMessage) {
        console.log(`💬 Agent (state change): "${currentAgentMessage.substring(0, 100)}..."`)
        sendToFrontend({ type: 'assistant_response', text: currentAgentMessage })
        lastSentAgentMessage = currentAgentMessage
        currentAgentMessage = ''
      }

      if (ev.newState === 'listening' && speechQueue.length > 0) {
        processSpeechQueue()
      }
    })

    // Try to capture any transcript/message events
    session.on('transcript' as any, (ev: any) => {
      console.log(`📜 Transcript event:`, JSON.stringify(ev || {}).substring(0, 300))
      const text = ev.text || ev.transcript || ev.message
      if (text && ev.role === 'assistant' && text !== lastSentAgentMessage) {
        sendToFrontend({ type: 'assistant_response', text })
        lastSentAgentMessage = text
      }
    })

    // Capture conversation item added (works for both OpenAI and Gemini)
    session.on('conversation_item_added' as any, (ev: any) => {
      console.log(`📝 Conversation item:`, JSON.stringify(ev || {}).substring(0, 300))

      if (ev.item?.role === 'assistant') {
        // Handle different content formats:
        // Gemini: content is array of strings ["text"]
        // OpenAI: content is array of objects [{type: "text", text: "..."}]
        let text = ''
        if (Array.isArray(ev.item.content)) {
          if (typeof ev.item.content[0] === 'string') {
            // Gemini format: ["string1", "string2"]
            text = ev.item.content.join('\n')
          } else if (ev.item.content[0]?.text) {
            // OpenAI format: [{text: "..."}]
            text = ev.item.content.map((c: any) => c.text).join('\n')
          }
        } else if (typeof ev.item.content === 'string') {
          text = ev.item.content
        } else if (ev.item.text) {
          text = ev.item.text
        }

        if (text && text !== lastSentAgentMessage) {
          console.log(`💬 Agent (conv item): "${text.substring(0, 100)}..."`)
          sendToFrontend({ type: 'assistant_response', text })
          lastSentAgentMessage = text
        }
      } else if (ev.item?.role === 'user') {
        // Also capture user messages from conversation items
        let text = ''
        if (Array.isArray(ev.item.content)) {
          if (typeof ev.item.content[0] === 'string') {
            text = ev.item.content.join('\n')
          } else if (ev.item.content[0]?.text) {
            text = ev.item.content.map((c: any) => c.text).join('\n')
          }
        } else if (typeof ev.item.content === 'string') {
          text = ev.item.content
        }

        if (text && text !== lastSentTranscript) {
          console.log(`📝 User (conv item): "${text.substring(0, 100)}..."`)
          sendToFrontend({ type: 'user_transcript', text })
          lastSentTranscript = text
        }
      }
    })

    // Listen for input audio transcription completed (Gemini)
    session.on('input_audio_transcription_completed' as any, (ev: any) => {
      console.log(`📜 Input transcription completed:`, JSON.stringify(ev || {}).substring(0, 300))
      const transcript = ev.transcript || ev.text
      if (transcript && transcript !== lastSentTranscript) {
        console.log(`📝 User (transcription): "${transcript}"`)
        sendToFrontend({ type: 'user_transcript', text: transcript })
        lastSentTranscript = transcript
      }
    })

    // Listen for output audio transcription completed (agent speech text)
    session.on("output_audio_transcription_completed" as any, (ev: any) => {
      console.log(`📜 Output transcription completed:`, JSON.stringify(ev || {}).substring(0, 300))
      const text = ev.transcript || ev.text
      if (text && text !== lastSentAgentMessage) {
        console.log(`💬 Agent (output transcription):`, text.substring(0, 100))
        sendToFrontend({ type: "assistant_response", text })
        lastSentAgentMessage = text
      }
    })


    // Debug: Log additional session events to find the right ones for Gemini
    const debugEvents = [
      'agent_started_speaking',
      'agent_stopped_speaking',
      'response_content_added',
      'response_done',
      'conversation_updated',
      'metrics_collected'
    ]
    for (const eventName of debugEvents) {
      session.on(eventName as any, (ev: any) => {
        console.log(`🔍 [${eventName}]:`, JSON.stringify(ev || {}).substring(0, 200))
      })
    }

    // Also capture from function call results
    session.on('function_calls_collected' as any, (ev: any) => {
      console.log(`🔧 Function calls:`, ev)
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
