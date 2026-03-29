/**
 * session-access.ts — Programmatic access to Claude Agent SDK session artifacts
 *
 * Given a session ID and project directory, resolves all related files:
 * conversations, sub-agents, tool results, plans, todos, tasks, file history.
 *
 * The JSONL files contain FULL, untruncated content — no caps on tool results,
 * file reads, or assistant reasoning.
 *
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * CLAUDE SESSION STORAGE — DIRECTORY MAP & RELATIONSHIP RULES
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * All session data lives under a single root directory:
 *   claudeDir = CLAUDE_CONFIG_DIR env var || ~/.claude
 *
 * The "project slug" is the project's absolute path with "/" replaced by "-":
 *   /Users/foo/my-project  →  -Users-foo-my-project
 *
 *
 * ── DIRECTORY STRUCTURE ─────────────────────────────────────────────────────
 *
 *   {claudeDir}/
 *   ├── settings.json                  Global settings (MCP servers, etc.)
 *   ├── history.jsonl                  Top-level conversation index
 *   │
 *   ├── projects/{projectSlug}/        ALL SESSION DATA lives here
 *   │   ├── {sessionId}.jsonl          Main conversation (1 file per session)
 *   │   ├── {sessionId}/
 *   │   │   ├── subagents/
 *   │   │   │   └── agent-{hash}.jsonl Sub-agent conversations (one per Task tool call)
 *   │   │   └── tool-results/
 *   │   │       └── {hash}.txt         Large tool outputs (exceeding inline threshold)
 *   │   ├── .session-meta.json         Maps sessionId → {agentMode, lastUpdated, projectPath}
 *   │   └── memory/MEMORY.md           Persistent project memory
 *   │
 *   ├── plans/                         GLOBAL — not per-session
 *   │   └── {slug}.md                  Plan files (linked to sessions via slug field)
 *   │
 *   ├── todos/
 *   │   └── {sessionId}-agent-{sessionId}.json   Todo items per session
 *   │
 *   ├── tasks/{sessionId}/             Only exists if TaskCreate was used
 *   │   ├── .lock
 *   │   └── .highwatermark             Task ID counter
 *   │
 *   ├── file-history/{sessionId}/      Versioned backups of edited files
 *   │   └── {hash}@v{N}               e.g., 65c16cbbfa80f250@v3
 *   │
 *   ├── debug/                         Debug logs
 *   ├── shell-snapshots/               Terminal snapshots
 *   ├── paste-cache/                   Paste history
 *   └── statsig/                       Analytics
 *
 *
 * ── GIVEN A SESSION ID, HOW TO FIND EVERYTHING ─────────────────────────────
 *
 * You need TWO inputs: sessionId + projectDir (the working directory).
 * From those, everything is deterministic:
 *
 *   projectSlug = projectDir.replace(/\//g, '-')
 *   base        = {claudeDir}/projects/{projectSlug}
 *
 *   RELIABLE (deterministic paths):
 *   ┌──────────────────┬────────────────────────────────────────────────────────┐
 *   │ Artifact         │ Path                                                   │
 *   ├──────────────────┼────────────────────────────────────────────────────────┤
 *   │ Conversation     │ {base}/{sessionId}.jsonl                  (always)     │
 *   │ Sub-agents       │ {base}/{sessionId}/subagents/agent-*.jsonl (glob)      │
 *   │ Tool result cache│ {base}/{sessionId}/tool-results/*.txt      (glob)      │
 *   │ Todos            │ {claudeDir}/todos/{sessionId}-agent-{sessionId}.json   │
 *   │ Tasks            │ {claudeDir}/tasks/{sessionId}/         (may not exist) │
 *   │ File history     │ {claudeDir}/file-history/{sessionId}/  (may not exist) │
 *   └──────────────────┴────────────────────────────────────────────────────────┘
 *
 *   UNRELIABLE (requires JSONL parsing):
 *   ┌──────────────────┬────────────────────────────────────────────────────────┐
 *   │ Plan file        │ Read JSONL → extract `slug` field →                    │
 *   │                  │ {claudeDir}/plans/{slug}.md                            │
 *   │                  │ ⚠ Slug is NOT unique per session (10+ sessions can     │
 *   │                  │   share the same slug). Slug is sometimes null.        │
 *   │                  │ Fallback: search JSONL for Write tool calls targeting  │
 *   │                  │ ~/.claude/plans/*.md to find the actual plan file.     │
 *   ├──────────────────┼────────────────────────────────────────────────────────┤
 *   │ Session metadata │ {base}/.session-meta.json                              │
 *   │                  │ ⚠ May be in a DIFFERENT project slug if the agent's   │
 *   │                  │   cwd differs from the project root (e.g., running    │
 *   │                  │   from /project/agent/ puts metadata in               │
 *   │                  │   -project-agent/ not -project/).                     │
 *   └──────────────────┴────────────────────────────────────────────────────────┘
 *
 *
 * ── JSONL LINE SHAPES (each line is one JSON object) ───────────────────────
 *
 * type: "file-history-snapshot"  (usually line 1)
 *   { type, messageId, snapshot: { trackedFileBackups: { [path]: { backupFileName, version } }, timestamp } }
 *
 * type: "user" (user message)
 *   { type: "user", sessionId, slug, cwd, version, gitBranch, uuid, parentUuid, timestamp,
 *     message: { role: "user", content: [{ type: "text", text: "..." }] } }
 *
 * type: "user" (tool_result — SDK wraps results in a user message)
 *   { type: "user", uuid, parentUuid, timestamp,
 *     message: { role: "user", content: [{ type: "tool_result", tool_use_id, content: "FULL output" }] },
 *     toolUseResult: { type: "text", file?: { filePath, content: "FULL FILE CONTENT" } } }
 *
 * type: "assistant" (with thinking + tool_use)
 *   { type: "assistant", sessionId, uuid, parentUuid, timestamp, requestId,
 *     message: { model, id, role: "assistant",
 *       content: [
 *         { type: "thinking", thinking: "full reasoning..." },
 *         { type: "text", text: "visible response" },
 *         { type: "tool_use", id, name, input: {...} }
 *       ],
 *       usage: { input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens }
 *     } }
 *
 * type: "progress" (hook events)
 *   { type: "progress", parentUuid, parentToolUseID, toolUseID, timestamp,
 *     data: { type: "hook_progress", hookEvent, hookName, command } }
 *
 *
 * ── HOW ARTIFACTS RELATE TO EACH OTHER ─────────────────────────────────────
 *
 * Messages link via parentUuid chain (forms a linked list of the conversation).
 *
 * Sub-agents: Parent session sees Task tool_use + tool_result.
 *   The sub-agent's FULL work is in its own JSONL file under subagents/.
 *   The "queue-operation" events in the main JSONL map task_id to sub-agent filenames.
 *
 * Tool result cache: When a tool result exceeds the inline threshold, the SDK
 *   stores the full output in {sessionId}/tool-results/{hash}.txt and references
 *   it from the JSONL. The JSONL tool_result content may be truncated while the
 *   .txt file has the full content.
 *
 * Plans: Stored GLOBALLY in {claudeDir}/plans/{slug}.md — NOT per-session.
 *   The "slug" field in JSONL events is the link. Multiple sessions can share
 *   the same slug. A session's plan is found by: read JSONL → find slug → open
 *   plans/{slug}.md. If slug is null, search for Write calls to plans/*.md.
 *
 * Todos: One file per session-agent pair. May be empty [].
 *   Path is deterministic from sessionId alone.
 *
 * File history: Versioned backups of files the agent edited during the session.
 *   Only exists if Write/Edit tools were used.
 *
 * Session metadata (.session-meta.json): A SINGLE file per project slug that
 *   maps ALL session IDs → { agentMode, editMode, lastUpdated, projectPath }.
 *   Careful: the cwd when the agent ran determines which project slug folder
 *   the metadata ends up in.
 *
 *
 * ── KEY FACTS FOR BUILDING NEW FUNCTIONS ───────────────────────────────────
 *
 * 1. JSONL content is FULL and UNTRUNCATED — complete file reads, bash outputs,
 *    web search results, thinking blocks, assistant reasoning. No caps.
 *
 * 2. The SDK and CLI share the SAME storage. Sessions created by the SDK can
 *    be resumed via CLI and vice versa.
 *
 * 3. Storage location is controlled ONLY by CLAUDE_CONFIG_DIR env var + the
 *    project path slug derived from cwd. There is no sessionDir or outputPath
 *    option in the SDK.
 *
 * 4. JSONL files are written INCREMENTALLY by the SDK — new lines are appended.
 *    This enables the watchSessionFile() pattern for real-time tailing.
 *
 * 5. All functions accept SessionAccessOptions with optional claudeDir to
 *    override the default path resolution.
 *
 * 6. The projectSlug encoding is simple: replace all "/" with "-".
 *    /Users/newupgrade/Desktop/Developer/osborn → -Users-newupgrade-Desktop-Developer-osborn
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { existsSync, readFileSync, readdirSync, statSync, watch } from 'fs'
import { homedir } from 'os'
import { join, basename } from 'path'

// ============================================================
// TYPES
// ============================================================

export interface SessionPaths {
  /** Main conversation JSONL file */
  conversation: string
  /** Directory containing subagents/ and tool-results/ */
  sessionDir: string
  /** Sub-agent JSONL files (may be empty) */
  subagents: string[]
  /** Large tool result cache files (may be empty) */
  toolResults: string[]
  /** Todos JSON file */
  todos: string
  /** Tasks directory (may not exist) */
  tasks: string
  /** File history directory (may not exist) */
  fileHistory: string
  /** Debug log file (may not exist) */
  debugLog: string
  /** Whether the main conversation file exists */
  exists: boolean
}

