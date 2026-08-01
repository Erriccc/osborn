/**
 * Claude LLM Wrapper for LiveKit Agents
 *
 * Wraps the Claude Agent SDK (@anthropic-ai/claude-agent-sdk) to work
 * with LiveKit's AgentSession as an LLM provider.
 *
 * Flow: User speaks → STT → ClaudeLLM (Agent SDK) → TTS → User hears
 */

import { llm, shortuuid, DEFAULT_API_CONNECT_OPTIONS, type APIConnectOptions } from '@livekit/agents'
import { query, type Options, type McpServerConfig, type SDKMessage, type SDKUserMessage, type Query as SDKQuery } from '@anthropic-ai/claude-agent-sdk'
import { EventEmitter } from 'events'
import { saveSessionMetadata, getSessionWorkspace } from './config.js'
import { getResearchSystemPrompt, getDirectModeResearchPrompt } from './prompts.js'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

// Directory of this module — used to locate co-located prompt files (e.g., turn-shape reminder).
const __claudeLlmDir = dirname(fileURLToPath(import.meta.url))
const TURN_SHAPE_REMINDER_PATH = join(__claudeLlmDir, 'prompts', 'turn-shape-reminder.md')

// ≤3 direct tool call budget per turn. Reset on every UserPromptSubmit (new user message).
// Enforced mechanically in PreToolUse — the model CANNOT exceed this regardless of JSONL history.
// Task/Agent delegations are exempt (delegation is what we WANT). Sub-agent tool calls
// (agent_type !== null) are exempt (they're inside a delegation). Only the main orchestrator
// agent's direct tool calls count against the budget.
let turnToolCallCount = 0
const TOOL_CALL_BUDGET = 3

export interface ClaudeLLMOptions {
  workingDirectory?: string      // cwd for Claude Code (where it reads/writes/runs commands)
  sessionBaseDir?: string        // where .osborn/sessions/ lives (defaults to workingDirectory)
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions'
  allowedTools?: string[]
  eventEmitter?: EventEmitter
  resumeSessionId?: string
  continueSession?: boolean
  mcpServers?: Record<string, McpServerConfig>
  model?: string  // Claude model ID (default: claude-sonnet-4-6)
  voiceMode?: 'direct' | 'realtime'  // Which voice pipeline — controls system prompt selection
  skipTTSQueue?: boolean  // When true, emit 'tts_say' events instead of queue.put() — for session.say() bypass
  onCompactionEvent?: (event:
    | { type: 'compaction_started'; trigger?: string }
    | { type: 'compaction_progress'; stage: string; detail?: string }
    | { type: 'compaction_complete'; skillsWritten?: number; skillNames?: string[]; trigger?: string }
  ) => void
  // Per-user named agents (DB-backed, sent by the frontend via set_agents).
  // When set, used INSTEAD of the built-in NAMED_AGENTS at query creation.
  // SDK constraint: agents are fixed once query() starts — changes apply on
  // the next session (cold start / resume / switch), not mid-session.
  agents?: Record<string, { description: string; prompt: string; tools?: string[]; model?: string }>
}

/**
 * Strip markdown formatting for TTS (text-to-speech)
 * Removes **bold**, ##headers, ```code```, etc. so TTS doesn't read them literally
 */
