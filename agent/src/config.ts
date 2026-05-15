import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { parse, stringify } from 'yaml'
import type { McpServerConfig } from './claude-handler.js'

// Config file paths
const CONFIG_DIR = join(homedir(), '.osborn')
const CONFIG_FILE = join(CONFIG_DIR, 'config.yaml')

// Voice mode options
// - 'direct': STT → Claude Agent SDK → TTS (current default, uses Claude for everything)
// - 'realtime': OpenAI/Gemini native speech-to-speech models (faster, no coding tools)
export type VoiceMode = 'direct' | 'realtime' | 'pipeline'

// Legacy type aliases — kept for backward compatibility with session metadata
export type EditMode = 'read-only' | 'edit'
export type AgentMode = 'plan' | 'execute' | 'research'

// Realtime provider options (only for 'realtime' mode)
export type RealtimeProvider = 'openai' | 'gemini'

// STT provider options
export type STTProvider = 'deepgram' | 'groq-whisper' | 'openai-whisper'

// TTS provider options
export type TTSProvider = 'gemini' | 'openai' | 'elevenlabs' | 'deepgram'

// Bridge LLM provider options
export type BridgeLLMProvider = 'gemini-pro' | 'gpt-4o'

// Realtime mode configuration (OpenAI/Gemini native speech-to-speech)
export interface RealtimeConfig {
  provider?: RealtimeProvider
  // OpenAI options
  openaiVoice?: 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer'
  openaiModel?: string
  // Gemini options
  geminiVoice?: 'Aoede' | 'Charon' | 'Kore' | 'Fenrir' | 'Puck'
  geminiModel?: string
}

// Direct mode configuration (STT → Claude Agent SDK → TTS)
export interface DirectConfig {
  stt?: {
    provider?: STTProvider
    model?: string
    language?: string
  }
  tts?: {
    provider?: TTSProvider
    model?: string
    voice?: string
  }
}

// Pipeline-direct mode configuration (STT → Claude + parallel fast brain)
export interface PipelineDirectConfig extends DirectConfig {
  enableCollisionGuard?: boolean  // default false = monitoring only
}

// Legacy pipelined mode configuration (kept for backwards compatibility)
export interface PipelinedConfig {
  stt?: {
    provider?: STTProvider
    model?: string
    language?: string
  }
  llm?: {
    provider?: BridgeLLMProvider
    model?: string
  }
  tts?: {
    provider?: TTSProvider
    model?: string
    voice?: string
  }
}

export interface OsbornConfig {
  // Working directory for the coding agent
  workingDirectory?: string

  // MCP servers configuration
  mcpServers?: Record<string, McpServerConfigYaml>

  // Default voice provider (for realtime mode)
  defaultProvider?: 'gemini' | 'openai'

  // Default coding agent
  defaultCodingAgent?: 'claude' | 'codex'

  // Voice mode: 'direct' (STT+Claude+TTS) or 'realtime' (OpenAI/Gemini native)
  voiceMode?: VoiceMode

  // Realtime mode configuration (used when voiceMode='realtime')
  realtime?: RealtimeConfig

  // Direct mode configuration (used when voiceMode='direct')
  direct?: DirectConfig

  // Pipeline-direct mode configuration (used when voiceMode='pipeline-direct')
  'pipeline-direct'?: PipelineDirectConfig

  // Legacy pipelined mode configuration (deprecated, use 'direct' instead)
  pipelined?: PipelinedConfig
}

interface McpServerConfigYaml {
  enabled?: boolean
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string // For SSE/HTTP transport
  transport?: 'stdio' | 'sse' | 'http'
}

// ============================================================
// MCP SERVER CATALOG - Known MCP servers with metadata
// ============================================================

export interface McpCatalogEntry {
  name: string
  description: string
  serverKey: string
  category: 'code' | 'web' | 'data' | 'utility'
  // stdio transport (local)
  command?: string
  args?: string[]
  env?: Record<string, string>
  requiredEnvVars?: string[]
  // http/sse transport (cloud-hosted)
  transport?: 'stdio' | 'http' | 'sse'
  url?: string
  headers?: Record<string, string>
  requiredHeaders?: string[] // env var names needed for headers
}

export const MCP_CATALOG: McpCatalogEntry[] = [
  // ── Cloud-hosted via Smithery Connect (no local install) ──────
  // URLs are Smithery proxy endpoints: api.smithery.ai/connect/{namespace}/{connectionId}/mcp
  // Note: Claude Agent SDK's type:'http' has a known bug (#18296) that forces OAuth on all
  // HTTP MCP servers, so these are connected via in-process proxy (smithery-proxy.ts) as type:'sdk'.
  {
    name: 'GitHub', description: 'Repos, issues, PRs, code search (40 tools)',
    serverKey: 'github', category: 'code',
    transport: 'http',
    url: 'https://api.smithery.ai/connect/deer-y2fs/github-87nz/mcp',
    requiredHeaders: ['SMITHERY_API_KEY'],
  },
  {
    name: 'YouTube', description: 'Video search, transcripts, channels, playlists (7 tools)',
    serverKey: 'youtube', category: 'web',
    transport: 'http',
    url: 'https://api.smithery.ai/connect/deer-y2fs/youtube-mcp-sfiorini-TRmB/mcp',
    requiredHeaders: ['SMITHERY_API_KEY'],
  },
  // ── Local (stdio) ────────────────────────────────────────────
  {
    name: 'Filesystem', description: 'Access directories outside working dir',
    serverKey: 'filesystem', category: 'utility',
    command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
  },
  {
    name: 'Playwright', description: 'Browser automation & web scraping',
    serverKey: 'playwright', category: 'web',
    command: 'npx', args: ['-y', '@anthropic-ai/mcp-server-playwright'],
  },
]