export interface SessionMessage {
  type: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'progress' | 'file-history-snapshot' | 'other'
  timestamp?: string
  uuid?: string
  parentUuid?: string | null
  sessionId?: string
  slug?: string

  // For user/assistant messages
  role?: string
  text?: string

  // For tool_use
  toolName?: string
  toolId?: string
  toolInput?: Record<string, any>

  // For tool_result
  toolUseId?: string
  toolResultContent?: string
  toolUseResult?: any

  // Raw line for advanced access
  raw: any
}

export interface SubagentInfo {
  taskId: string
  filePath: string
  fileSize: number
  messages: SessionMessage[]
}

export interface SessionPlanInfo {
  slug: string
  planPath: string
  content: string
  exists: boolean
}

export interface ToolResultEntry {
  toolName: string
  toolId: string
  toolInput: Record<string, any>
  resultContent: string
  toolUseResult?: any
  timestamp?: string
}

/** Options passed to most functions — allows custom claude dir */
export interface SessionAccessOptions {
  /** Override the claude directory (default: CLAUDE_CONFIG_DIR env or ~/.claude) */
  claudeDir?: string
}

/** Main agent transcript + all sub-agent transcripts in one object */
export interface SessionTranscripts {
  /** The main session conversation (the agent itself) */
  agent: {
    sessionId: string
    filePath: string
    fileSize: number
    messages: SessionMessage[]
    rawLines: any[]
  }
  /** All sub-agent conversations spawned via Task tool */
  subagents: SubagentInfo[]
}