function stripMarkdownForTTS(text: string): string {
  return text
    // Remove code blocks (``` ... ```)
    .replace(/```[\s\S]*?```/g, ' [code block] ')
    // Remove inline code (` ... `)
    .replace(/`([^`]+)`/g, '$1')
    // Remove bold (**text** or __text__)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    // Remove italic (*text* or _text_) - be careful not to match bullet points
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1')
    .replace(/(?<!_)_([^_]+)_(?!_)/g, '$1')
    // Remove headers (# ## ### etc)
    .replace(/^#{1,6}\s+/gm, '')
    // Remove bullet points but keep content
    .replace(/^[\s]*[-*+]\s+/gm, '')
    // Remove numbered lists but keep content
    .replace(/^[\s]*\d+\.\s+/gm, '')
    // Remove horizontal rules
    .replace(/^[-*_]{3,}$/gm, '')
    // Remove links [text](url) -> text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Remove images ![alt](url)
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    // Remove blockquotes
    .replace(/^>\s+/gm, '')
    // Clean up multiple spaces/newlines
    .replace(/\n{3,}/g, '\n\n')
    .replace(/  +/g, ' ')
    .trim()
}


/**
 * Load skill files from agent/.claude/skills/{name}/SKILL.md
 * Injects into system prompt so Claude sees them as available capabilities.
 * Skills execute via Bash — no SDK settingSources needed.
 */
function loadSkillsFromDir(agentDir: string): string {
  const skillsDir = join(agentDir, '.claude', 'skills')
  if (!existsSync(skillsDir)) return ''

  const skills: string[] = []
  try {
    for (const skillName of readdirSync(skillsDir)) {
      const skillFile = join(skillsDir, skillName, 'SKILL.md')
      if (existsSync(skillFile)) {
        skills.push(readFileSync(skillFile, 'utf-8').trim())
      }
    }
  } catch (err) {
    console.warn('⚠️ Failed to load skills:', err)
  }

  if (skills.length === 0) return ''
  console.log(`📚 Loaded ${skills.length} skill(s) from ${skillsDir}`)
  return `<available-skills>\n${skills.join('\n\n---\n\n')}\n</available-skills>`
}

/**
 * Loads skills from both ~/.claude/skills/ (home dir) and {workingDir}/.claude/skills/ (project dir).
 * Merges results, deduplicating by skill directory name — home dir wins on conflicts.
 * Returns a combined <available-skills> XML block, or '' if no skills found.
 */
function loadAllSkills(_workingDir: string): string {
  // Single source of truth: ~/.claude/skills/
  // Defaults are seeded into this dir by the provisioning bootstrap (sprites.ts
  // buildOsbornBootstrap + Dockerfile.sandbox entrypoint). PostCompact writes
  // newly-learned skills here too. By unifying on one path we avoid the older
  // confusion where defaults loaded from node_modules/osborn/.claude/skills/
  // while PostCompact wrote to home — meaning learnings were second-class.
  const homeSkillsDir = join(homedir(), '.claude', 'skills')
  if (!existsSync(homeSkillsDir)) {
    console.log(`📚 No skills dir at ${homeSkillsDir} — bootstrap may not have run yet`)
    return ''
  }

  const skillMap = new Map<string, string>()
  try {
    for (const skillName of readdirSync(homeSkillsDir)) {
      const skillFile = join(homeSkillsDir, skillName, 'SKILL.md')
      if (existsSync(skillFile)) {
        skillMap.set(skillName, readFileSync(skillFile, 'utf-8').trim())
      }
    }
  } catch (err) {
    console.warn('⚠️ Failed to load skills from', homeSkillsDir, ':', err)
  }

  if (skillMap.size === 0) return ''
  console.log(`📚 Loaded ${skillMap.size} skill(s) from ${homeSkillsDir}`)
  return `<available-skills>\n${[...skillMap.values()].join('\n\n---\n\n')}\n</available-skills>`
}

// Research mode tools — full research capabilities
// Named sub-agents — the orchestrator delegates to these specialists. Each has
// a specific role, model, and tool set. Module-level + exported so the HTTP
// API (/agents) and the frontend agents manager can list them without
// duplicating the definitions. The query options reference this same object.
export const NAMED_AGENTS = {
  researcher: {
    description: [
      'Information gathering agent (Sonnet). Use for: codebase exploration, web research,',
      'finding patterns, reading multiple files, searching for examples.',
      'Returns structured findings — does NOT make decisions or edit files.',
      'Use this for ANY task that needs more than 2 tool calls to gather information.',
    ].join(' '),
    tools: ['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch', 'Task'],
    model: 'sonnet',
    prompt: [
      'You are Osborn\'s research agent. Your job is information gathering — thorough, structured, factual.',
      '',
      '## Your role',
      'Gather information the main agent needs to answer the user\'s question or make a decision.',
      'You are a scout — go find things, read them carefully, and report back.',
      '',
      '## How to work',
      '1. Understand what information is needed and why.',
      '2. Search broadly first (Glob, Grep, WebSearch), then read deeply (Read specific files).',
      '3. For large investigations, use the Task tool to run parallel searches.',
      '4. Cap yourself at 5-8 tool calls unless the task clearly requires more.',
      '',
      '## What to return',
      'Structured findings with specifics:',
      '- File paths and line numbers where you found relevant code',
      '- Exact values, configs, versions — not paraphrases',
      '- Direct quotes from documentation or web sources',
      '- What you looked for but did NOT find (negative results matter)',
      '',
      '## What NOT to do',
      '- Do NOT make recommendations or decisions — just surface facts',
      '- Do NOT edit or write any files',
      '- Do NOT run destructive commands (no rm, no git push, no npm publish)',
      '- If you need clarification, ask the main agent — it will relay to the user if needed',
    ].join('\n'),
  },
  reasoner: {
    description: [
      'Deep reasoning agent (Opus). Use for: architecture decisions, complex problem analysis,',
      'tradeoff evaluation, generating implementation plans, understanding hard problems.',
      'Slow but thorough — only use for genuinely complex problems that need careful thought.',
      'Does NOT edit files — returns a clear plan for the writer agent to execute.',
    ].join(' '),
    tools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
    model: 'opus',
    prompt: [
      'You are Osborn\'s reasoning agent. Your job is deep analysis, architectural thinking, and decision-making.',
      '',
      '## Your role',
      'Think hard about complex problems. Consider multiple approaches. Identify risks and edge cases.',
      'Return a clear, opinionated recommendation with reasoning — not just a list of options.',
      '',
      '## How to work',
      '1. Read and understand the full context before forming an opinion.',
      '2. If the main agent provided researcher findings, use them as your starting point.',
      '3. Consider at least 2-3 alternative approaches before recommending one.',
      '4. Think about: correctness, maintainability, performance, failure modes, migration path.',
      '5. Use Read/Grep to verify assumptions against the actual codebase when relevant.',
      '',
      '## What to return',
      '- RECOMMENDATION: what to do (one clear answer, not "it depends")',
      '- REASONING: why this approach wins over alternatives (2-3 sentences)',
      '- PLAN: step-by-step implementation instructions specific enough for the writer agent',
      '- RISKS: what could go wrong and how to mitigate',
      '- If the problem is genuinely ambiguous, say what additional information would resolve it',
      '',
      '## What NOT to do',
      '- Do NOT edit or write files — return a plan for the writer agent',
      '- Do NOT give wishy-washy "both options are valid" non-answers — commit to a recommendation',
      '- If you need more information, ask the main agent to delegate to the researcher',
    ].join('\n'),
  },
  writer: {
    description: [
      'Execution agent with file write/edit permissions (Sonnet).',
      'Handles ALL file operations: code, config, docs, scripts, data files.',
      'VERIFY-FIRST workflow: checks assumptions before making changes, runs tests after.',
      'If anything is unclear, asks the main agent for clarification before touching files.',
    ].join(' '),
    tools: ['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Glob', 'Grep', 'NotebookRead', 'NotebookEdit'],
    model: 'sonnet',
    prompt: [
      'You are Osborn\'s writer agent. You execute file changes with a verify-first approach.',
      '',
      '## Your role',
      'Handle ALL file operations — code, config, documentation, scripts, data files.',
      'You are the only agent that writes. The main agent and reasoner produce plans; you execute them.',
      '',
      '## VERIFY-FIRST workflow (mandatory)',
      '',
      '### Step 1: Verify assumptions',
      '1. Read the files you\'re about to modify. Confirm they match what the plan expects.',
      '2. If the plan references specific code patterns, grep to confirm they exist.',
      '3. If applicable, run the current test suite or build to confirm the starting state works.',
      '4. If ANYTHING has drifted from the plan (file moved, code refactored, dependency changed):',
      '   STOP and report back to the main agent. Do NOT improvise.',
      '',
      '### Step 2: Clarify unknowns',
      '1. If the plan is vague or ambiguous — ask the main agent a specific clarifying question.',
      '   Examples: "Which config format — YAML or JSON?", "New file or extend existing auth.ts?"',
      '2. The main agent will answer from context or relay to the user.',
      '3. Do NOT guess. One clear question is better than a wrong assumption.',
      '4. Restate what you will do before doing it: which files, what changes, in what order.',
      '',
      '### Step 3: Execute changes',
      '- Make ONLY the changes described in the plan.',
      '- Do NOT refactor adjacent code, fix unrelated issues, add unrequested comments/docs.',
      '- If you hit an unexpected issue, STOP and report to the main agent.',
      '',
      '### Step 4: Verify results',
      '1. Run tests if available (npm test, pytest, cargo test, etc.).',
      '2. Run the build if applicable (npm run build, tsc --noEmit, etc.).',
      '3. If tests or build fail: attempt to fix the issue you introduced. Re-run.',
      '4. Report: files changed, what changed in each, test results, any failures.',
    ].join('\n'),
  },
}

const RESEARCH_TOOLS = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'Bash', 'WebSearch', 'WebFetch',
  'LSP', 'Task', 'TodoWrite',
]

/**
 * Pushable async iterable — allows pushing SDKUserMessages into a query's
 * streaming input. The query subprocess stays alive between pushes (no JSONL replay).
 */
class MessageChannel<T> {
  #queue: T[] = []
  #waiting: ((value: IteratorResult<T>) => void) | null = null
  #done = false

  push(item: T): void {
    if (this.#done) return
    if (this.#waiting) {
      const resolve = this.#waiting
      this.#waiting = null
      resolve({ value: item, done: false })
    } else {
      this.#queue.push(item)
    }
  }

  close(): void {
    this.#done = true
    if (this.#waiting) {
      const resolve = this.#waiting
      this.#waiting = null
      resolve({ value: undefined as any, done: true })
    }
  }

  get closed(): boolean { return this.#done }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.#queue.length > 0) {
          return Promise.resolve({ value: this.#queue.shift()!, done: false })
        }
        if (this.#done) {
          return Promise.resolve({ value: undefined as any, done: true })
        }
        return new Promise(resolve => { this.#waiting = resolve })
      },
    }
  }
}

/**
 * Claude LLM - Wraps Claude Agent SDK for LiveKit
 * Research mode: reads anything, writes only to session workspace
 */
export class ClaudeLLM extends llm.LLM {
  #opts: ClaudeLLMOptions
  #sessionId: string | null = null
  #eventEmitter: EventEmitter
  #resumeSessionId: string | null = null
  #continueSession: boolean = false
  #mcpServers: Record<string, McpServerConfig> = {}

  // File checkpointing - stores checkpoint UUIDs for rewinding file changes
  #checkpoints: string[] = []
  #latestCheckpoint: string | null = null

  // Pending permission request (for voice approval flow)
  #pendingPermission: {
    toolName: string
    input: Record<string, unknown>
    resolve: (decision: { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }) => void
  } | null = null

  // Persistent session — single query() with AsyncIterable<SDKUserMessage> input.
  // Subprocess spawns once on first chat(), stays alive for all subsequent messages.
  // No JSONL replay after the first cold start.
  #persistentQuery: SDKQuery | null = null
  #messageChannel: MessageChannel<SDKUserMessage> | null = null
  #backgroundConsumerRunning = false

  // Active queries — multiple can be running (SDK queues them internally).
  // We keep ALL references so interrupt() can stop whatever is currently executing.
  #activeQueries: Set<any> = new Set()

  constructor(opts: ClaudeLLMOptions = {}) {
    super()

    // Session resume/continue options
    this.#resumeSessionId = opts.resumeSessionId || null
    this.#continueSession = opts.continueSession || false

    // MCP servers
    this.#mcpServers = opts.mcpServers || {}

    this.#opts = {
      workingDirectory: opts.workingDirectory || process.cwd(),
      sessionBaseDir: opts.sessionBaseDir || opts.workingDirectory || process.cwd(),
      permissionMode: opts.permissionMode || 'default',
      allowedTools: opts.allowedTools || RESEARCH_TOOLS,
      resumeSessionId: this.#resumeSessionId || undefined,
      continueSession: this.#continueSession,
      mcpServers: this.#mcpServers,
      voiceMode: opts.voiceMode || 'realtime',
      skipTTSQueue: opts.skipTTSQueue || false,
      // CRITICAL: the PreCompact / PostCompact hooks call
      // `this.#opts.onCompactionEvent?.(...)` to invoke the bridge to the
      // frontend (chat-bubble + banner). Without including the callback in
      // this whitelisted literal, callers can pass it correctly via opts but
      // it's silently dropped during construction → hooks invoke undefined →
      // no chat bubble appears. This was the real reason the compaction UI
      // never showed up in 0.9.44–0.9.46 despite the wiring at every caller
      // looking right. Confirmed 2026-05-28 by reading the live dist on Fly
      // and seeing PreCompact/PostCompact emoji logs + the SDK iterator
      // marker [COMPACT-SDK-ITER] firing while [COMPACT-AGENT-RX] never did.
      // `onPermissionRequest` is handled separately via its own private field
      // and does NOT need to be in this literal.
      onCompactionEvent: opts.onCompactionEvent,
    }
    this.#eventEmitter = opts.eventEmitter || new EventEmitter()

    console.log('🟠 ClaudeLLM initialized (Research Mode)')
    console.log(`   📁 Working dir (cwd): ${this.#opts.workingDirectory}`)
    if (this.#opts.sessionBaseDir !== this.#opts.workingDirectory) {
      console.log(`   📁 Session base dir: ${this.#opts.sessionBaseDir}`)
    }
    console.log(`   🔧 Allowed tools: ${this.#opts.allowedTools?.join(', ')}`)
    const mcpCount = Object.keys(this.#mcpServers).length
    if (mcpCount > 0) {
      console.log(`   🔌 MCP servers: ${Object.keys(this.#mcpServers).join(', ')}`)
    }
    if (this.#resumeSessionId) {
      console.log(`   🔄 Resuming session: ${this.#resumeSessionId}`)
    } else if (this.#continueSession) {
      console.log(`   🔄 Continuing most recent session`)
    }
  }

  /**
   * Respond to a pending permission request
   * Call this after receiving 'permission_request' event
   */
  respondToPermission(allow: boolean, message?: string) {
    if (this.#pendingPermission) {
      const input = this.#pendingPermission.input
      if (allow) {
        this.#pendingPermission.resolve({
          behavior: 'allow',
          updatedInput: input, // Pass through original input
        })
      } else {
        this.#pendingPermission.resolve({
          behavior: 'deny',
          message: message || 'User denied permission',
        })
      }
      this.#pendingPermission = null
    }
  }

  /**
   * Check if there's a pending permission request
   */
  hasPendingPermission(): boolean {
    return this.#pendingPermission !== null
  }

  /**
   * Get pending permission details
   */
  getPendingPermission(): { toolName: string; input: any } | null {
    if (this.#pendingPermission) {
      return { toolName: this.#pendingPermission.toolName, input: this.#pendingPermission.input }
    }
    return null
  }

  // ============================================================
  // MCP SERVER MANAGEMENT - Runtime enable/disable MCP servers
  // ============================================================

  /**
   * Get all currently enabled MCP servers
   */
  getMcpServers(): Record<string, McpServerConfig> {
    return { ...this.#mcpServers }
  }

  /**
   * Get list of enabled MCP server keys
   */
  getEnabledMcpServerKeys(): string[] {
    return Object.keys(this.#mcpServers)
  }

  /**
   * Replace all MCP servers at once
   */
  setMcpServers(servers: Record<string, McpServerConfig>): void {
    this.#mcpServers = { ...servers }
    this.#opts.mcpServers = this.#mcpServers
    console.log(`🔌 MCP servers updated: ${Object.keys(servers).join(', ') || 'none'}`)
    this.#eventEmitter.emit('mcp_servers_changed', {
      enabledKeys: Object.keys(this.#mcpServers),
    })
  }

  /**
   * Enable a single MCP server
   */
  enableMcpServer(key: string, config: McpServerConfig): void {
    this.#mcpServers[key] = config
    this.#opts.mcpServers = this.#mcpServers
    console.log(`🔌 MCP server enabled: ${key}`)
    this.#eventEmitter.emit('mcp_servers_changed', {
      enabledKeys: Object.keys(this.#mcpServers),
    })
  }

  /**
   * Disable a single MCP server
   */
  disableMcpServer(key: string): void {
    delete this.#mcpServers[key]
    this.#opts.mcpServers = this.#mcpServers
    console.log(`🔌 MCP server disabled: ${key}`)
    this.#eventEmitter.emit('mcp_servers_changed', {
      enabledKeys: Object.keys(this.#mcpServers),
    })
  }

  label(): string {
    return 'claude.agent-sdk'
  }

  get model(): string {
    return this.#opts.model || 'claude-sonnet-4-6' // Sonnet orchestrator with named sub-agents
  }

  get sessionId(): string | null {
    return this.#sessionId
  }

  /**
   * Set per-user named agents (DB-backed, from the frontend's set_agents).
   * Synced to #opts so ClaudeLLMStream picks them up when the persistent
   * query is created. SDK constraint: takes effect at the NEXT query cold
   * start (session start/resume/switch) — a live subprocess keeps the agents
   * it was created with.
   */
  setAgents(agents: ClaudeLLMOptions['agents']): void {
    this.#opts.agents = agents
    console.log(`🤖 Named agents ${agents ? `set (${Object.keys(agents).join(', ')})` : 'reset to built-ins'} — applies at next query cold start`)
  }

  /**
   * Set session ID to resume a specific conversation
   * Call this before sending the first message to resume from a previous session
   */
  setResumeSessionId(sessionId: string | null): void {
    this.#resumeSessionId = sessionId
    // CRITICAL: Sync to opts so ClaudeLLMStream.run() picks up the resume ID
    this.#opts.resumeSessionId = sessionId || undefined

    if (sessionId) {
      console.log(`🔄 Will resume session: ${sessionId}`)
    }
  }

  /**
   * Set the working directory for the current session
   * Call this when resuming a session from a different project slug
   */
  setWorkingDirectory(path: string): void {
    this.#opts.workingDirectory = path
  }

  /**
   * Reset state for mid-conversation session switch
   * Clears pending permissions and resets conversation tracking
   */
  resetForSessionSwitch(): void {
    // Kill persistent session — new session needs fresh subprocess
    this.closeSession()

    // Clear any pending permission request from previous session
    if (this.#pendingPermission) {
      this.#pendingPermission.resolve({
        behavior: 'deny',
        message: 'Session switched - permission request cancelled',
      })
      this.#pendingPermission = null
    }

    // Clear session resume state so new resume can take effect
    this.#resumeSessionId = null
    this.#continueSession = false
    this.#opts.resumeSessionId = undefined
    this.#opts.continueSession = false
    this.#sessionId = null

    // Clear checkpoints from previous session
    this.#checkpoints = []
    this.#latestCheckpoint = null

    // Emit event for listeners
    this.#eventEmitter.emit('session_reset')

    console.log('🔄 LLM state reset for session switch')
  }

  /**
   * Enable "continue" mode - resumes most recent session
   */
  setContinueSession(enabled: boolean): void {
    this.#continueSession = enabled
    this.#opts.continueSession = enabled
    if (enabled) {
      console.log(`🔄 Will continue most recent session`)
    }
  }

  /**
   * Check if this instance is configured to resume a session
   */
  get isResumingSession(): boolean {
    return !!(this.#resumeSessionId || this.#continueSession)
  }

  get events(): EventEmitter {
    return this.#eventEmitter
  }

  // ============================================================
  // FILE CHECKPOINTING - Track and rewind file changes
  // ============================================================

  /**
   * Capture a checkpoint UUID for potential file rewind
   * Called internally when receiving user message UUIDs from the SDK
   */
  captureCheckpoint(checkpointId: string): void {
    this.#checkpoints.push(checkpointId)
    this.#latestCheckpoint = checkpointId
    console.log(`📍 Checkpoint captured: ${checkpointId.substring(0, 8)}...`)
    this.#eventEmitter.emit('checkpoint_captured', { checkpointId })
  }

  /**
   * Get the most recent checkpoint UUID
   * Use this to rewind all file changes back to the beginning
   */
  getLatestCheckpoint(): string | null {
    return this.#latestCheckpoint
  }

  /**
   * Get the first checkpoint UUID (initial state)
   * Rewinding to this restores all files to their original state
   */
  getFirstCheckpoint(): string | null {
    return this.#checkpoints.length > 0 ? this.#checkpoints[0] : null
  }

  /**
   * Get all captured checkpoint UUIDs
   * Ordered from oldest to newest
   */
  getCheckpoints(): string[] {
    return [...this.#checkpoints]
  }

  /**
   * Clear all captured checkpoints
   * Call this when starting a new session
   */
  clearCheckpoints(): void {
    this.#checkpoints = []
    this.#latestCheckpoint = null
    console.log('🧹 Checkpoints cleared')
  }

  /**
   * Check if checkpoints are available
   */
  hasCheckpoints(): boolean {
    return this.#checkpoints.length > 0
  }

  // ============================================================
  // AGENT CONTROL — interrupt, abort, rewind (for fast brain)
  // ============================================================

  /**
   * Interrupt the current Claude query gracefully (like pressing Esc).
   * Stops current tool execution but keeps the process alive.
   * Returns true if interrupted, false if no active query.
   */
  async interruptQuery(): Promise<boolean> {
    // Prefer persistent query's interrupt() — graceful Esc that keeps subprocess alive
    if (this.#persistentQuery && typeof this.#persistentQuery.interrupt === 'function') {
      try {
        await this.#persistentQuery.interrupt()
        console.log('🛑 Interrupted persistent session (Esc equivalent — subprocess stays alive)')
        return true
      } catch (err: any) {
        console.error('⚠️ Persistent interrupt failed:', err?.message)
      }
    }
    // Fallback: interrupt any active one-shot queries (realtime mode research)
    if (this.#activeQueries.size === 0) return false
    const queriesToInterrupt = [...this.#activeQueries]
    let interrupted = false
    for (const q of queriesToInterrupt) {
      if (typeof q.interrupt === 'function') {
        try {
          await q.interrupt()
          interrupted = true
        } catch (err: any) {
          console.error('⚠️ Interrupt failed:', err?.message)
        }
      }
    }
    if (interrupted) {
      console.log(`🛑 Interrupted ${queriesToInterrupt.length} active query(s) (Esc equivalent)`)
    }
    return interrupted
  }

  /**
   * Hard abort all active queries (like Ctrl+C).
   * Kills subprocesses. Next message will spawn new processes.
   */
  abortQuery(): void {
    // Kill persistent session first (if alive)
    this.closeSession()
    // Also kill any one-shot queries (realtime research)
    for (const q of this.#activeQueries) {
      try { q.return?.() } catch {}
    }
    this.#activeQueries.clear()
    console.log('🛑 All queries aborted (Ctrl+C equivalent)')
  }

  /**
   * Rewind file changes to a specific checkpoint.
   * Uses the most recently added query (most likely to have the rewind capability).
   */
  async rewindToCheckpoint(checkpointId?: string): Promise<boolean> {
    const id = checkpointId || this.#latestCheckpoint
    if (!id) {
      console.log('⚠️ No checkpoint available for rewind')
      return false
    }
    // Prefer persistent query (has the full session context)
    if (this.#persistentQuery && typeof this.#persistentQuery.rewindFiles === 'function') {
      try {
        await this.#persistentQuery.rewindFiles(id)
        console.log(`🔄 Files rewound to checkpoint: ${id.substring(0, 8)}...`)
        return true
      } catch (err: any) {
        console.error('⚠️ Rewind failed:', err?.message)
      }
    }
    // Fallback: try latest one-shot query
    const queries = [...this.#activeQueries]
    const latest = queries[queries.length - 1]
    if (latest && typeof latest.rewindFiles === 'function') {
      try {
        await latest.rewindFiles(id)
        console.log(`🔄 Files rewound to checkpoint: ${id.substring(0, 8)}...`)
        return true
      } catch (err: any) {
        console.error('⚠️ Rewind failed:', err?.message)
      }
    }
    return false
  }

  /**
   * Check if there are active queries that can be interrupted
   */
  hasActiveQuery(): boolean {
    return this.#activeQueries.size > 0
  }

  /** Add an active query (called from ClaudeLLMStream when query starts) */
  setActiveQuery(q: any): void {
    if (q) {
      this.#activeQueries.add(q)
    }
  }

  /** Remove an active query (called from ClaudeLLMStream when query completes) */
  removeActiveQuery(q: any): void {
    this.#activeQueries.delete(q)
  }

  // ============================================================
  // PERSISTENT SESSION — V1 query() with AsyncIterable<SDKUserMessage>
  // Single subprocess per voice session. First chat() does JSONL cold
  // start; subsequent chat() calls push messages to the existing
  // subprocess via the MessageChannel — no JSONL replay.
  // ============================================================

  /** Whether a persistent session is alive and consuming messages */
  hasSession(): boolean {
    return this.#persistentQuery !== null && !this.#messageChannel?.closed
  }

  /**
   * Close the persistent session (kills subprocess).
   * Call on disconnect, session switch, or recovery.
   */
  closeSession(): void {
    if (this.#messageChannel) {
      this.#messageChannel.close()
    }
    if (this.#persistentQuery) {
      try { this.#persistentQuery.close() } catch {}
      this.#activeQueries.delete(this.#persistentQuery)
    }
    this.#persistentQuery = null
    this.#messageChannel = null
    this.#backgroundConsumerRunning = false
    console.log('🔒 Persistent session closed')
  }

  /**
   * Push a user message into the persistent session.
   * If no session exists yet, creates one (cold start with JSONL replay).
   * If a session exists, instantly delivers the message (no replay).
   *
   * @param userText - The user's message text
   * @param sdkOptions - Full V1 Options (only used on first call to create the query)
   * @param callbacks - Event callbacks for the background consumer
   */
  pushMessage(
    userText: string,
    sdkOptions: Options,
    callbacks: {
      onSessionId: (id: string) => void
      onCheckpoint: (checkpointId: string) => void
      eventEmitter: EventEmitter
    },
  ): void {
    // Auto-compact threshold — fires PreCompact when context fills to this %.
    // Higher = uses more of the window before compacting (more context retained
    // per turn, but less headroom for the next reply). 85% is the sweet spot
    // before Claude starts hard-capping replies near the limit.
    process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = '85'

    const userMessage: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: userText }] } as any,
      parent_tool_use_id: null,
      session_id: this.#sessionId || '',
    }

    if (this.#persistentQuery && this.#messageChannel && !this.#messageChannel.closed) {
      // Fast path — push to existing subprocess (no cold start)
      console.log('⚡ Persistent session: pushing message (no JSONL replay)')
      this.#messageChannel.push(userMessage)
      return
    }

    // Cold start — create channel, push first message, start query + background consumer
    console.log('🔄 Persistent session: cold start (first message, JSONL replay)')
    this.#messageChannel = new MessageChannel()
    this.#messageChannel.push(userMessage)

    this.#persistentQuery = query({ prompt: this.#messageChannel as any, options: sdkOptions })
    this.#activeQueries.add(this.#persistentQuery)

    this.#startBackgroundConsumer(callbacks)
  }

  /**
   * Background consumer — runs for the lifetime of the persistent session.
   * Consumes all SDKMessage events from the query and routes them to
   * the event emitter (same events as the old per-query skipTTSQueue path).
   */
  async #startBackgroundConsumer(callbacks: {
    onSessionId: (id: string) => void
    onCheckpoint: (checkpointId: string) => void
    eventEmitter: EventEmitter
  }): Promise<void> {
    if (this.#backgroundConsumerRunning) return
    this.#backgroundConsumerRunning = true
    const pq = this.#persistentQuery!

    try {
      for await (const message of pq) {
        const msg = message as any

        // Session ID capture
        if (msg.type === 'system' && msg.subtype === 'init') {
          const mcpServers = msg.mcp_servers
          if (mcpServers && Array.isArray(mcpServers)) {
            for (const s of mcpServers) {
              const status = s.status === 'connected' ? '✅' : '❌'
              console.log(`${status} MCP server ${s.name}: ${s.status}`)
            }
          }
          const newSessionId = msg.session_id
          if (newSessionId) {
            callbacks.onSessionId(newSessionId)
            const isNew = !this.#sessionId
            if (isNew) console.log(`📋 New session: ${newSessionId}`)
            this.#sessionId = newSessionId
            if (isNew && this.#opts.workingDirectory) {
              saveSessionMetadata(this.#opts.workingDirectory, {
                sessionId: newSessionId,
                lastUpdated: new Date().toISOString(),
                projectPath: this.#opts.workingDirectory,
              })
            }
            const requestedResumeId = this.#opts.resumeSessionId
            if (requestedResumeId && newSessionId !== requestedResumeId) {
              console.error(`❌ Session resume FAILED: Expected ${requestedResumeId.substring(0, 8)}..., got ${newSessionId.substring(0, 8)}...`)
              callbacks.eventEmitter.emit('session_resume_failed', { requestedSessionId: requestedResumeId, actualSessionId: newSessionId })
            } else if (requestedResumeId && newSessionId === requestedResumeId) {
              console.log(`✅ Session resumed successfully: ${newSessionId.substring(0, 8)}...`)
            }
          }
        }

        // Compaction signals observed on the SDK iterator (parallel to hook path).
        // The SDK emits TWO message subtypes during compaction independent of
        // hook registration:
        //   - type:'system', subtype:'compact_boundary'  (with compact_metadata)
        //   - type:'system', subtype:'status', status:'compacting' | null
        // We DON'T route these through onCompactionEvent (to avoid duplicate
        // chat bubbles — hooks already do that), but we LOG them. If the hook
        // path ever silently fails, these logs will be the only signal that
        // compaction actually happened — making the failure obvious in fly logs.
        if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
          const meta = msg.compact_metadata || {}
          console.log(`[COMPACT-SDK-ITER] compact_boundary observed: trigger=${meta.trigger ?? '?'} pre_tokens=${meta.pre_tokens ?? '?'} preserved=${meta.preserved_segment ? 'yes' : 'no'}`)
          // Fire onCompactionEvent as a FALLBACK if hooks didn't fire — we
          // detect this by checking whether we've seen 'compaction_started'
          // recently. For now, log only; can wire as fallback if hooks fail.
        }
        if (msg.type === 'system' && msg.subtype === 'status') {
          const status = msg.status
          if (status === 'compacting' || status === null) {
            console.log(`[COMPACT-SDK-ITER] status change: ${status === 'compacting' ? 'ENTERED compacting' : 'EXITED compacting'} session=${msg.session_id?.substring(0,8) ?? '?'}`)
          }
        }

        // Checkpoint capture
        if (msg.type === 'user' && msg.uuid) {
          callbacks.onCheckpoint(msg.uuid)
        }

        // SDK request ID
        if (msg.requestId) {
          callbacks.eventEmitter.emit('query_request_id', { requestId: msg.requestId })
        }

        // Stream assistant text → tts_say events
        if (msg.type === 'assistant' && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'text' && block.text) {
              callbacks.eventEmitter.emit('assistant_text', { text: block.text })
              const ttsChunk = stripMarkdownForTTS(block.text)
              if (ttsChunk.trim()) {
                console.log(`🔊 TTS say (${ttsChunk.length} chars): "${ttsChunk}"`)
                callbacks.eventEmitter.emit('tts_say', { text: ttsChunk })
              }
            }
          }
        }

        // Result — marks end of a turn (but we keep consuming for next turn)
        if (msg.type === 'result') {
          if (msg.result) {
            callbacks.eventEmitter.emit('assistant_result', { text: msg.result })
          }
          console.log('✅ Claude turn complete (persistent session stays alive)')
        }
      }
    } catch (error: any) {
      if (error?.message?.includes('aborted') || error?.message?.includes('AbortError')) {
        console.log('🛑 Persistent session query aborted')
      } else {
        console.error('❌ Persistent session error:', error)
        callbacks.eventEmitter.emit('tts_say', { text: 'Sorry, I encountered an error.' })
      }
    } finally {
      this.#backgroundConsumerRunning = false
      this.#activeQueries.delete(pq)
      this.#persistentQuery = null
      this.#messageChannel = null
      console.log('🔒 Persistent session background consumer exited')
    }
  }

  chat({
    chatCtx,
    toolCtx,
    connOptions = DEFAULT_API_CONNECT_OPTIONS,
    abortController,
  }: {
    chatCtx: llm.ChatContext
    toolCtx?: llm.ToolContext
    connOptions?: APIConnectOptions
    parallelToolCalls?: boolean
    toolChoice?: llm.ToolChoice
    extraKwargs?: Record<string, unknown>
    abortController?: AbortController
  }): llm.LLMStream {
    return new ClaudeLLMStream(this, {
      chatCtx,
      toolCtx,
      connOptions,
      opts: this.#opts,
      sessionId: this.#sessionId,
      abortController,
      onSessionId: (id) => {
        const isFirst = !this.#sessionId
        this.#sessionId = id
        if (isFirst) {
          this.#eventEmitter.emit('session_id', { sessionId: id })
        }
      },
      eventEmitter: this.#eventEmitter,
      // Pass checkpoint capture handler
      onCheckpoint: (checkpointId: string) => {
        this.captureCheckpoint(checkpointId)
      },
      // Pass permission handler for canUseTool callback
      onPermissionRequest: (toolName: string, input: Record<string, unknown>) => {
        type PermResult = { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }
        return new Promise<PermResult>((resolve) => {
          this.#pendingPermission = { toolName, input, resolve }
          console.log(`⚠️ Permission request: ${toolName}`)
          this.#eventEmitter.emit('permission_request', { toolName, input })
        })
      },
    })
  }
}