export interface McpServerStatus {
  serverKey: string
  name: string
  description: string
  category: McpCatalogEntry['category']
  transport: 'stdio' | 'http' | 'sse'
  enabled: boolean
  available: boolean        // false when requiredEnvVars are missing
  missingEnvVars?: string[] // which env vars are missing
  source: 'catalog' | 'config' // where the definition came from
}

// Default config template
// Note: workingDirectory is intentionally OMITTED here. Baking process.cwd() into the
// default config at module-load time freezes whatever directory osborn happened to be
// invoked from on first boot — which on cloud sandboxes can be the npm install dir
// (`/usr/local/nvm/.../osborn`) and gets persisted to ~/.osborn/config.yaml forever.
// Leaving it undefined lets the runtime self-heal in index.ts resolve it on every boot
// from OSBORN_CWD → process.cwd() at the actual time the agent starts.
const DEFAULT_CONFIG: OsbornConfig = {
  defaultProvider: 'gemini',
  defaultCodingAgent: 'claude',
  // Voice mode: 'direct' (Claude Agent SDK) or 'realtime' (OpenAI/Gemini native)
  voiceMode: 'direct',
  // Realtime mode config (used when voiceMode='realtime')
  realtime: {
    provider: 'openai',
    openaiVoice: 'alloy',
    geminiVoice: 'Aoede',
    geminiModel: 'gemini-2.5-flash-native-audio-preview-12-2025',
  },
  // Direct mode config (used when voiceMode='direct')
  direct: {
    stt: {
      provider: 'deepgram',
      model: 'nova-3',
    },
    tts: {
      provider: 'deepgram',
      voice: 'aura-2-asteria-en',
    },
  },
  mcpServers: {
    // ─────────────────────────────────────────────────────────────────────────
    // MCP Servers for Read-Only Plan Mode
    // These extend Claude's capabilities with external tools
    // Enable by setting 'enabled: true' and providing required env vars
    // ─────────────────────────────────────────────────────────────────────────

    // GitHub MCP - Repository browsing, issues, PRs, code search
    // Read-only tools: get_file_contents, list_issues, get_issue, list_pull_requests,
    //                  get_pull_request, search_repositories, search_code, get_commit, list_commits
    // Edit tools (blocked in read-only mode): create_issue, create_pull_request, push_files, etc.
    // github: {
    //   enabled: true,
    //   command: 'npx',
    //   args: ['-y', '@modelcontextprotocol/server-github'],
    //   env: {
    //     GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_TOKEN}',
    //   },
    // },

    // YouTube MCP - Fetch video transcripts for analysis
    // Read-only tools: get_transcript
    // Requires: yt-dlp installed (brew install yt-dlp or pip install yt-dlp)
    // youtube: {
    //   enabled: true,
    //   command: 'npx',
    //   args: ['mcp-youtube'],
    // },

    // Filesystem MCP - Access to specific directories
    // Read-only tools: read_file, list_directory, get_file_info
    // Edit tools (blocked in read-only mode): write_file, create_directory, delete_file
    // filesystem: {
    //   enabled: true,
    //   command: 'npx',
    //   args: ['-y', '@modelcontextprotocol/server-filesystem', '/allowed/path'],
    // },
  },
}

/**
 * Resolve environment variable references in a string
 * e.g., "${GITHUB_TOKEN}" becomes the value of process.env.GITHUB_TOKEN
 */
function resolveEnvVar(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    return process.env[envVar] || ''
  })
}

/**
 * Resolve environment variables in an object of strings
 */
function resolveEnvVars(env?: Record<string, string>): Record<string, string> | undefined {
  if (!env) return undefined
  const resolved: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    resolved[key] = resolveEnvVar(value)
  }
  return resolved
}

/**
 * Load configuration from ~/.osborn/config.yaml
 * Creates default config if it doesn't exist
 */
export function loadConfig(): OsbornConfig {
  // Ensure config directory exists
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true })
    console.log(`📁 Created config directory: ${CONFIG_DIR}`)
  }

  // Create default config if it doesn't exist
  if (!existsSync(CONFIG_FILE)) {
    const defaultYaml = stringify(DEFAULT_CONFIG)
    writeFileSync(CONFIG_FILE, defaultYaml, 'utf-8')
    console.log(`📝 Created default config: ${CONFIG_FILE}`)
    return DEFAULT_CONFIG
  }

  // Load and parse config
  try {
    const content = readFileSync(CONFIG_FILE, 'utf-8')
    const config = parse(content) as OsbornConfig
    console.log(`📋 Loaded config from: ${CONFIG_FILE}`)
    return config
  } catch (err) {
    console.error(`❌ Failed to load config: ${(err as Error).message}`)
    return DEFAULT_CONFIG
  }
}

/**
 * Get enabled MCP servers in the format expected by Claude Agent SDK
 */
