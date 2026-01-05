/**
 * Conversation Brain - Gemini 2.5 Pro powered conversation manager
 *
 * This is the "smart brain" that:
 * 1. Keeps conversation alive with relevant questions
 * 2. Builds context until we understand what user wants
 * 3. Dispatches background research agents
 * 4. Receives progress updates and decides when to execute
 * 5. Handles direct commands immediately
 */

import { llm } from '@livekit/agents'
import * as google from '@livekit/agents-plugin-google'
import type { ClaudeHandler } from './claude-handler'

// ============================================================
// Types
// ============================================================

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: Date
}

export interface ResearchTask {
  id: string
  query: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  result?: string
  startedAt?: Date
  completedAt?: Date
}

export interface BrainDecision {
  action: 'speak' | 'research' | 'execute' | 'clarify' | 'direct_command'
  speech?: string           // What to say immediately
  researchQueries?: string[] // Background research to start
  executeTask?: string      // Task for execute agent (only when ready)
  directCommand?: string    // Simple command to run immediately
  reasoning?: string        // Why this decision
}

export interface BrainState {
  conversationHistory: ConversationMessage[]
  userGoal: string | null           // What we think user wants (building)
  userGoalConfidence: number        // 0-1 how confident we are
  pendingResearch: ResearchTask[]   // Background research running
  completedResearch: ResearchTask[] // Research results we have
  readyToExecute: boolean           // Do we have enough info?
  executionPlan: string | null      // The plan when ready
}

// ============================================================
// Conversation Brain Class
// ============================================================

export class ConversationBrain {
  private llm: google.LLM
  private state: BrainState
  private workingDir: string
  private onSpeak: (text: string) => Promise<void>
  private onStateChange: (state: string) => Promise<void>

  constructor(config: {
    workingDir: string
    onSpeak: (text: string) => Promise<void>
    onStateChange: (state: string) => Promise<void>
  }) {
    // Use Gemini 2.0 Flash for brain decisions - it's faster and less likely to conflict
    // with the Gemini Realtime voice session which uses a different model
    this.llm = new google.LLM({
      model: 'gemini-2.0-flash',
      // Set lower temperature for more consistent decisions
      temperature: 0.3,
    })

    // Add error handler to prevent unhandled rejection crashes
    this.llm.on('error', (err) => {
      const errorMsg = err.error?.message || String(err)
      // Only log non-abort errors
      if (!errorMsg.includes('aborted') && !errorMsg.includes('AbortError')) {
        console.error('🧠 [Brain LLM] Error:', errorMsg)
      }
    })

    this.workingDir = config.workingDir
    this.onSpeak = config.onSpeak
    this.onStateChange = config.onStateChange

    this.state = {
      conversationHistory: [],
      userGoal: null,
      userGoalConfidence: 0,
      pendingResearch: [],
      completedResearch: [],
      readyToExecute: false,
      executionPlan: null,
    }
  }

  /**
   * Process user input and decide what to do
   */
  async processUserInput(input: string): Promise<BrainDecision> {
    // Add to conversation history
    this.state.conversationHistory.push({
      role: 'user',
      content: input,
      timestamp: new Date(),
    })

    // Build the analysis prompt
    const prompt = this.buildAnalysisPrompt(input)

    let stream: ReturnType<typeof this.llm.chat> | null = null
    let streamError: Error | null = null

    try {
      // Call Gemini 2.5 Pro for decision
      const chatCtx = new llm.ChatContext()
      chatCtx.addMessage({ role: 'user', content: prompt })

      let response = ''
      stream = this.llm.chat({ chatCtx })

      // Create a promise that wraps the stream iteration with proper error handling
      const collectResponse = async (): Promise<string> => {
        let result = ''
        try {
          for await (const chunk of stream!) {
            if (chunk.delta?.content) {
              result += chunk.delta.content
            }
          }
        } catch (e) {
          streamError = e as Error
          throw e
        }
        return result
      }

      // Race the stream against a timeout to prevent hanging
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Brain timeout after 30s')), 30000)
      })

      response = await Promise.race([collectResponse(), timeoutPromise])

      // Parse the decision
      const decision = this.parseDecision(response)