// Permission result type matching Claude Agent SDK
type PermissionResult = { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }

/**
 * Claude LLM Stream - Runs Claude Agent SDK query() and streams results
 */
class ClaudeLLMStream extends llm.LLMStream {
  #opts: ClaudeLLMOptions
  #sessionId: string | null
  #onSessionId: (id: string) => void
  #eventEmitter: EventEmitter
  #onPermissionRequest: (toolName: string, input: Record<string, unknown>) => Promise<PermissionResult>
  #onCheckpoint: (checkpointId: string) => void
  #abortController?: AbortController
  #llmRef: ClaudeLLM
  #approvedWriterToolUseIds = new Set<string>()

  constructor(
    llmInstance: ClaudeLLM,
    {
      chatCtx,
      toolCtx,
      connOptions,
      opts,
      sessionId,
      onSessionId,
      eventEmitter,
      onCheckpoint,
      onPermissionRequest,
      abortController,
    }: {
      chatCtx: llm.ChatContext
      toolCtx?: llm.ToolContext
      connOptions: APIConnectOptions
      opts: ClaudeLLMOptions
      sessionId: string | null
      onSessionId: (id: string) => void
      eventEmitter: EventEmitter
      onCheckpoint: (checkpointId: string) => void
      onPermissionRequest: (toolName: string, input: Record<string, unknown>) => Promise<PermissionResult>
      abortController?: AbortController
    },
  ) {
    super(llmInstance, { chatCtx, toolCtx, connOptions })
    this.#llmRef = llmInstance
    this.#opts = opts
    this.#sessionId = sessionId
    this.#onSessionId = onSessionId
    this.#eventEmitter = eventEmitter
    this.#onCheckpoint = onCheckpoint
    this.#onPermissionRequest = onPermissionRequest
    this.#abortController = abortController
  }