export function getMcpServers(config: OsbornConfig): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {}

  if (!config.mcpServers) {
    return servers
  }

  for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
    // Skip disabled servers
    if (serverConfig.enabled === false) {
      continue
    }

    // Build the McpServerConfig for Claude Agent SDK
    if (serverConfig.command) {
      servers[name] = {
        command: serverConfig.command,
        args: serverConfig.args,
        env: resolveEnvVars(serverConfig.env),
      }
    } else if (serverConfig.url) {
      servers[name] = {
        type: (serverConfig.transport || 'http') as 'http' | 'sse',
        url: serverConfig.url,
      }
    }
  }

  return servers
}

/**
 * Get list of enabled MCP server names (for display)
 */
export function getEnabledMcpServerNames(config: OsbornConfig): string[] {
  if (!config.mcpServers) return []

  return Object.entries(config.mcpServers)
    .filter(([_, serverConfig]) => serverConfig.enabled !== false && (serverConfig.command || serverConfig.url))
    .map(([name, _]) => name)
}

/**
 * Get pipelined config with defaults merged
 */
export function getPipelinedConfig(config: OsbornConfig): Required<PipelinedConfig> {
  const defaults = DEFAULT_CONFIG.pipelined!
  const userConfig = config.pipelined || {}

  return {
    stt: {
      provider: userConfig.stt?.provider || defaults.stt!.provider!,
      model: userConfig.stt?.model,
      language: userConfig.stt?.language || 'en',
    },
    llm: {
      provider: userConfig.llm?.provider || defaults.llm!.provider!,
      model: userConfig.llm?.model,
    },
    tts: {
      provider: userConfig.tts?.provider || defaults.tts!.provider!,
      model: userConfig.tts?.model,
      voice: userConfig.tts?.voice || defaults.tts!.voice,
    },
  }
}

/**
 * Get voice mode from config
 */
export function getVoiceMode(config: OsbornConfig): VoiceMode {
  return config.voiceMode || 'direct'
}

/**
 * Get realtime config with defaults merged
 */
export function getRealtimeConfig(config: OsbornConfig): Required<RealtimeConfig> {
  const defaults = DEFAULT_CONFIG.realtime!
  const userConfig = config.realtime || {}

  return {
    provider: userConfig.provider || defaults.provider!,
    openaiVoice: userConfig.openaiVoice || defaults.openaiVoice!,
    openaiModel: userConfig.openaiModel || 'gpt-4o-realtime-preview',
    geminiVoice: userConfig.geminiVoice || defaults.geminiVoice!,
    geminiModel: userConfig.geminiModel || defaults.geminiModel!,
  }
}

/**
 * Get direct mode config with defaults merged
 */
export function getDirectConfig(config: OsbornConfig): Required<DirectConfig> {
  const defaults = DEFAULT_CONFIG.direct!
  const userConfig = config.direct || {}

  return {
    stt: {
      provider: userConfig.stt?.provider || defaults.stt!.provider!,
      model: userConfig.stt?.model || defaults.stt!.model,
      language: userConfig.stt?.language || 'en',
    },
    tts: {
      provider: userConfig.tts?.provider || defaults.tts!.provider!,
      model: userConfig.tts?.model || defaults.tts!.model,
      voice: userConfig.tts?.voice || defaults.tts!.voice,
    },
  }
}

/**
 * Save config to file
 */
export function saveConfig(config: OsbornConfig): void {
  try {
    const yaml = stringify(config)
    writeFileSync(CONFIG_FILE, yaml, 'utf-8')
    console.log(`💾 Saved config to: ${CONFIG_FILE}`)
  } catch (err) {
    console.error(`❌ Failed to save config: ${(err as Error).message}`)
  }
}

/**
 * Get MCP tool patterns for allowedTools based on configured servers
 * Returns wildcard patterns like 'mcp__github__.*' for each enabled server
 */
export function getMcpToolPatterns(config: OsbornConfig): string[] {
  if (!config.mcpServers) return []

  return Object.entries(config.mcpServers)
    .filter(([_, serverConfig]) => serverConfig.enabled !== false && (serverConfig.command || serverConfig.url))
    .map(([name, _]) => `mcp__${name}__*`)
}

/**
 * Get MCP server status list — merges catalog entries with user config.
 * Checks env var availability so the UI can show disabled toggles.
 */
export function getMcpServerStatusList(config: OsbornConfig): McpServerStatus[] {
  const result: McpServerStatus[] = []
  const seenKeys = new Set<string>()

  // 1. Catalog entries — enriched with user config overrides
  for (const entry of MCP_CATALOG) {
    seenKeys.add(entry.serverKey)
    const userConfig = config.mcpServers?.[entry.serverKey]
    const transport = entry.transport || 'stdio'

    // Check required env vars (stdio) or required headers (http/sse)
    const requiredVars = transport === 'stdio'
      ? (entry.requiredEnvVars || [])
      : (entry.requiredHeaders || [])
    const missingVars = requiredVars.filter(v => !process.env[v])
    const available = missingVars.length === 0

    result.push({
      serverKey: entry.serverKey,
      name: entry.name,
      description: entry.description,
      category: entry.category,
      transport,
      enabled: userConfig?.enabled === true,
      available,
      missingEnvVars: missingVars.length > 0 ? missingVars : undefined,
      source: 'catalog',
    })
  }

  // 2. User-config-only entries (not in catalog)
  if (config.mcpServers) {
    for (const [key, serverConfig] of Object.entries(config.mcpServers)) {
      if (seenKeys.has(key)) continue
      if (!serverConfig.command && !serverConfig.url) continue
      const transport = serverConfig.transport || (serverConfig.url ? 'http' : 'stdio')

      result.push({
        serverKey: key,
        name: key,
        description: 'Custom MCP server',
        category: 'utility',
        transport,
        enabled: serverConfig.enabled !== false,
        available: true,
        source: 'config',
      })
    }
  }

  return result
}