// ============================================================
// PATH RESOLUTION
// ============================================================

function resolveClaudeDir(opts?: SessionAccessOptions): string {
  return opts?.claudeDir || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

function projectPathToSlug(projectPath: string): string {
  return projectPath.replace(/\//g, '-')
}

/**
 * Resolve all artifact paths for a session.
 * Does NOT read any files — just computes paths and checks existence.
 *
 * @param sessionId - The session UUID
 * @param projectDir - The project working directory (e.g., /Users/.../osborn)
 * @param opts.claudeDir - Override the claude directory path
 */
export function getSessionPaths(sessionId: string, projectDir: string, opts?: SessionAccessOptions): SessionPaths {
  const claudeDir = resolveClaudeDir(opts)
  const slug = projectPathToSlug(projectDir)
  const projectsDir = join(claudeDir, 'projects', slug)
  const conversationPath = join(projectsDir, `${sessionId}.jsonl`)
  const sessionDir = join(projectsDir, sessionId)

  // Glob sub-agents
  const subagentsDir = join(sessionDir, 'subagents')
  let subagents: string[] = []
  if (existsSync(subagentsDir)) {
    subagents = readdirSync(subagentsDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => join(subagentsDir, f))
  }

  // Glob tool results
  const toolResultsDir = join(sessionDir, 'tool-results')
  let toolResults: string[] = []
  if (existsSync(toolResultsDir)) {
    toolResults = readdirSync(toolResultsDir)
      .filter(f => f.endsWith('.txt'))
      .map(f => join(toolResultsDir, f))
  }

  return {
    conversation: conversationPath,
    sessionDir,
    subagents,
    toolResults,
    todos: join(claudeDir, 'todos', `${sessionId}-agent-${sessionId}.json`),
    tasks: join(claudeDir, 'tasks', sessionId),
    fileHistory: join(claudeDir, 'file-history', sessionId),
    debugLog: join(claudeDir, 'debug', `${sessionId}.txt`),
    exists: existsSync(conversationPath),
  }
}

// ============================================================
// SUB-AGENT DISCOVERY
// ============================================================

export interface SubAgentInfo {
  agentId: string
  description: string
  status: string
  agentFile: string       // Full path to agent-{id}.jsonl
  agentFileExists: boolean
  totalTokens: number
  totalToolUseCount: number
  durationMs: number
}

/**
 * Find all sub-agents spawned by a session.
 * Extracts agentId from toolUseResult fields in the main JSONL,
 * then checks for corresponding agent-{id}.jsonl files at the project level.
 *
 * Sub-agent files live at: ~/.claude/projects/{slug}/agent-{id}.jsonl
 * (NOT inside the session subdirectory — that's only for the Osborn agent SDK path)
 */
export function getSessionSubAgents(sessionId: string, projectDir: string, opts?: SessionAccessOptions): SubAgentInfo[] {
  const claudeDir = resolveClaudeDir(opts)
  const slug = projectPathToSlug(projectDir)
  const projectsDir = join(claudeDir, 'projects', slug)
  const conversationPath = join(projectsDir, `${sessionId}.jsonl`)

  if (!existsSync(conversationPath)) return []

  const agents: SubAgentInfo[] = []
  const seenIds = new Set<string>()

  try {
    const content = readFileSync(conversationPath, 'utf-8')
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        const obj = JSON.parse(line)
        const tur = obj.toolUseResult
        if (tur && typeof tur === 'object' && tur.agentId) {
          const id = tur.agentId as string
          if (seenIds.has(id)) continue
          seenIds.add(id)

          const agentFile = join(projectsDir, `agent-${id}.jsonl`)
          agents.push({
            agentId: id,
            description: (tur.prompt || '').substring(0, 200),
            status: tur.status || '',
            agentFile,
            agentFileExists: existsSync(agentFile),
            totalTokens: tur.totalTokens || 0,
            totalToolUseCount: tur.totalToolUseCount || 0,
            durationMs: tur.totalDurationMs || 0,
          })
        }
      } catch {}
    }
  } catch {}

  return agents
}