      // Update state based on decision
      this.updateState(decision)

      // Add assistant response to history
      if (decision.speech) {
        this.state.conversationHistory.push({
          role: 'assistant',
          content: decision.speech,
          timestamp: new Date(),
        })
      }

      return decision

    } catch (err) {
      const errorMsg = (err as Error).message || String(err)
      // Only log if not an abort (which is expected when user interrupts)
      if (!errorMsg.includes('aborted')) {
        console.error('🧠 [Brain] Stream error:', errorMsg)
      }
      // Close stream if it exists to prevent further errors
      if (stream) {
        try {
          stream.close()
        } catch {}
      }
      return {
        action: 'speak',
        speech: "I'm having trouble processing that. Could you try again?",
      }
    }
  }

  /**
   * Receive research results from background agents
   */
  receiveResearchResult(taskId: string, result: string, success: boolean) {
    const task = this.state.pendingResearch.find(t => t.id === taskId)
    if (task) {
      task.status = success ? 'completed' : 'failed'
      task.result = result
      task.completedAt = new Date()

      // Move to completed
      this.state.pendingResearch = this.state.pendingResearch.filter(t => t.id !== taskId)
      this.state.completedResearch.push(task)

      console.log(`🧠 Research completed: ${taskId.substring(0, 8)}... (${this.state.completedResearch.length} done)`)
    }
  }

  /**
   * Check if we should provide a status update
   */
  shouldProvideUpdate(): boolean {
    // Provide update if research just completed
    return this.state.completedResearch.length > 0 &&
           this.state.pendingResearch.length === 0 &&
           !this.state.readyToExecute
  }

  /**
   * Generate a status update based on completed research
   */
  async generateStatusUpdate(): Promise<string | null> {
    if (this.state.completedResearch.length === 0) return null

    const researchSummary = this.state.completedResearch
      .map(r => `- ${r.query}: ${r.result?.substring(0, 200) || 'No result'}`)
      .join('\n')

    const prompt = `Based on completed research, provide a brief conversational status update.

RESEARCH RESULTS:
${researchSummary}

USER GOAL (so far): ${this.state.userGoal || 'Still understanding...'}

Generate a 1-2 sentence update that:
1. Summarizes what you learned
2. Either asks a clarifying question OR proposes next steps
3. Sounds natural and conversational

Just the update text, no JSON.`

    let stream: ReturnType<typeof this.llm.chat> | null = null

    try {
      const chatCtx = new llm.ChatContext()
      chatCtx.addMessage({ role: 'user', content: prompt })

      let response = ''
      stream = this.llm.chat({ chatCtx })

      for await (const chunk of stream) {
        if (chunk.delta?.content) {
          response += chunk.delta.content
        }
      }

      return response.trim()
    } catch (err) {
      console.error('🧠 [Brain] Status update error:', (err as Error).message || err)
      if (stream) {
        try {
          stream.close()
        } catch {}
      }
      return null
    }
  }

  /**
   * Get current state for debugging/display
   */
  getState(): BrainState {
    return { ...this.state }
  }

  /**
   * Reset conversation state
   */
  reset() {
    this.state = {
      conversationHistory: [],
      userGoal: null,
      userGoalConfidence: 0,
      pendingResearch: [],
      completedResearch: [],
      readyToExecute: false,
      executionPlan: null,
    }
  }

  // ============================================================
  // Private Methods
  // ============================================================

  private buildAnalysisPrompt(userInput: string): string {
    const recentHistory = this.state.conversationHistory.slice(-6)
      .map(m => `${m.role.toUpperCase()}: ${m.content}`)
      .join('\n')

    const researchContext = this.state.completedResearch.length > 0
      ? `\nCOMPLETED RESEARCH:\n${this.state.completedResearch.map(r => `- ${r.query}: ${r.result?.substring(0, 300)}`).join('\n')}`
      : ''

    const pendingContext = this.state.pendingResearch.length > 0
      ? `\nPENDING RESEARCH: ${this.state.pendingResearch.map(r => r.query).join(', ')}`
      : ''

    return `You are the brain of a voice AI coding assistant. Analyze this input and decide what to do.

WORKING DIRECTORY: ${this.workingDir}

CAPABILITIES:
- Full internet access (web search, fetch URLs, API calls)
- Read/write files in the working directory
- Run shell commands (npm, git, etc.)
- Search and analyze codebases

CONVERSATION HISTORY:
${recentHistory}

CURRENT USER INPUT: "${userInput}"

CURRENT UNDERSTANDING:
- User Goal: ${this.state.userGoal || 'Unknown - still gathering context'}
- Confidence: ${Math.round(this.state.userGoalConfidence * 100)}%
- Ready to Execute: ${this.state.readyToExecute}
${researchContext}
${pendingContext}

DECIDE WHAT TO DO:

1. DIRECT_COMMAND - If user gives a simple, clear command:
   - "read file X" → direct_command
   - "run npm test" → direct_command
   - "show me the package.json" → direct_command
   - "search the web for X" → direct_command
   - "look up X online" → direct_command

2. CLARIFY - If request is ambiguous, ask a specific question to understand better

3. RESEARCH - If we need more info, start background research (2-3 queries max)
   - Search codebase, read docs, explore files
   - Search the web for information
   - Keep conversation going while research runs

4. EXECUTE - ONLY if we have HIGH confidence (>80%) about what user wants
   - Must have clear plan
   - Only ONE execution task at a time

5. SPEAK - Just respond conversationally (greetings, status, etc.)

IMPORTANT: Keep speech SHORT and conversational. No markdown formatting.

Respond in JSON:
{
  "action": "speak" | "research" | "execute" | "clarify" | "direct_command",
  "speech": "What to say to user RIGHT NOW (keep it short, conversational, NO markdown)",
  "researchQueries": ["query1", "query2"],  // Only if action=research
  "executeTask": "detailed task description",  // Only if action=execute
  "directCommand": "simple command to run",  // Only if action=direct_command
  "updatedGoal": "What we think user wants now",
  "goalConfidence": 0.0-1.0,
  "reasoning": "Brief explanation"
}`
  }

  private parseDecision(response: string): BrainDecision {
    try {
      // Extract JSON from response
      const jsonMatch = response.match(/\{[\s\S]*\}/)
      if (!jsonMatch) {
        return {
          action: 'speak',
          speech: response.substring(0, 200),
        }
      }

      const parsed = JSON.parse(jsonMatch[0])

      // Update goal tracking
      if (parsed.updatedGoal) {
        this.state.userGoal = parsed.updatedGoal
      }
      if (typeof parsed.goalConfidence === 'number') {
        this.state.userGoalConfidence = parsed.goalConfidence
      }

      return {
        action: parsed.action || 'speak',
        speech: parsed.speech,
        researchQueries: parsed.researchQueries,
        executeTask: parsed.executeTask,
        directCommand: parsed.directCommand,
        reasoning: parsed.reasoning,
      }

    } catch (err) {
      console.error('Failed to parse brain decision:', err)
      return {
        action: 'speak',
        speech: "Let me think about that...",
      }
    }
  }

  private updateState(decision: BrainDecision) {
    // Track research tasks
    if (decision.action === 'research' && decision.researchQueries) {
      for (const query of decision.researchQueries) {
        this.state.pendingResearch.push({
          id: `research-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          query,
          status: 'pending',
        })
      }
    }

    // Mark ready to execute
    if (decision.action === 'execute') {
      this.state.readyToExecute = true
      this.state.executionPlan = decision.executeTask || null
    }
  }

  /**
   * Create research tasks for background agents
   */
  getPendingResearchTasks(): ResearchTask[] {
    return this.state.pendingResearch.filter(t => t.status === 'pending')
  }

  /**
   * Mark a research task as running
   */
  markResearchRunning(taskId: string) {
    const task = this.state.pendingResearch.find(t => t.id === taskId)
    if (task) {
      task.status = 'running'
      task.startedAt = new Date()
    }
  }
}

// ============================================================
// Factory function
// ============================================================

export function createConversationBrain(config: {
  workingDir: string
  onSpeak: (text: string) => Promise<void>
  onStateChange: (state: string) => Promise<void>
}): ConversationBrain {
  return new ConversationBrain(config)
}