/**
 * Build McpServerConfig records for a given set of enabled keys.
 * Merges catalog defaults with user config overrides.
 */
export function buildMcpServersForKeys(
  config: OsbornConfig,
  enabledKeys: string[]
): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {}

  for (const key of enabledKeys) {
    // Try catalog first
    const catalogEntry = MCP_CATALOG.find(e => e.serverKey === key)
    // Then user config
    const userConfig = config.mcpServers?.[key]

    if (catalogEntry) {
      const transport = userConfig?.transport || catalogEntry.transport || 'stdio'
      if (transport === 'http' || transport === 'sse') {
        const resolvedHeaders = resolveEnvVars(catalogEntry.headers)
        const config: any = {
          type: transport,
          url: userConfig?.url || catalogEntry.url!,
        }
        if (resolvedHeaders && Object.keys(resolvedHeaders).length > 0) {
          config.headers = resolvedHeaders
        }
        console.log(`🔌 MCP config for ${key}:`, JSON.stringify(config))
        servers[key] = config
      } else {
        servers[key] = {
          command: userConfig?.command || catalogEntry.command!,
          args: userConfig?.args || catalogEntry.args,
          env: resolveEnvVars(userConfig?.env || catalogEntry.env),
        }
      }
    } else if (userConfig?.command) {
      servers[key] = {
        command: userConfig.command,
        args: userConfig.args,
        env: resolveEnvVars(userConfig.env),
      }
    } else if (userConfig?.url) {
      servers[key] = {
        type: (userConfig.transport || 'http') as 'http' | 'sse',
        url: userConfig.url,
      }
    }
  }

  return servers
}

// ============================================================
// SESSION MANAGEMENT - For resuming previous conversations
// ============================================================

import * as readline from 'readline'
import { createReadStream, statSync, readdirSync } from 'fs'

/**
 * Session metadata for listing available sessions
 */
export interface SessionInfo {
  sessionId: string
  projectPath: string
  timestamp: Date
  lastMessage?: string
  messageCount: number
  filePath: string
}

/**
 * Get the .claude projects directory
 */
export function getClaudeProjectsDir(): string {
  return join(homedir(), '.claude', 'projects')
}

/**
 * Convert a project path to the .claude folder naming format
 * e.g., /Users/foo/bar -> -Users-foo-bar
 */
function projectPathToClaudeFolderName(projectPath: string): string {
  return projectPath.replace(/\//g, '-')
}

/**
 * Get the session storage directory for a specific project
 */
export function getSessionDir(projectPath: string): string {
  const claudeFolderName = projectPathToClaudeFolderName(projectPath)
  return join(getClaudeProjectsDir(), claudeFolderName)
}

/**
 * List all available sessions for the current project
 */
export async function listSessions(projectPath?: string): Promise<SessionInfo[]> {
  const targetPath = projectPath || process.cwd()
  const sessionDir = getSessionDir(targetPath)

  if (!existsSync(sessionDir)) {
    return []
  }

  const files = readdirSync(sessionDir)
  // Session files are UUIDs ending in .jsonl (no dashes except in UUID itself)
  const sessionFiles = files.filter(f =>
    f.endsWith('.jsonl') &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i.test(f)
  )

  const sessions: SessionInfo[] = []

  for (const file of sessionFiles) {
    const sessionId = file.replace('.jsonl', '')

    const filePath = join(sessionDir, file)

    try {
      const stats = statSync(filePath)
      // Only include non-empty sessions with real conversation (> 2 messages)
      if (stats.size > 0) {
        const info = await getSessionPreview(filePath)
        if (info.messageCount > 2) {
          sessions.push({
            sessionId,
            projectPath: targetPath,
            timestamp: stats.mtime,
            lastMessage: info.lastMessage,
            messageCount: info.messageCount,
            filePath,
          })
        }
      }
    } catch {
      // Skip invalid sessions
    }
  }

  // Sort by timestamp, most recent first
  sessions.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())

  return sessions
}

/**
 * Get a preview of a session (last message and count)
 */
async function getSessionPreview(filePath: string): Promise<{ lastMessage?: string; messageCount: number }> {
  return new Promise((resolve) => {
    let messageCount = 0
    let lastUserMessage: string | undefined

    const fileStream = createReadStream(filePath)
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    })

    rl.on('line', (line) => {
      if (!line.trim()) return

      try {
        const entry = JSON.parse(line)
        if (entry.type === 'user' || entry.type === 'assistant') {
          messageCount++
        }
        if (entry.type === 'user' && entry.message?.content) {
          // Extract text from user message
          const content = entry.message.content
          if (typeof content === 'string') {
            lastUserMessage = content.substring(0, 100)
          } else if (Array.isArray(content)) {
            const textPart = content.find((p: any) => p.type === 'text')
            if (textPart?.text) {
              lastUserMessage = textPart.text.substring(0, 100)
            }
          }
        }
      } catch {
        // Skip malformed lines
      }
    })

    rl.on('close', () => {
      resolve({ lastMessage: lastUserMessage, messageCount })
    })

    rl.on('error', () => {
      resolve({ messageCount: 0 })
    })
  })
}