/**
 * Get all searchable file paths for a session — main JSONL + all sub-agent JSOLs.
 * This is what the pipeline fast brain should ripgrep across.
 */
export function getSessionSearchPaths(sessionId: string, projectDir: string, opts?: SessionAccessOptions): string[] {
  const paths = getSessionPaths(sessionId, projectDir, opts)
  const files: string[] = []

  // Main conversation
  if (existsSync(paths.conversation)) {
    files.push(paths.conversation)
  }

  // Sub-agents from session subdirectory (Osborn agent SDK path)
  for (const f of paths.subagents) {
    if (existsSync(f)) files.push(f)
  }

  // Sub-agents at project level (Claude Code CLI path)
  const agents = getSessionSubAgents(sessionId, projectDir, opts)
  for (const a of agents) {
    if (a.agentFileExists && !files.includes(a.agentFile)) {
      files.push(a.agentFile)
    }
  }

  return files
}

// ============================================================
// JSONL PARSING
// ============================================================

/**
 * Parse a single JSONL line into a structured SessionMessage.
 */
function parseLine(raw: any): SessionMessage {
  const type = raw.type as string

  if (type === 'file-history-snapshot') {
    return { type: 'file-history-snapshot', raw, timestamp: raw.snapshot?.timestamp }
  }

  if (type === 'progress') {
    return {
      type: 'progress',
      raw,
      uuid: raw.uuid,
      parentUuid: raw.parentUuid,
      timestamp: raw.timestamp,
    }
  }

  if (type === 'user') {
    const content = raw.message?.content
    if (Array.isArray(content) && content.length > 0) {
      // Check if it's a tool_result
      if (content[0]?.type === 'tool_result') {
        const tr = content[0]
        return {
          type: 'tool_result',
          raw,
          uuid: raw.uuid,
          parentUuid: raw.parentUuid,
          timestamp: raw.timestamp,
          sessionId: raw.sessionId,
          slug: raw.slug,
          toolUseId: tr.tool_use_id,
          toolResultContent: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
          toolUseResult: raw.toolUseResult,
        }
      }

      // Regular user message
      const texts: string[] = []
      for (const block of content) {
        if (block?.type === 'text' && block.text) {
          texts.push(block.text)
        }
      }
      return {
        type: 'user',
        raw,
        role: 'user',
        text: texts.join('\n') || undefined,
        uuid: raw.uuid,
        parentUuid: raw.parentUuid,
        timestamp: raw.timestamp,
        sessionId: raw.sessionId,
        slug: raw.slug,
      }
    }
  }

  if (type === 'assistant') {
    const content = raw.message?.content
    const texts: string[] = []
    const toolUses: { name: string; id: string; input: any }[] = []

    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'text' && block.text) {
          texts.push(block.text)
        }
        if (block?.type === 'thinking' && block.thinking) {
          texts.push(`[thinking] ${block.thinking}`)
        }
        if (block?.type === 'tool_use') {
          toolUses.push({ name: block.name, id: block.id, input: block.input })
        }
      }
    }

    // If it has tool_use blocks, return those (there may also be text)
    if (toolUses.length > 0) {
      // Return the first tool_use (caller can access raw for all)
      return {
        type: 'tool_use',
        raw,
        uuid: raw.uuid,
        parentUuid: raw.parentUuid,
        timestamp: raw.timestamp,
        sessionId: raw.sessionId,
        slug: raw.slug,
        text: texts.join('\n') || undefined,
        toolName: toolUses[0].name,
        toolId: toolUses[0].id,
        toolInput: toolUses[0].input,
      }
    }

    return {
      type: 'assistant',
      raw,
      role: 'assistant',
      text: texts.join('\n') || undefined,
      uuid: raw.uuid,
      parentUuid: raw.parentUuid,
      timestamp: raw.timestamp,
      sessionId: raw.sessionId,
      slug: raw.slug,
    }
  }

  return { type: 'other', raw, timestamp: raw.timestamp }
}