  protected async run(): Promise<void> {
    const requestId = `claude_${shortuuid()}`
    let activeQuery: any = null

    try {
      // Extract user's message from chat context
      // ChatContext has .items which are ChatItem[] (ChatMessage | FunctionCall | FunctionCallOutput)
      const items = this.chatCtx.items

      // Find the last user message
      let userText = ''
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i] as any
        if (item.type === 'message' && item.role === 'user') {
          // Content is ChatContent[] = (ImageContent | AudioContent | string)[]
          if (Array.isArray(item.content)) {
            userText = item.content
              .filter((c: any) => typeof c === 'string')
              .join('\n')
          }
          break
        }
      }

      if (!userText.trim()) {
        this.queue.put({
          id: requestId,
          delta: { role: 'assistant', content: "I didn't catch that. Could you repeat?" },
        })
        return
      }

      console.log(`🎤 User (${userText.length} chars): "${userText}"`)

      // Build Claude Agent SDK options
      const resumeSessionId = this.#opts.resumeSessionId
      const continueSession = this.#opts.continueSession

      // Session workspace path for system prompt — lives under ~/.claude/projects/{slug}/osb/{sessionId}/
      const sessionId = this.#sessionId || this.#opts.resumeSessionId || null
      const workspacePath = sessionId && this.#opts.workingDirectory
        ? getSessionWorkspace(this.#opts.workingDirectory, sessionId)
        : null

      const allowedTools = this.#opts.allowedTools || []

      const sdkOptions: Options = {
        cwd: this.#opts.workingDirectory,
        permissionMode: this.#opts.permissionMode,
        allowedTools,
        // model: this.#opts.model || 'haiku', // haiku for speed with limited tools, sonnet for full research capabilities (including tool use trace in response)
        model: this.#opts.model || 'claude-sonnet-4-6', // Sonnet orchestrator with named sub-agents (Haiku tested but ignored delegation rules)
        enableFileCheckpointing: true,
        settingSources: ['project', 'user'],
        extraArgs: { 'replay-user-messages': null },
        ...(this.#abortController && { abortController: this.#abortController }),
        ...(resumeSessionId && { resume: resumeSessionId }),
        ...(continueSession && !resumeSessionId && { continue: true }),
        ...(this.#sessionId && !resumeSessionId && !continueSession && { resume: this.#sessionId }),
        // System prompt — direct mode gets speech-optimized prompt, realtime gets structured research prompt
        // Skills from agent/.claude/skills/ are appended if present
        systemPrompt: [
          this.#opts.voiceMode === 'direct'
            ? getDirectModeResearchPrompt(workspacePath)
            : getResearchSystemPrompt(workspacePath),
          loadAllSkills(this.#opts.sessionBaseDir || this.#opts.workingDirectory || process.cwd()),
        ].filter(Boolean).join('\n\n'),
        canUseTool: async (toolName, input, _options) => {
          // Auto-approve writes to session workspace (but block spec.md and library/ — fast brain manages those)
          if (toolName === 'Write' || toolName === 'Edit') {
            const filePath = String(input?.file_path || '')
            const agentType = input?.agent_type || null
            const toolUseId = (_options as any)?.toolUseID
              const toolInput = input?.tool_input || {}
              console.log('input,', input, 'input.file_path', filePath, 'agent_type', agentType)
            console.log(`🔍 canUseTool: ${toolName} filePath="${filePath}" keys=${Object.keys(input || {}).join(',')}`)
            console.log(`🔍 canUseTool _options keys=[${Object.keys(_options || {}).join(', ')}] title="${(_options as any)?.title || ''}" decisionReason="${(_options as any)?.decisionReason || ''}" blockedPath="${(_options as any)?.blockedPath || ''}"`)
            if (filePath.includes('/osb/') || filePath.includes('.osborn/sessions/') || filePath.includes('.osborn/research/')) {
              // Block writes to spec.md — the fast brain manages it
              const fileName = filePath.split('/').pop() || ''
              if (fileName === 'spec.md') {
                console.log(`🚫 Blocked research agent write to managed file: ${filePath} (fast brain handles spec.md)`)
                return { behavior: 'deny', message: 'spec.md is managed by the fast brain. Do NOT write to it. Return your findings in your response text — the fast brain will organize them into spec.md automatically.' }
              }
              console.log(`✅ Auto-approved ${toolName} to workspace: ${filePath}`)
              return { behavior: 'allow', updatedInput: input }
            }
            // Auto-approve writer sub-agent writes to skill installation directories.
            // Pattern matches `.claude/skills/<skillname>/<file>` in any osborn install location
            // (npm global, dev tree, cloud sandbox), so installing a multi-file skill via the
            // writer agent doesn't blow up into a per-file permission cascade.
            // Requires agent_type === 'writer' — main/researcher/reasoner are blocked by PreToolUse
            // before they ever reach canUseTool, so this check is the only path that lets a
            // skill install through silently.
            if (agentType === 'writer' && /\/\.claude\/skills\/[^/]+\//.test(filePath)) {
              console.log(`✅ Auto-approved writer ${toolName} to skill dir: ${filePath}`)
              return { behavior: 'allow', updatedInput: input }
            }
            // Auto-approve the meetings skill's notes file. It lives at the
            // WORKING DIRECTORY root (not /osb/), so it missed the workspace
            // auto-approve — every meeting notes write stalled the turn behind
            // a permission dialog nobody in a live meeting can answer (found
            // live 2026-08-01: addressed replies froze >30s, bot went silent).
            if (/(^|\/)meeting-(todos|notes)\.md$/.test(filePath)) {
              console.log(`✅ Auto-approved ${toolName} to meeting notes: ${filePath}`)
              return { behavior: 'allow', updatedInput: input }
            }
            // Auto-approve Bash calls to the agent's OWN local API (/canvas,
            // /tts) — this is how the agent SPEAKS into a meeting. A spoken
            // reply must never wait on a permission dialog (the room is
            // listening). Localhost-only, own-port-only — not a general curl
            // allowance.
            if (toolName === 'Bash') {
              const cmd = String((input as any)?.command || '')
              if (/^\s*curl\b[^;&|]*https?:\/\/(localhost|127\.0\.0\.1):\d+\/(canvas|tts)\b/.test(cmd) && !/[;&|]/.test(cmd.replace(/\|\s*$/, ''))) {
                console.log(`✅ Auto-approved Bash → own API (canvas/tts speak path)`)
                return { behavior: 'allow', updatedInput: input }
              }
            }
            // if (toolUseId && this.#approvedWriterToolUseIds.has(toolUseId)) {
            //   this.#approvedWriterToolUseIds.delete(toolUseId)
            //   console.log(`✅ Writer pre-approved ${toolName}: ${filePath}`)
            //   return { behavior: 'allow', updatedInput: input }
            // }
          }
          // Auto-approve AskUserQuestion — research agent should freely ask clarifying questions
          if (toolName === 'AskUserQuestion') {
            console.log(`✅ Auto-approved ${toolName}`)
            return { behavior: 'allow', updatedInput: input }
          }
          // Auto-deny tools the research agent should never use
          if (toolName === 'EnterPlanMode' || toolName === 'ExitPlanMode') {
            console.log(`🚫 Auto-denied ${toolName} (not used in research mode)`)
            return { behavior: 'deny', message: 'Research mode does not use plan mode. Just proceed with the research directly.' }
          }
          
          console.log(`⚠️ Permission needed: ${toolName}`)
          return this.#onPermissionRequest(toolName, input)
        },
        hooks: {
          PreToolUse: [{
            matcher: '.*',
            hooks: [async (input: any) => {
              const toolName = input?.tool_name || 'unknown'
              const toolInput = input?.tool_input || {}
              const agentType = input?.agent_type || null
              console.log(`🔍 PreToolUse: toolName=${toolName} agent_type=${agentType} agent_id=${(input as any)?.agent_id || 'none'} all_keys=[${Object.keys(input || {}).join(', ')}]`)

              // ≤3 direct tool call budget enforcement.
              // Only counts calls from the MAIN orchestrator agent (agent_type === null).
              // Task/Agent delegations are exempt — delegation is the desired behavior.
              // Sub-agent tool calls are exempt — they're inside a delegation.
              if (!agentType && toolName !== 'Task' && toolName !== 'Agent') {
                turnToolCallCount++
                if (turnToolCallCount > TOOL_CALL_BUDGET) {
                  console.log(`🛑 Tool budget exceeded (${turnToolCallCount}/${TOOL_CALL_BUDGET}) — DENYING ${toolName}. Must delegate via Task.`)
                  this.#eventEmitter.emit('tool_blocked', { name: toolName, reason: `Tool call budget exceeded (${turnToolCallCount}/${TOOL_CALL_BUDGET}). Delegate via Task.` })
                  return {
                    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
                    reason: `Hard limit: maximum ${TOOL_CALL_BUDGET} direct tool calls per turn (you are at ${turnToolCallCount}). Delegate the remaining work to a sub-agent via Task(subagent_type=\'researcher\'|\'writer\'|\'reasoner\', run_in_background: true). This is a system-enforced limit.`,
                  }
                }
                console.log(`🔧 Tool call ${turnToolCallCount}/${TOOL_CALL_BUDGET}: ${toolName}`)
              }

              // Write/Edit/MultiEdit access control
              if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
                // Writer sub-agent gets full write access everywhere
                console.log('verifying agent_type', agentType)
                // Writer agent: no longer auto-approved — falls through to canUseTool for permission dialog
                if (agentType === 'writer') {
                  console.log(`✍️ Writer agent: deferring to canUseTool for permission`)
                  this.#eventEmitter.emit('tool_use', { name: toolName, input: toolInput })
                  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } }
                }

                // All other agents (main, researcher, reasoner, etc.): workspace only
                const filePath = String(toolInput.file_path || '')
                if (filePath && !filePath.includes('/osb/') && !filePath.includes('.osborn/sessions/') && !filePath.includes('.osborn/research/')) {
                  console.log(`🚫 Research mode: blocked write to ${filePath} (agent_type: ${agentType ?? 'main'})`)
                  this.#eventEmitter.emit('tool_blocked', { name: toolName, reason: 'Research mode: writes restricted to session workspace' })
                  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' }, reason: 'Research mode: writes restricted to session workspace.' }
                }
              }

              console.log(`🔧 Claude: ${toolName}`)
              this.#eventEmitter.emit('tool_use', { name: toolName, input: toolInput })
              return {}
            }]
          }],
          PostToolUse: [{
            matcher: '.*',
            hooks: [async (input: any) => {
              const toolName = input?.tool_name || 'unknown'
              const toolInput = input?.tool_input || {}
              const toolResponse = input?.tool_response  // Capture actual tool output for fast brain processing
              console.log(`✅ Done: ${toolName}`)
              this.#eventEmitter.emit('tool_result', { name: toolName, input: toolInput, response: toolResponse })
              return {}
            }]
          }],
          // Per-turn behavioral re-anchor. Fires on EVERY user message that reaches Claude
          // (initial requests, follow-ups, mid-flight steering, resumed-session messages).
          // Reads the reminder text from disk every call, so it's hot-editable just like the
          // main prompt — edit agent/src/prompts/turn-shape-reminder.md, reconnect, next message
          // sees the new reminder. The SDK injects `additionalContext` alongside the user's actual
          // message so the model sees both the literal user input AND the reminder, weighing them
          // together. This is what fights JSONL-history-overrides-system-prompt drift on resumed
          // sessions: the conductor pattern gets re-asserted on every turn instead of being
          // anchored only at session-init time.
          UserPromptSubmit: [{
            matcher: '.*',
            hooks: [async (input: any) => {
              try {
                // Reset the per-turn tool call counter so the new turn starts fresh.
                turnToolCallCount = 0

                const reminder = readFileSync(TURN_SHAPE_REMINDER_PATH, 'utf-8')
                const promptPreview = String(input?.prompt || '').substring(0, 60).replace(/\n/g, ' ')
                console.log(`📌 UserPromptSubmit: injected turn-shape reminder (${reminder.length} chars) for prompt="${promptPreview}..." [tool budget reset to 0/${TOOL_CALL_BUDGET}]`)
                return {
                  hookSpecificOutput: {
                    hookEventName: 'UserPromptSubmit',
                    additionalContext: reminder,
                  },
                }
              } catch (err) {
                console.error('⚠️ UserPromptSubmit: failed to load turn-shape-reminder.md:', err instanceof Error ? err.message : err)
                return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit' } }
              }
            }]
          }],
          // ── PreCompact: inject extraction instruction only ──
          // Fires before the SDK compresses the conversation. Injects the compact-learnings
          // instruction so the SDK compaction summary includes the four structured sections.
          // Skill extraction happens in PostCompact, which reads input.compact_summary directly.
          PreCompact: [{
            matcher: '.*',
            hooks: [async (input: any) => {
              try {
                this.#opts.onCompactionEvent?.({ type: 'compaction_started', trigger: input?.trigger })

                const instructionPath = join(__claudeLlmDir, 'prompts', 'compact-learnings-instruction.md')
                const instruction = existsSync(instructionPath) ? readFileSync(instructionPath, 'utf-8') : ''

                console.log(`🧠 PreCompact: injecting instruction (${instruction.length} chars, trigger=${input?.trigger || 'unknown'})`)
                return { systemMessage: instruction }

              } catch (err) {
                console.error('⚠️ PreCompact hook error:', err instanceof Error ? err.message : err)
                return {}
              }
            }]
          }],
          // ── PostCompact: parse compact_summary from stdin payload and persist skill sections ──
          // input.compact_summary is the full summary text the SDK just wrote.
          // We read the four sections directly from it — no JSONL file access needed.
          PostCompact: [{
            matcher: '.*',
            hooks: [async (input: any) => {
              try {
                const summary: string = input?.compact_summary || ''
                const { mkdirSync, writeFileSync: writeSyncFs, readFileSync: readSyncFs, existsSync: existsSyncFs } = await import('node:fs')
                const skillDir = homedir()
                const today = new Date().toISOString().split('T')[0]
                const sessionId = this.#sessionId || 'unknown'
                let skillsWritten = 0
                const skillNames: string[] = []
                // Emit fine-grained progress events so the UI can render a multi-step
                // "crystallizing..." panel instead of a single 3-second flash. Each
                // stage gets a human-readable label + optional detail (skill name,
                // char counts) so the user sees something happening through the whole
                // ~3 minute compaction window.
                const progress = (stage: string, detail?: string) => {
                  this.#opts.onCompactionEvent?.({ type: 'compaction_progress', stage, detail })
                }

                progress('Reading compact summary', `${summary.length} chars`)

                // Helper: extract text between a marker and the next === marker (or end of string)
                const extractSection = (marker: string): string => {
                  const idx = summary.indexOf(marker)
                  if (idx === -1) return ''
                  const start = idx + marker.length
                  const nextMarker = summary.indexOf('=== ', start)
                  return (nextMarker === -1 ? summary.substring(start) : summary.substring(start, nextMarker)).trim()
                }

                // ── Section 1: HANDOFF_STATE — stays in compact summary only, not written to disk ──
                const handoff = extractSection('=== HANDOFF_STATE ===')
                if (handoff) {
                  console.log(`🧠 PostCompact: HANDOFF_STATE present (${handoff.length} chars) — not written to disk`)
                  progress('Parsed handoff state', `${handoff.length} chars`)
                }

                // ── Section 2: DECISIONS — append project-scoped decisions ──
                try {
                  const decisions = extractSection('=== DECISIONS ===')
                  if (decisions) {
                    const projectLines = decisions
                      .split('\n')
                      .filter(l => /DECISION:.*SCOPE:\s*project/i.test(l))
                    if (projectLines.length) {
                      progress('Extracting decisions', `${projectLines.length} project-scoped`)
                      const decFolder = join(skillDir, '.claude', 'skills', 'decisions')
                      const decPath = join(decFolder, 'SKILL.md')
                      mkdirSync(decFolder, { recursive: true })
                      const existing = existsSyncFs(decPath) ? readSyncFs(decPath, 'utf-8') : ''
                      const header = existing ? '' : `# Project Decisions\n\nAuto-extracted from compact summaries.\n\n`
                      const entry = `\n## ${today} (session ${sessionId.substring(0, 8)})\n${projectLines.join('\n')}\n`
                      writeSyncFs(decPath, header + existing + entry, 'utf-8')
                      console.log(`🧠 PostCompact: appended ${projectLines.length} decision(s) to ${decPath}`)
                      skillsWritten++
                      skillNames.push('decisions')
                      progress('Wrote skill', 'decisions')
                    }
                  }
                } catch (decErr) {
                  console.error('⚠️ PostCompact: DECISIONS write failed:', decErr instanceof Error ? decErr.message : decErr)
                }

                // ── Section 3: SKILL_CANDIDATES — parse individual blocks and write each ──
                try {
                  const skillsSection = extractSection('=== SKILL_CANDIDATES ===')
                  if (skillsSection) {
                    const skillBlockRe = /---\s*SKILL:\s*([^\n-]+?)\s*---\n([\s\S]*?)---\s*END SKILL\s*---/g
                    const nameRe = /^[a-z][a-z0-9-]{1,39}$/
                    let match: RegExpExecArray | null
                    while ((match = skillBlockRe.exec(skillsSection)) !== null) {
                      const name = match[1].trim()
                      const body = match[2].trim()
                      if (!nameRe.test(name)) {
                        console.warn(`⚠️ PostCompact: skipping skill with invalid name "${name}" (must match /^[a-z][a-z0-9-]{1,39}$/)`)
                        continue
                      }
                      const skillFolder = join(skillDir, '.claude', 'skills', name)
                      const skillPath = join(skillFolder, 'SKILL.md')
                      mkdirSync(skillFolder, { recursive: true })
                      const header = `# ${name}\nAuto-extracted: ${today} | Session: ${sessionId.substring(0, 8)}\n\n`
                      writeSyncFs(skillPath, header + body + '\n', 'utf-8')
                      console.log(`🧠 PostCompact: wrote skill '${name}' to ${skillPath}`)
                      skillsWritten++
                      skillNames.push(name)
                      progress('Wrote skill', name)
                    }
                  }
                } catch (skillErr) {
                  console.error('⚠️ PostCompact: SKILL_CANDIDATES write failed:', skillErr instanceof Error ? skillErr.message : skillErr)
                }

                // ── Section 4: BEHAVIORAL_LEARNINGS — write to learned-behaviors/SKILL.md ──
                try {
                  const learnings = extractSection('=== BEHAVIORAL_LEARNINGS ===')
                  if (learnings.length >= 30) {
                    progress('Extracting learnings', `${learnings.length} chars`)
                    const skillFolder = join(skillDir, '.claude', 'skills', 'learned-behaviors')
                    const skillPath = join(skillFolder, 'SKILL.md')
                    mkdirSync(skillFolder, { recursive: true })
                    const header = `# Learned Behaviors\n\nAuto-extracted from voice sessions via PostCompact.\nLast updated: ${today} | Session: ${sessionId.substring(0, 8)}...\n\n`
                    writeSyncFs(skillPath, header + learnings + '\n', 'utf-8')
                    console.log(`🧠 PostCompact: wrote learned behaviors to ${skillPath} (${learnings.length} chars)`)
                    skillsWritten++
                    skillNames.push('learned-behaviors')
                    progress('Wrote skill', 'learned-behaviors')
                  } else {
                    console.log('🧠 PostCompact: no BEHAVIORAL_LEARNINGS section found or too short — skipping')
                  }
                } catch (blErr) {
                  console.error('⚠️ PostCompact: BEHAVIORAL_LEARNINGS write failed:', blErr instanceof Error ? blErr.message : blErr)
                }

                // ── Section 5: USER_CONTEXT — merge into user-context/CONTEXT.md ──
                // Passive UX: agent learns the user's language automatically after every
                // compaction. No explicit "grill me" command needed. The compact summary
                // captures vocabulary/style observations confirmed during the session.
                try {
                  const userCtx = extractSection('=== USER_CONTEXT ===')
                  const hasContent = userCtx.length >= 30 && !userCtx.includes('(none this session)')
                  if (hasContent) {
                    progress('Updating user context', `${userCtx.length} chars`)
                    const ctxFolder = join(skillDir, '.claude', 'skills', 'user-context')
                    const ctxPath = join(ctxFolder, 'CONTEXT.md')
                    mkdirSync(ctxFolder, { recursive: true })

                    // Append new observations to existing CONTEXT.md under a dated section.
                    // The grill-me skill can consolidate/clean up on explicit request.
                    const existing = existsSyncFs(ctxPath) ? readSyncFs(ctxPath, 'utf-8') : '# User Context\n\n'
                    const entry = `\n## Observations — ${today} (session ${sessionId.substring(0, 8)})\n\n${userCtx}\n`
                    writeSyncFs(ctxPath, existing + entry, 'utf-8')
                    console.log(`🧠 PostCompact: updated user context at ${ctxPath}`)
                    skillsWritten++
                    skillNames.push('user-context')
                    progress('Wrote skill', 'user-context')
                  } else {
                    console.log('🧠 PostCompact: no USER_CONTEXT observations this session — skipping')
                  }
                } catch (ucErr) {
                  console.error('⚠️ PostCompact: USER_CONTEXT write failed:', ucErr instanceof Error ? ucErr.message : ucErr)
                }

                this.#opts.onCompactionEvent?.({ type: 'compaction_complete', skillsWritten, skillNames })
                console.log(`🧠 PostCompact: complete — ${skillsWritten} skill file(s) written: [${skillNames.join(', ')}]`)

              } catch (err) {
                console.error('⚠️ PostCompact hook error:', err instanceof Error ? err.message : err)
              }
              return {}
            }]
          }]
        },
        // Named sub-agents — the orchestrator delegates to these specialists.
        // Built-in definitions live at module level (NAMED_AGENTS); per-user
        // DB-backed definitions (opts.agents, via set_agents) take precedence.
        agents: this.#opts.agents ?? NAMED_AGENTS,
      }

      // Run Claude Agent SDK query() and stream results
      let hasOutput = false
      let fullResponse = '' // Collect full response for frontend

      // DIRECT MODE OPTIMIZATION: When skipTTSQueue is true, we run the Claude query
      // in the background and return from run() immediately. This is critical because:
      //
      // LiveKit's main speech loop (agent_activity.ts) processes one SpeechHandle at a time.
      // The LLM's SpeechHandle blocks the queue until run() returns (which closes the queue
      // → pipeline completes → _markGenerationDone()). If we await the full query() here,
      // the pipeline is blocked for the entire duration of tool execution (10-30s).
      // Meanwhile, session.say() SpeechHandles queue up but can't play.
      //
      // By returning early, the pipeline completes in milliseconds. The say() handles
      // created by tts_say events get processed by the main loop immediately.
      // The query continues in the background — text arrives via tts_say, tools via hooks.
      if (this.#opts.skipTTSQueue) {
        // PERSISTENT SESSION: Push message to existing subprocess (no JSONL replay).
        // First call creates the query (cold start). Subsequent calls are instant.
        // The background consumer in ClaudeLLM handles all message routing (TTS, tools, etc.)
        this.#llmRef.pushMessage(userText, sdkOptions, {
          onSessionId: this.#onSessionId,
          onCheckpoint: this.#onCheckpoint,
          eventEmitter: this.#eventEmitter,
        })