/**
 * Get the most recent session ID for the current project
 */
export async function getMostRecentSessionId(projectPath?: string): Promise<string | null> {
  const sessions = await listSessions(projectPath)
  return sessions.length > 0 ? sessions[0].sessionId : null
}

/**
 * Check if a session exists
 */
export function sessionExists(sessionId: string, projectPath?: string): boolean {
  const targetPath = projectPath || process.cwd()
  const sessionDir = getSessionDir(targetPath)
  const sessionFile = join(sessionDir, `${sessionId}.jsonl`)
  return existsSync(sessionFile)
}

// ============================================================
// ALL-PROJECTS SESSION SCANNER — Lists every Claude session on the machine
// ============================================================

export interface ClaudeSessionEntry {
  sessionId: string
  projectSlug: string     // e.g., "-Users-foo-my-project"
  projectPath: string     // reverse slug → original path (best-effort)
  cwd: string             // actual cwd from JSONL first-line metadata
  timestamp: Date         // file mtime (most recent write)
  lastMessage?: string    // last user message
  messageCount: number    // user+assistant message count
  filePath: string        // full path to the .jsonl file
  fileSize: number        // bytes
}

/**
 * Reverse a project slug back to a path — LAST-RESORT fallback only.
 *
 * Claude's slug encoding (`/` → `-`, `.` → `-`) is LOSSY: you can't tell from a
 * slug whether a given `-` was originally `/`, `.`, or a literal `-` inside a
 * directory name like `pensive-bohr`. So this function cannot reliably
 * round-trip an arbitrary path.
 *
 * Strategy: produce the naive guess (with a small `--` → `/.` improvement for
 * dot-directories like `.claude`), then VALIDATE it with `existsSync`. If the
 * guess doesn't exist, return empty string — that way the caller knows the
 * reverse failed and can fall back cleanly instead of passing a broken path
 * to `child_process.spawn` and crashing with ENOENT.
 *
 * The primary source of cwd is `extractCwd()` which reads the actual cwd from
 * the JSONL file. This function is only reached when that fails.
 */
function slugToPath(slug: string): string {
  // Naive reverse: leading `-` → `/`, `--` → `/.`, remaining `-` → `/`.
  // The `--` → `/.` pass handles dot-prefixed directories like `.claude`.
  const guess = slug
    .replace(/^-/, '/')
    .replace(/--/g, '/.')
    .replace(/-/g, '/')
  // Validate — lossy encoding means we cannot trust the guess.
  return existsSync(guess) ? guess : ''
}

const UUID_JSONL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i

/**
 * Extract cwd from the first JSONL entry that carries a `cwd` field.
 *
 * Previously: read only the first 8KB and only accepted `type === 'user'`. That
 * broke for sessions whose first JSONL entry was larger than 8KB — e.g. a
 * `queue-operation` containing pasted email/page text. readline never emits the
 * `line` event for an incomplete final chunk, so the scan finds nothing,
 * `listAllClaudeSessions` falls through to the lossy `slugToPath` reverse, and
 * the mangled path ends up as a `cwd` passed to `child_process.spawn`, producing
 * the misleading "Claude Code executable not found" error (see MEMORY bug #11).
 *
 * Now: stream line-by-line with no byte cap, short-circuit on the first entry
 * with a `cwd` field regardless of `type` (every `user` / `attachment` /
 * `assistant` / `system` entry in a Claude JSONL session carries `cwd`, so the
 * scan finishes in the first few KB of any normal session).
 */
async function extractCwd(filePath: string): Promise<string> {
  return new Promise((resolve) => {
    const fileStream = createReadStream(filePath)
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity })
    let resolved = false
    const done = (value: string) => {
      if (resolved) return
      resolved = true
      try { rl.close() } catch {}
      try { fileStream.destroy() } catch {}
      resolve(value)
    }
    rl.on('line', (line) => {
      if (resolved) return
      if (!line.trim()) return
      try {
        const obj = JSON.parse(line)
        if (typeof obj?.cwd === 'string' && obj.cwd.length > 0) {
          done(obj.cwd)
        }
      } catch {}
    })
    rl.on('close', () => done(''))
    rl.on('error', () => done(''))
  })
}

/**
 * Scan ALL Claude Code projects for sessions.
 * Returns lightweight metadata for every main session JSONL across all projects.
 * Uses existing getSessionPreview() for last message + message count.
 *
 * @param limit - Max sessions to return (default 100, sorted by recency)
 */
