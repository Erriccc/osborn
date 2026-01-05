/**
 * Bridge LLM Module - Layer 2 of Three-Layer Architecture
 * Handles conversation management, context bridging, and tool routing
 *
 * This layer sits between voice I/O and the coding agents:
 * - Manages greetings and acknowledgments
 * - Summarizes coding results for voice output
 * - Routes tasks to appropriate coding agent
 * - Handles permission flows
 */

import { llm } from '@livekit/agents'
import * as google from '@livekit/agents-plugin-google'
import * as openai from '@livekit/agents-plugin-openai'
import { z } from 'zod'
import type { ClaudeHandler } from './claude-handler'

export interface BridgeLLMConfig {
  provider: 'gemini-pro' | 'gemini-flash' | 'gpt-4o' | 'gpt-4o-mini'
  model?: string
}

/**
 * Create Bridge LLM instance
 * Recommended: Gemini 2.5 Pro (smart, good reasoning, cheaper than GPT-4o)
 * Alternative: Gemini Flash (faster but less reliable)
 */
export function createBridgeLLM(config: BridgeLLMConfig) {
  switch (config.provider) {
    case 'gemini-pro':
      // Gemini 2.5 Pro - smart model for complex reasoning
      return new google.LLM({
        model: config.model || 'gemini-2.5-pro',
      })

    case 'gemini-flash':
      // Gemini 2.0 Flash - fast model for quick responses
      return new google.LLM({
        model: config.model || 'gemini-2.0-flash',
      })

    case 'gpt-4o':
      return new openai.LLM({
        model: config.model || 'gpt-4o',
      })

    case 'gpt-4o-mini':
      return new openai.LLM({
        model: config.model || 'gpt-4o-mini',
      })

    default:
      throw new Error(`Unknown Bridge LLM provider: ${config.provider}`)
  }
}

/**
 * Generate system instructions for the Bridge LLM
 */
export function getBridgeInstructions(workingDir: string, contextSummary?: string): string {
  return `You are Osborn, a voice AI coding assistant.

WORKING DIRECTORY: ${workingDir}

YOUR ROLE: Bridge between user voice and coding agents.
You receive transcribed speech and respond conversationally while delegating coding tasks.

RESPONSIBILITIES:
1. GREETINGS: When session starts, greet naturally ("Hey! What are you working on today?")
2. ACKNOWLEDGMENTS: Confirm tasks before executing ("Got it, let me check that for you")
3. SUMMARIZATION: Convert technical results into brief, conversational voice responses
4. PERMISSION HANDLING: Clearly explain what needs permission and why
5. CONTEXT TRACKING: Remember what user is working on across the conversation

TOOLS AVAILABLE:
- run_code: Execute ALL coding tasks. Use this for:
  - Reading files ("read package.json")
  - Writing/editing code ("fix the bug", "add a function")
  - Running commands ("npm test", "git status")
  - Searching code ("find where X is defined")
  - Research ("explain this code")

- manage_permission: Handle permission responses from user
  - Use when user says "yes", "allow", "deny", etc.

RESPONSE STYLE:
- Keep voice responses under 100 words
- Be conversational, not robotic
- Always acknowledge before starting work
- Summarize technical output for voice (don't read raw code aloud)
- Ask clarifying questions when needed
${contextSummary ? `\nCURRENT CONTEXT: ${contextSummary}` : ''}`
}

/**
 * Shared context for tracking conversation and coding state
 */
export class BridgeContext {
  private recentActions: string[] = []
  private discoveredFiles: string[] = []
  private currentFocus: string | null = null
  private conversationSummary: string = ''

  addAction(action: string) {
    this.recentActions.push(action)
    if (this.recentActions.length > 5) this.recentActions.shift()
  }

  addFile(file: string) {
    if (!this.discoveredFiles.includes(file)) {
      this.discoveredFiles.push(file)
      if (this.discoveredFiles.length > 10) this.discoveredFiles.shift()
    }
  }

  setFocus(focus: string) {
    this.currentFocus = focus
  }

  updateSummary(summary: string) {
    this.conversationSummary = summary
  }

  getSummary(): string {
    const parts: string[] = []
    if (this.currentFocus) parts.push(`Focus: ${this.currentFocus}`)
    if (this.recentActions.length > 0) {
      parts.push(`Recent: ${this.recentActions.slice(-3).join(', ')}`)
    }
    if (this.discoveredFiles.length > 0) {
      parts.push(`Files: ${this.discoveredFiles.slice(-5).join(', ')}`)
    }
    return parts.join(' | ')
  }

  toJSON() {
    return {
      recentActions: this.recentActions,
      discoveredFiles: this.discoveredFiles,
      currentFocus: this.currentFocus,
      conversationSummary: this.conversationSummary,
    }
  }
}

/**
 * Create tools for the Bridge LLM
 */
export function createBridgeTools(
  planAgent: ClaudeHandler,
  executeAgent: ClaudeHandler,
  context: BridgeContext,
  routeTask: (task: string) => { handler: ClaudeHandler; role: string }
) {
  const runCodeTool = llm.tool({
    description: `Execute coding tasks by delegating to specialized agents.
Use this for: reading files, writing code, running commands, searching code, explaining code.
The task will be automatically routed to the right agent (Plan for reading, Execute for writing).`,
    parameters: z.object({
      task: z.string().describe('The coding task to execute'),
    }),
    execute: async ({ task }) => {
      const slot = routeTask(task)
      context.setFocus(task.substring(0, 50))
      context.addAction(`${slot.role}: ${task.substring(0, 30)}`)

      try {
        const result = await slot.handler.run(task)

        // Extract file references from result
        const fileMatches = result.match(/(?:\/[\w\-\.\/]+|src\/[\w\-\.\/]+|\.\/[\w\-\.\/]+)/g)
        if (fileMatches) {
          fileMatches.slice(0, 3).forEach(f => context.addFile(f))
        }

        // Summarize for voice (Bridge LLM will further summarize if needed)
        if (result.length > 800) {
          return result.substring(0, 800) + '\n\n[Result truncated for voice summary]'
        }
        return result
      } catch (err) {
        return `Error: ${(err as Error).message}`
      }
    },
  })

  const managePermissionTool = llm.tool({
    description: `Handle permission responses from user.
Call this when user responds to a permission request with: yes, allow, deny, no, always allow, etc.`,
    parameters: z.object({
      response: z.enum(['allow', 'deny', 'always_allow']).describe('The permission response'),
    }),
    execute: async ({ response }) => {
      // Check both agents for pending permissions
      for (const agent of [planAgent, executeAgent]) {
        if (agent.hasPendingPermission()) {
          const pending = agent.getPendingPermission()
          agent.respondToPermission(response as any)
          return `Permission ${response} granted for ${pending?.toolName || 'operation'}.`
        }
      }
      return 'No pending permission request found.'
    },
  })

  const getContextTool = llm.tool({
    description: 'Get current conversation and coding context',
    parameters: z.object({}),
    execute: async () => {
      return JSON.stringify(context.toJSON(), null, 2)
    },
  })

  return {
    run_code: runCodeTool,
    manage_permission: managePermissionTool,
    get_context: getContextTool,
  }
}

/**
 * Default Bridge LLM configuration
 * Using Gemini 2.5 Pro for smart conversation management
 */
export const DEFAULT_BRIDGE_CONFIG: BridgeLLMConfig = {
  provider: 'gemini-pro',
  model: 'gemini-2.5-pro',
}