/**
 * Read and parse a JSONL file into structured messages.
 */
function readJsonl(filePath: string): SessionMessage[] {
  if (!existsSync(filePath)) return []

  try {
    const content = readFileSync(filePath, 'utf-8')
    const lines = content.trim().split('\n').filter(Boolean)
    const messages: SessionMessage[] = []

    for (const line of lines) {
      try {
        const raw = JSON.parse(line)
        messages.push(parseLine(raw))
      } catch {
        // Skip malformed lines
      }
    }

    return messages
  } catch {
    return []
  }
}

/**
 * Read raw JSON objects from a JSONL file — no parsing into SessionMessage.
 * Returns the actual JSON as-is so you can inspect the full object shapes.
 */
export function readRawJsonl(filePath: string): any[] {
  if (!existsSync(filePath)) return []

  try {
    const content = readFileSync(filePath, 'utf-8')
    const lines = content.trim().split('\n').filter(Boolean)
    const objects: any[] = []

    for (const line of lines) {
      try {
        objects.push(JSON.parse(line))
      } catch {
        // Skip malformed lines
      }
    }

    return objects
  } catch {
    return []
  }
}

// ============================================================
// PUBLIC API
// ============================================================

/**
 * Read the full conversation history from a session.
 * Returns structured messages in chronological order.
 *
 * @param sessionId - The session UUID
 * @param projectDir - The project working directory (e.g., /Users/.../osborn)
 * @param opts.lastN - Only return the last N messages (default: all)
 * @param opts.types - Filter by message type (default: all types)
 * @param opts.claudeDir - Override the claude directory path
 */
export function readSessionHistory(
  sessionId: string,
  projectDir: string,
  opts?: {
    lastN?: number
    types?: SessionMessage['type'][]
    claudeDir?: string
  }
): SessionMessage[] {
  const paths = getSessionPaths(sessionId, projectDir, { claudeDir: opts?.claudeDir })
  let messages = readJsonl(paths.conversation)

  if (opts?.types) {
    messages = messages.filter(m => opts.types!.includes(m.type))
  }

  if (opts?.lastN) {
    messages = messages.slice(-opts.lastN)
  }

  return messages
}

/**
 * Get sub-agent transcripts for a session.
 * Each sub-agent has its own JSONL file with a full conversation.
 */
export function getSubagentTranscripts(
  sessionId: string,
  projectDir: string,
  opts?: SessionAccessOptions
): SubagentInfo[] {
  const paths = getSessionPaths(sessionId, projectDir, opts)

  return paths.subagents.map(filePath => {
    const filename = basename(filePath, '.jsonl')
    const taskId = filename.replace('agent-', '')
    const stats = statSync(filePath)
    const messages = readJsonl(filePath)

    return {
      taskId,
      filePath,
      fileSize: stats.size,
      messages,
    }
  })
}

/**
 * Get the raw JSON objects from the main session JSONL file.
 * Returns the actual JSON as written by the SDK — no transformation.
 * Use this when you need the full object shapes for inspection.
 *
 * @param lastN - Only return the last N lines (default: all)
 */
export function getRawSessionJsonl(
  sessionId: string,
  projectDir: string,
  opts?: SessionAccessOptions & { lastN?: number }
): any[] {
  const paths = getSessionPaths(sessionId, projectDir, opts)
  let lines = readRawJsonl(paths.conversation)

  if (opts?.lastN) {
    lines = lines.slice(-opts.lastN)
  }

  return lines
}