export async function listAllClaudeSessions(limit = 100): Promise<ClaudeSessionEntry[]> {
  const projectsDir = getClaudeProjectsDir()
  if (!existsSync(projectsDir)) return []

  // 1. Discover all project folders
  const projectFolders = readdirSync(projectsDir).filter(name => {
    const fullPath = join(projectsDir, name)
    try { return statSync(fullPath).isDirectory() } catch { return false }
  })

  // 2. Collect all JSONL files with stat info (fast — no file reads yet)
  const candidates: { filePath: string; slug: string; sessionId: string; mtime: Date; size: number }[] = []

  for (const slug of projectFolders) {
    const projectDir = join(projectsDir, slug)
    try {
      const files = readdirSync(projectDir)
      for (const file of files) {
        if (!UUID_JSONL_RE.test(file)) continue
        const fullPath = join(projectDir, file)
        try {
          const stats = statSync(fullPath)
          if (stats.size > 500) { // Skip trivially small files
            candidates.push({
              filePath: fullPath,
              slug,
              sessionId: file.replace('.jsonl', ''),
              mtime: stats.mtime,
              size: stats.size,
            })
          }
        } catch {}
      }
    } catch {}
  }

  // 3. Sort by mtime descending, take top N for detailed reads
  candidates.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
  const topCandidates = candidates.slice(0, limit)

  // 4. Read metadata using existing getSessionPreview + cwd extraction
  const sessions: ClaudeSessionEntry[] = []

  for (const c of topCandidates) {
    try {
      const [preview, cwd] = await Promise.all([
        getSessionPreview(c.filePath),
        extractCwd(c.filePath),
      ])

      if (preview.messageCount < 2) continue

      // SLUG-FIRST: prefer the slug-derived path over the content cwd.
      //
      // Claude Code's `--resume <id>` looks up sessions by file LOCATION
      // (slug folder under ~/.claude/projects/), not by the cwd field inside
      // the JSONL. The JSONL content cwd is immutable historical metadata —
      // it's where the session was ORIGINALLY recorded (e.g. sprite path
      // /home/sprite/workspace or /workspaces/codespaces-blank). On migration
      // (sprite → fly), files were finalized into a new slug but their
      // content still records the original cwd.
      //
      // The dashboard forwards this field as `workingDirectory` to the
      // agent, which uses it as Claude Code's spawn cwd. If it doesn't
      // match the slug, the spawn lands in the wrong folder and resume
      // errors with "No conversation found". The slug is the source of
      // truth for where the file lives on disk; use it.
      //
      // Content cwd is kept as a last-resort fallback only when slug
      // reversal fails (slugToPath validates with existsSync and returns
      // '' on ambiguous encodings like dir names containing literal '-').
      const slugPath = slugToPath(c.slug)
      sessions.push({
        sessionId: c.sessionId,
        projectSlug: c.slug,
        projectPath: slugPath || cwd,
        cwd: slugPath || cwd,
        timestamp: c.mtime,
        lastMessage: preview.lastMessage,
        messageCount: preview.messageCount,
        filePath: c.filePath,
        fileSize: c.size,
      })
    } catch {}
  }

  return sessions
}

/**
 * Session summary for context briefing when switching sessions
 */
export interface SessionSummary {
  sessionId: string
  messageCount: number
  lastMessages: string[]  // Last 3-5 user messages for context
}

/**
 * Get a summary of a session for context briefing
 * Extracts last few messages and mode info for realtime agent
 */
export async function getSessionSummary(
  sessionId: string,
  projectPath: string
): Promise<SessionSummary | null> {
  const sessionDir = getSessionDir(projectPath)
  const filePath = join(sessionDir, `${sessionId}.jsonl`)

  if (!existsSync(filePath)) return null

  // Parse JSONL to extract last messages
  const lastMessages: string[] = []
  let messageCount = 0

  return new Promise((resolve) => {
    const fileStream = createReadStream(filePath)
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    })

    rl.on('line', (line) => {
      if (!line.trim()) return

      try {
        const entry = JSON.parse(line)
        if (entry.type === 'user' || entry.type === 'assistant') {
          messageCount++
        }
        // Collect user messages for context summary
        if (entry.type === 'user' && entry.message?.content) {
          const content = entry.message.content
          let text: string | undefined
          if (typeof content === 'string') {
            text = content
          } else if (Array.isArray(content)) {
            const textPart = content.find((p: any) => p.type === 'text')
            text = textPart?.text
          }
          if (text) {
            lastMessages.push(text.substring(0, 100))
          }
        }
      } catch {
        // Skip malformed lines
      }
    })

    rl.on('close', () => {
      resolve({
        sessionId,
        messageCount,
        lastMessages: lastMessages.slice(-5),  // Last 5 user messages
      })
    })

    rl.on('error', () => {
      resolve(null)
    })
  })
}

// ============================================================
// CONVERSATION HISTORY - For context sync on session switch
// ============================================================

/**
 * Represents a single exchange in the conversation
 */
export interface ConversationExchange {
  role: 'user' | 'assistant'
  content: string
  timestamp?: string
}

/**
 * Extract text content from a message (may be string or array of content blocks)
 * Handles both user and assistant messages with tool_use/tool_result blocks
 */
function extractTextContent(content: unknown): string | null {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    // Collect all text blocks, skip tool_use/tool_result/image blocks
    const texts: string[] = []
    for (const block of content) {
      if (block && typeof block === 'object' && 'type' in block) {
        if (block.type === 'text' && 'text' in block) {
          texts.push(String(block.text))
        }
      }
    }
    return texts.length > 0 ? texts.join('\n') : null
  }
  return null
}

/**
 * Get conversation history from a session file
 * Returns the last N exchanges (user/assistant pairs)
 */