        // Return immediately — queue closes, pipeline completes, say() handles play
        console.log('🚀 Direct mode: Claude query running in background, pipeline released')
        return
      }

      // Store active query for interrupt/rewind access
      activeQuery = query({ prompt: userText, options: sdkOptions })
      this.#llmRef.setActiveQuery(activeQuery)

      for await (const message of activeQuery) {
        // Capture session ID for context continuity
        if ((message as any).type === 'system' && (message as any).subtype === 'init') {
          // Log MCP server connection status
          const mcpServers = (message as any).mcp_servers
          if (mcpServers && Array.isArray(mcpServers)) {
            for (const s of mcpServers) {
              const status = s.status === 'connected' ? '✅' : '❌'
              console.log(`${status} MCP server ${s.name}: ${s.status}`)
              if (s.status !== 'connected') {
                console.log(`   🔍 MCP error:`, JSON.stringify(s))
              }
            }
          }
          const newSessionId = (message as any).session_id
          if (newSessionId) {
            this.#onSessionId(newSessionId)
            const isNewSession = !this.#sessionId
            if (isNewSession) {
              console.log(`📋 New session: ${newSessionId}`)
            }
            this.#sessionId = newSessionId

            // Save session metadata for new sessions
            if (isNewSession && this.#opts.workingDirectory) {
              saveSessionMetadata(this.#opts.workingDirectory, {
                sessionId: newSessionId,
                lastUpdated: new Date().toISOString(),
                projectPath: this.#opts.workingDirectory,
              })
            }

            // Verify session resume succeeded (if we requested a specific session)
            const requestedResumeId = this.#opts.resumeSessionId
            if (requestedResumeId && newSessionId !== requestedResumeId) {
              console.error(`❌ Session resume FAILED: Expected ${requestedResumeId.substring(0, 8)}..., got ${newSessionId.substring(0, 8)}...`)
              this.#eventEmitter.emit('session_resume_failed', {
                requestedSessionId: requestedResumeId,
                actualSessionId: newSessionId,
              })
            } else if (requestedResumeId && newSessionId === requestedResumeId) {
              console.log(`✅ Session resumed successfully: ${newSessionId.substring(0, 8)}...`)
            }
          }
        }

        // Capture checkpoint UUIDs from user messages (for file rewind capability)
        // Per SDK docs: user messages include a UUID that can be used as a restore point
        if ((message as any).type === 'user' && (message as any).uuid) {
          const checkpointId = (message as any).uuid
          this.#onCheckpoint(checkpointId)
        }

        // Stream text chunks — send each assistant text block to TTS
        if ((message as any).type === 'assistant' && (message as any).message?.content) {
          // Emit SDK requestId on first assistant message — identifies this query()
          // in the JSONL for tracking which research task produced which output
          const sdkRequestId = (message as any).requestId
          if (sdkRequestId) {
            this.#eventEmitter.emit('query_request_id', { requestId: sdkRequestId })
          }

          for (const block of (message as any).message.content) {
            if (block.type === 'text' && block.text) {
              hasOutput = true
              const rawText = block.text

              // Emit RAW text to frontend (for chat bubbles with full formatting)
              this.#eventEmitter.emit('assistant_text', { text: rawText })

              // Strip markdown for clean speech
              const ttsChunk = stripMarkdownForTTS(rawText)
              if (ttsChunk.trim()) {
                if (this.#opts.skipTTSQueue) {
                  // Direct mode: emit event for session.say() — bypasses LiveKit's
                  // BufferedTokenStream which causes stuck/delayed/out-of-order audio
                  console.log(`🔊 TTS say (${ttsChunk.length} chars): "${ttsChunk}"`)
                  this.#eventEmitter.emit('tts_say', { text: ttsChunk })
                } else {
                  // Realtime mode: use LLM stream queue (framework handles TTS)
                  console.log(`🔊 TTS stream (${ttsChunk.length} chars): "${ttsChunk}"`)
                  this.queue.put({
                    id: requestId,
                    delta: { role: 'assistant', content: ttsChunk },
                  })
                }
              }
            }
          }
        }

        // Final result — only speak if no text blocks were streamed already
        if ((message as any).type === 'result' && (message as any).result) {
          const rawResult = (message as any).result

          // Emit RAW result to frontend
          this.#eventEmitter.emit('assistant_result', { text: rawResult })

          if (!hasOutput) {
            hasOutput = true
            const ttsText = stripMarkdownForTTS(rawResult)
            if (ttsText.trim()) {
              if (this.#opts.skipTTSQueue) {
                console.log(`🔊 TTS say result (${ttsText.length} chars): "${ttsText}"`)
                this.#eventEmitter.emit('tts_say', { text: ttsText })
              } else {
                console.log(`🔊 TTS result (${ttsText.length} chars): "${ttsText}"`)
                this.queue.put({
                  id: requestId,
                  delta: { role: 'assistant', content: ttsText },
                })
              }
            }
          }
        }
      }

      // If Claude produced no output at all, say "Done."
      if (!hasOutput) {
        if (this.#opts.skipTTSQueue) {
          this.#eventEmitter.emit('tts_say', { text: 'Done.' })
        } else {
          this.queue.put({
            id: requestId,
            delta: { role: 'assistant', content: 'Done.' },
          })
        }
      }

      console.log('✅ Claude response complete')

    } catch (error) {
      // AbortError = clean abort (disconnect, new research, recovery) — don't push
      // garbage text that would flow through the post-research pipeline
      if (this.#abortController?.signal.aborted) {
        console.log('🛑 Claude Agent SDK query aborted')
        if (!this.#opts.skipTTSQueue) {
          this.queue.put({ id: requestId, delta: { role: 'assistant', content: '' } })
        }
        return
      }
      console.error('❌ Claude Agent SDK error:', error)
      if (this.#opts.skipTTSQueue) {
        this.#eventEmitter.emit('tts_say', { text: 'Sorry, I encountered an error.' })
      } else {
        this.queue.put({
          id: requestId,
          delta: { role: 'assistant', content: 'Sorry, I encountered an error.' },
        })
      }
    } finally {
      this.#llmRef.removeActiveQuery(activeQuery)
    }
  }
}

/**
 * Create a ClaudeLLM instance
 */
export function createClaudeLLM(opts?: ClaudeLLMOptions): ClaudeLLM {
  return new ClaudeLLM(opts)
}