/**
 * Get the main agent transcript AND all sub-agent transcripts together.
 * This is the primary function for accessing what Claude is doing —
 * the agent's own conversation plus every sub-agent it spawned.
 *
 * The agent transcript contains: user messages, assistant reasoning,
 * tool_use calls, tool_result responses, thinking blocks, progress events.
 *
 * Sub-agent transcripts contain the same structure but for each Task
 * tool invocation (Explore agents, Plan agents, etc.).
 */
export function getSessionTranscripts(
  sessionId: string,
  projectDir: string,
  opts?: SessionAccessOptions
): SessionTranscripts {
  const paths = getSessionPaths(sessionId, projectDir, opts)

  // Read the main agent transcript
  const agentMessages = readJsonl(paths.conversation)
  const agentRawLines = readRawJsonl(paths.conversation)
  const agentFileSize = existsSync(paths.conversation)
    ? statSync(paths.conversation).size
    : 0

  // Read all sub-agent transcripts
  const subagents = getSubagentTranscripts(sessionId, projectDir, opts)

  return {
    agent: {
      sessionId,
      filePath: paths.conversation,
      fileSize: agentFileSize,
      messages: agentMessages,
      rawLines: agentRawLines,
    },
    subagents,
  }
}

/**
 * Find the plan file associated with a session.
 * Plans are linked via the `slug` field in JSONL events.
 *
 * Falls back to searching for Write tool calls targeting ~/.claude/plans/
 * if slug is not found.
 */
export function getSessionPlan(
  sessionId: string,
  projectDir: string,
  opts?: SessionAccessOptions
): SessionPlanInfo | null {
  const paths = getSessionPaths(sessionId, projectDir, opts)
  if (!paths.exists) return null

  const messages = readJsonl(paths.conversation)
  const claudeDir = resolveClaudeDir(opts)

  // Strategy 1: Extract slug from messages
  for (const msg of messages) {
    if (msg.slug && msg.slug !== 'null') {
      const planPath = join(claudeDir, 'plans', `${msg.slug}.md`)
      if (existsSync(planPath)) {
        try {
          const content = readFileSync(planPath, 'utf-8')
          return { slug: msg.slug, planPath, content, exists: true }
        } catch {
          return { slug: msg.slug, planPath, content: '', exists: true }
        }
      }
      // Slug found but plan file doesn't exist
      return { slug: msg.slug, planPath, content: '', exists: false }
    }
  }

  // Strategy 2: Search for Write tool calls targeting plans/
  for (const msg of messages) {
    if (msg.type === 'tool_use' && msg.toolName === 'Write') {
      const filePath = msg.toolInput?.file_path as string
      if (filePath && filePath.includes('.claude/plans/')) {
        const slug = basename(filePath, '.md')
        if (existsSync(filePath)) {
          try {
            const content = readFileSync(filePath, 'utf-8')
            return { slug, planPath: filePath, content, exists: true }
          } catch {
            return { slug, planPath: filePath, content: '', exists: true }
          }
        }
        return { slug, planPath: filePath, content: '', exists: false }
      }
    }
  }

  return null
}

/**
 * Get recent tool use/result pairs from a session.
 * Returns matched pairs of (tool_use → tool_result) in chronological order.
 *
 * @param lastN - Number of recent pairs to return (default: 10, 0 = all)
 * @param opts.toolNameFilter - Optional: only return results from these tool names (e.g., ['Read', 'WebSearch'])
 */
export function getRecentToolResults(
  sessionId: string,
  projectDir: string,
  lastN: number = 10,
  opts?: SessionAccessOptions & { toolNameFilter?: string[] }
): ToolResultEntry[] {
  const messages = readSessionHistory(sessionId, projectDir, { claudeDir: opts?.claudeDir })

  // Build a map of tool_use by tool ID
  const toolUseMap = new Map<string, SessionMessage>()
  const results: ToolResultEntry[] = []
  const toolFilter = opts?.toolNameFilter?.map(t => t.toLowerCase())

  for (const msg of messages) {
    if (msg.type === 'tool_use' && msg.toolId) {
      toolUseMap.set(msg.toolId, msg)
    }

    if (msg.type === 'tool_result' && msg.toolUseId) {
      const toolUse = toolUseMap.get(msg.toolUseId)
      if (toolUse) {
        // Apply tool name filter if provided
        if (toolFilter && !toolFilter.includes(toolUse.toolName!.toLowerCase())) {
          continue
        }
        results.push({
          toolName: toolUse.toolName!,
          toolId: toolUse.toolId!,
          toolInput: toolUse.toolInput || {},
          resultContent: msg.toolResultContent || '',
          toolUseResult: msg.toolUseResult,
          timestamp: toolUse.timestamp,
        })
      }
    }
  }

  return lastN > 0 ? results.slice(-lastN) : results
}