export async function getConversationHistory(
  sessionId: string,
  projectPath: string,
  limit: number = 10
): Promise<ConversationExchange[]> {
  const sessionDir = getSessionDir(projectPath)
  const sessionFile = join(sessionDir, `${sessionId}.jsonl`)

  if (!existsSync(sessionFile)) {
    return []
  }

  try {
    const content = readFileSync(sessionFile, 'utf-8')
    const lines = content.trim().split('\n').filter(Boolean)
    const exchanges: ConversationExchange[] = []

    for (const line of lines) {
      try {
        const msg = JSON.parse(line)

        // Extract user messages
        if (msg.type === 'user' && msg.message?.content) {
          const text = extractTextContent(msg.message.content)
          if (text) {
            exchanges.push({
              role: 'user',
              content: text.substring(0, 2000)  // Allow longer content for richer context
            })
          }
        }

        // Extract assistant messages
        if (msg.type === 'assistant' && msg.message?.content) {
          const text = extractTextContent(msg.message.content)
          if (text) {
            exchanges.push({
              role: 'assistant',
              content: text.substring(0, 2000)  // Allow longer content for richer context
            })
          }
        }
      } catch {
        // Skip malformed lines
      }
    }

    // Return last N exchanges
    return exchanges.slice(-limit)
  } catch {
    return []
  }
}

// ============================================================
// SESSION METADATA - For persisting mode state with sessions
// ============================================================

/**
 * Session metadata for persisting mode state
 */
export interface SessionMetadata {
  sessionId: string
  lastUpdated: string
  projectPath: string
  messageCount?: number
  lastMessages?: string[]   // Last 5 user messages (truncated to 100 chars)
  summary?: string          // First user message as session topic
  researchDir?: string
  researchArtifacts?: string[]
  // Legacy fields — kept for backward compat with old session metadata
  agentMode?: AgentMode
  editMode?: EditMode
}

/**
 * All sessions metadata storage
 */
interface SessionMetadataStore {
  sessions: Record<string, SessionMetadata>
}

/**
 * Get the session metadata file path for a project
 */
function getSessionMetadataPath(projectPath: string): string {
  const sessionDir = getSessionDir(projectPath)
  return join(sessionDir, '.session-meta.json')
}

/**
 * Load all session metadata for a project
 */
function loadSessionMetadataStore(projectPath: string): SessionMetadataStore {
  const metaPath = getSessionMetadataPath(projectPath)

  if (!existsSync(metaPath)) {
    return { sessions: {} }
  }

  try {
    const content = readFileSync(metaPath, 'utf-8')
    return JSON.parse(content) as SessionMetadataStore
  } catch {
    console.warn(`⚠️ Failed to load session metadata, starting fresh`)
    return { sessions: {} }
  }
}

/**
 * Save session metadata store to disk
 */
function saveSessionMetadataStore(projectPath: string, store: SessionMetadataStore): void {
  const metaPath = getSessionMetadataPath(projectPath)
  const sessionDir = getSessionDir(projectPath)

  // Ensure directory exists
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true })
  }

  try {
    writeFileSync(metaPath, JSON.stringify(store, null, 2), 'utf-8')
  } catch (err) {
    console.error(`❌ Failed to save session metadata: ${(err as Error).message}`)
  }
}

/**
 * Save metadata for a specific session
 */
export function saveSessionMetadata(projectPath: string, metadata: SessionMetadata): void {
  const store = loadSessionMetadataStore(projectPath)
  store.sessions[metadata.sessionId] = metadata
  saveSessionMetadataStore(projectPath, store)
  console.log(`💾 Saved session metadata: ${metadata.sessionId}`)
}

/**
 * Get metadata for a specific session
 */
export function getSessionMetadataById(projectPath: string, sessionId: string): SessionMetadata | null {
  const store = loadSessionMetadataStore(projectPath)
  return store.sessions[sessionId] || null
}

/**
 * Get metadata for the most recent session
 */
export async function getMostRecentSessionMetadata(projectPath: string): Promise<SessionMetadata | null> {
  const recentSessionId = await getMostRecentSessionId(projectPath)
  if (!recentSessionId) {
    return null
  }
  return getSessionMetadataById(projectPath, recentSessionId)
}

/**
 * Delete metadata for a specific session
 */
export function deleteSessionMetadata(projectPath: string, sessionId: string): void {
  const store = loadSessionMetadataStore(projectPath)
  if (store.sessions[sessionId]) {
    delete store.sessions[sessionId]
    saveSessionMetadataStore(projectPath, store)
    console.log(`🗑️ Deleted session metadata: ${sessionId}`)
  }
}

/**
 * Clean up metadata for sessions that no longer exist
 */
export async function cleanupOrphanedMetadata(projectPath: string): Promise<number> {
  const store = loadSessionMetadataStore(projectPath)
  let cleanedCount = 0

  for (const sessionId of Object.keys(store.sessions)) {
    if (!sessionExists(sessionId, projectPath)) {
      delete store.sessions[sessionId]
      cleanedCount++
    }
  }

  if (cleanedCount > 0) {
    saveSessionMetadataStore(projectPath, store)
    console.log(`🧹 Cleaned up ${cleanedCount} orphaned session metadata entries`)
  }

  return cleanedCount
}

// ============================================================
// SESSION WORKSPACE — Co-located with Claude's native JSONL
// ~/.claude/projects/{slug}/osb/{sessionId}/
// ============================================================

/**
 * Get the session workspace path.
 * @param workingDir - The project working directory (used to compute project slug)
 * @param sessionId - The session UUID
 */
export function getSessionWorkspace(workingDir: string, sessionId: string): string {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  const slug = projectPathToClaudeFolderName(workingDir)
  return join(claudeDir, 'projects', slug, 'osb', sessionId)
}