/**
 * Watch a session JSONL file for new entries.
 * Calls back with each new parsed entry as it's appended.
 *
 * Returns the fs.FSWatcher (call .close() to stop watching).
 */
export function watchSessionFile(
  sessionId: string,
  projectDir: string,
  callback: (entry: SessionMessage) => void,
  opts?: SessionAccessOptions
): ReturnType<typeof watch> | null {
  const paths = getSessionPaths(sessionId, projectDir, opts)
  if (!paths.exists) return null

  let lastSize = 0
  try {
    lastSize = statSync(paths.conversation).size
  } catch {
    return null
  }

  const watcher = watch(paths.conversation, (eventType) => {
    if (eventType !== 'change') return

    try {
      const currentSize = statSync(paths.conversation).size
      if (currentSize <= lastSize) return

      // Read the full file and extract only the new bytes
      const fullContent = readFileSync(paths.conversation, 'utf-8')
      const newPart = fullContent.substring(lastSize)
      lastSize = currentSize

      const newLines = newPart.trim().split('\n').filter(Boolean)
      for (const line of newLines) {
        try {
          const raw = JSON.parse(line)
          callback(parseLine(raw))
        } catch {
          // Skip malformed
        }
      }
    } catch {
      // File access error
    }
  })

  return watcher
}

/**
 * Get the session slug (human-readable name) from a session.
 */
export function getSessionSlug(sessionId: string, projectDir: string, opts?: SessionAccessOptions): string | null {
  const messages = readSessionHistory(sessionId, projectDir, { lastN: 5, claudeDir: opts?.claudeDir })
  for (const msg of messages) {
    if (msg.slug && msg.slug !== 'null') {
      return msg.slug
    }
  }
  return null
}

/**
 * Get todos for a session.
 */
export function getSessionTodos(sessionId: string, opts?: SessionAccessOptions): any[] {
  const todosPath = join(resolveClaudeDir(opts), 'todos', `${sessionId}-agent-${sessionId}.json`)
  if (!existsSync(todosPath)) return []

  try {
    return JSON.parse(readFileSync(todosPath, 'utf-8'))
  } catch {
    return []
  }
}

/**
 * Get the text-only conversation (user messages + assistant text responses).
 * Useful for building context for the fast brain.
 *
 * @param lastN - Number of exchanges to return
 * @param maxCharsPerMessage - Max chars per message (0 = no limit)
 */
export function getConversationText(
  sessionId: string,
  projectDir: string,
  lastN: number = 30,
  maxCharsPerMessage: number = 0,
  opts?: SessionAccessOptions
): { role: string; text: string }[] {
  const messages = readSessionHistory(sessionId, projectDir, {
    types: ['user', 'assistant'],
    claudeDir: opts?.claudeDir,
  })

  const exchanges = messages
    .filter(m => m.text)
    .map(m => ({
      role: m.role || m.type,
      text: maxCharsPerMessage > 0 ? m.text!.substring(0, maxCharsPerMessage) : m.text!,
    }))

  return exchanges.slice(-lastN)
}

/**
 * Search the session JSONL for entries matching a keyword (case-insensitive).
 * Searches across text, toolResultContent, toolName, and toolInput.
 * Returns matching entries with 500-char excerpts around the match.
 *
 * @param keyword - The search keyword (case-insensitive)
 * @param opts.maxResults - Maximum number of results to return (default: 20)
 */
export function searchSessionJsonl(
  sessionId: string,
  projectDir: string,
  keyword: string,
  opts?: SessionAccessOptions & { maxResults?: number }
): { type: string; text: string; timestamp?: string }[] {
  const messages = readSessionHistory(sessionId, projectDir, { claudeDir: opts?.claudeDir })
  const maxResults = opts?.maxResults || 20
  const results: { type: string; text: string; timestamp?: string }[] = []
  const lowerKeyword = keyword.toLowerCase()

  for (const msg of messages) {
    if (results.length >= maxResults) break

    // Search in text content
    if (msg.text && msg.text.toLowerCase().includes(lowerKeyword)) {
      const idx = msg.text.toLowerCase().indexOf(lowerKeyword)
      const start = Math.max(0, idx - 100)
      const end = Math.min(msg.text.length, idx + keyword.length + 400)
      const excerpt = (start > 0 ? '...' : '') + msg.text.substring(start, end) + (end < msg.text.length ? '...' : '')
      results.push({ type: msg.type, text: excerpt, timestamp: msg.timestamp })
      continue
    }

    // Search in tool result content
    if (msg.toolResultContent && msg.toolResultContent.toLowerCase().includes(lowerKeyword)) {
      const idx = msg.toolResultContent.toLowerCase().indexOf(lowerKeyword)
      const start = Math.max(0, idx - 100)
      const end = Math.min(msg.toolResultContent.length, idx + keyword.length + 400)
      const excerpt = `[tool_result] ` + (start > 0 ? '...' : '') + msg.toolResultContent.substring(start, end) + (end < msg.toolResultContent.length ? '...' : '')
      results.push({ type: msg.type, text: excerpt, timestamp: msg.timestamp })
      continue
    }

    // Search in tool name
    if (msg.toolName && msg.toolName.toLowerCase().includes(lowerKeyword)) {
      const inputPreview = msg.toolInput ? JSON.stringify(msg.toolInput).substring(0, 200) : ''
      results.push({ type: msg.type, text: `[${msg.toolName}: ${inputPreview}]`, timestamp: msg.timestamp })
      continue
    }

    // Search in tool input
    if (msg.toolInput) {
      const inputStr = JSON.stringify(msg.toolInput)
      if (inputStr.toLowerCase().includes(lowerKeyword)) {
        results.push({ type: msg.type, text: `[${msg.toolName || 'tool'}: ${inputStr.substring(0, 500)}]`, timestamp: msg.timestamp })
      }
    }
  }

  return results
}

/**
 * Get session stats: message counts, tool usage breakdown, data sizes.
 * Helps the fast brain decide how much data to read and which tools to query.
 */
export function getSessionStats(sessionId: string, projectDir: string, opts?: SessionAccessOptions): {
  totalMessages: number
  userMessages: number
  assistantMessages: number
  toolUseCount: number
  toolResultCount: number
  toolBreakdown: Record<string, number>
  subagentCount: number
  fileSizeBytes: number
  firstTimestamp?: string
  lastTimestamp?: string
} | null {
  const paths = getSessionPaths(sessionId, projectDir, opts)
  if (!paths.exists) return null

  const messages = readJsonl(paths.conversation)
  const toolBreakdown: Record<string, number> = {}

  let userMessages = 0
  let assistantMessages = 0
  let toolUseCount = 0
  let toolResultCount = 0

  for (const msg of messages) {
    if (msg.type === 'user') userMessages++
    else if (msg.type === 'assistant') assistantMessages++
    else if (msg.type === 'tool_use') {
      toolUseCount++
      const name = msg.toolName || 'unknown'
      toolBreakdown[name] = (toolBreakdown[name] || 0) + 1
    }
    else if (msg.type === 'tool_result') toolResultCount++
  }

  return {
    totalMessages: messages.length,
    userMessages,
    assistantMessages,
    toolUseCount,
    toolResultCount,
    toolBreakdown,
    subagentCount: paths.subagents.length,
    fileSizeBytes: existsSync(paths.conversation) ? statSync(paths.conversation).size : 0,
    firstTimestamp: messages.find(m => m.timestamp)?.timestamp,
    lastTimestamp: [...messages].reverse().find(m => m.timestamp)?.timestamp,
  }
}

/**
 * Get a quick summary of a session: slug, message count, timestamps, tools used.
 */
export function getSessionSummary(sessionId: string, projectDir: string, opts?: SessionAccessOptions) {
  const paths = getSessionPaths(sessionId, projectDir, opts)
  if (!paths.exists) return null

  const messages = readJsonl(paths.conversation)
  const userMessages = messages.filter(m => m.type === 'user')
  const assistantMessages = messages.filter(m => m.type === 'assistant')
  const toolUses = messages.filter(m => m.type === 'tool_use')
  const uniqueTools = Array.from(new Set(toolUses.map(t => t.toolName).filter(Boolean)))

  const firstTimestamp = messages.find(m => m.timestamp)?.timestamp
  const lastTimestamp = [...messages].reverse().find(m => m.timestamp)?.timestamp
  const slug = messages.find(m => m.slug && m.slug !== 'null')?.slug

  return {
    sessionId,
    slug,
    messageCount: messages.length,
    userMessages: userMessages.length,
    assistantMessages: assistantMessages.length,
    toolUseCount: toolUses.length,
    uniqueTools,
    subagentCount: paths.subagents.length,
    firstTimestamp,
    lastTimestamp,
    fileSize: existsSync(paths.conversation) ? statSync(paths.conversation).size : 0,
  }
}