export function ensureSessionWorkspace(workingDir: string, sessionId: string): string {
  const dir = getSessionWorkspace(workingDir, sessionId)
  mkdirSync(dir, { recursive: true })
  // Create default spec.md if it doesn't exist (won't overwrite on resumed sessions)
  const specPath = join(dir, 'spec.md')
  if (!existsSync(specPath)) {
    writeFileSync(specPath, `# Session Spec

## Goal
<!-- What the user wants to achieve — the driving purpose of this session -->

## User Context
<!-- Where the user is at, what they have, their preferences, constraints, resources -->
<!-- e.g., budget, tools available, skill level, timeline -->

## Open Questions

### From User (unanswered)
<!-- Questions the user has asked that research hasn't answered yet -->
<!-- Format: - [ ] Question (asked at timestamp) -->
<!-- When answered: - [x] Question → Answer (source) -->

### From Agent (needs user input)
<!-- Clarifying questions the agent needs answered to proceed -->
<!-- Format: - [ ] Question (why it matters) [priority: high/medium/low] -->
<!-- When answered: - [x] Question → User's answer -->

## Decisions
<!-- Locked-in answers — moved from Open Questions when resolved -->
<!-- Format: - Decision (rationale / source) -->

## Findings & Resources
<!-- Key facts, patterns, links, code examples discovered during research -->
<!-- Concrete details: names, versions, URLs, configurations -->
<!-- Resources: websites to visit, tools to use, documentation links -->

## Plan
<!-- Step-by-step execution guide — the portable output -->
<!-- Actionable steps someone can follow to go from problem to solution -->
<!-- Include: what to do, what tools/resources needed, in what order -->
`, 'utf-8')
  }
  return dir
}

/**
 * Rename a session workspace folder to match the SDK session ID.
 * Returns the new path, or null if rename was not needed/possible.
 */
export function renameSessionWorkspace(workingDir: string, oldSessionId: string, newSessionId: string): string | null {
  if (oldSessionId === newSessionId) return null
  const oldDir = getSessionWorkspace(workingDir, oldSessionId)
  const newDir = getSessionWorkspace(workingDir, newSessionId)
  if (!existsSync(oldDir)) return null
  if (existsSync(newDir)) return null // target already exists
  try {
    renameSync(oldDir, newDir)
    return newDir
  } catch (err) {
    console.error(`Failed to rename workspace ${oldSessionId} → ${newSessionId}:`, err)
    return null
  }
}

// Deprecated aliases for backward compatibility
export function getResearchDir(workingDir: string, sessionId: string): string {
  return getSessionWorkspace(workingDir, sessionId)
}

export function ensureResearchDir(workingDir: string, sessionId: string): string {
  return ensureSessionWorkspace(workingDir, sessionId)
}

/**
 * Read the session spec document (spec.md) if it exists
 */
export function readSessionSpec(workingDir: string, sessionId: string): string | null {
  const specPath = join(getSessionWorkspace(workingDir, sessionId), 'spec.md')
  if (!existsSync(specPath)) return null
  try {
    return readFileSync(specPath, 'utf-8')
  } catch {
    return null
  }
}

/**
 * List files in the session library directory (deprecated — library removed)
 */
export function listLibraryFiles(_workingDir: string, _sessionId: string): string[] {
  return []
}

export interface ResearchArtifact {
  fileName: string
  filePath: string
  type: 'plan' | 'diagram' | 'notes' | 'image' | 'summary' | 'html' | 'other'
  size: number
  updatedAt: string
}

function classifyFile(fileName: string): ResearchArtifact['type'] {
  const ext = fileName.split('.').pop()?.toLowerCase() || ''
  if (fileName.includes('plan')) return 'plan'
  if (ext === 'mmd' || ext === 'mermaid') return 'diagram'
  if (ext === 'html' || ext === 'htm') return 'html'
  if (ext === 'md') return 'notes'
  if (['png', 'jpg', 'jpeg', 'svg', 'gif', 'webp'].includes(ext)) return 'image'
  if (fileName.includes('summary')) return 'summary'
  return 'other'
}

function scanDirForArtifacts(dir: string): ResearchArtifact[] {
  const results: ResearchArtifact[] = []
  function scan(scanPath: string) {
    try {
      for (const entry of readdirSync(scanPath)) {
        const fullPath = join(scanPath, entry)
        const stat = statSync(fullPath)
        if (stat.isDirectory()) {
          scan(fullPath)
        } else {
          // Skip internal index files
          if (entry.startsWith('search-index')) continue
          results.push({
            fileName: entry,
            filePath: fullPath,
            type: classifyFile(entry),
            size: stat.size,
            updatedAt: stat.mtime.toISOString(),
          })
        }
      }
    } catch { /* ignore */ }
  }
  scan(dir)
  return results
}

export function listResearchArtifacts(workingDir: string, sessionId: string): ResearchArtifact[] {
  return scanDirForArtifacts(getSessionWorkspace(workingDir, sessionId))
}

/**
 * List artifacts in a session workspace (osb/{sessionId}/ under Claude's project dir).
 */
export function listWorkspaceArtifacts(workingDir: string, sessionId?: string): ResearchArtifact[] {
  if (!sessionId) return []
  const dir = getSessionWorkspace(workingDir, sessionId)
  return scanDirForArtifacts(dir)
}
