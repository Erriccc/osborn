import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { parse, stringify } from 'yaml'
import type { McpServerConfig } from './claude-handler.js'

// Config file paths
const CONFIG_DIR = join(homedir(), '.osborn')
const CONFIG_FILE = join(CONFIG_DIR, 'config.yaml')

// Voice mode options
export type VoiceMode = 'realtime' | 'pipelined'

// STT provider options
export type STTProvider = 'deepgram' | 'groq-whisper' | 'openai-whisper'

// TTS provider options
export type TTSProvider = 'gemini' | 'openai' | 'elevenlabs'

// Bridge LLM provider options
export type BridgeLLMProvider = 'gemini-pro' | 'gpt-4o'

// Pipelined mode configuration
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
  defaultProvider?: 'openai' | 'gemini'

  // Default coding agent
  defaultCodingAgent?: 'claude' | 'codex'

  // Voice mode: 'realtime' (speech-to-speech) or 'pipelined' (STT+LLM+TTS)
  voiceMode?: VoiceMode

  // Pipelined mode configuration (only used when voiceMode='pipelined')
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

// Default config template
const DEFAULT_CONFIG: OsbornConfig = {
  workingDirectory: process.cwd(),
  defaultProvider: 'openai',
  defaultCodingAgent: 'claude',
  // Voice mode: 'realtime' (OpenAI/Gemini speech-to-speech) or 'pipelined' (STT+LLM+TTS)
  voiceMode: 'realtime',
  // Pipelined mode config (used when voiceMode='pipelined')
  pipelined: {
    stt: {
      provider: 'deepgram',
      // model: 'nova-2',
      // language: 'en',
    },
    llm: {
      provider: 'gemini-pro',
      // model: 'gemini-2.5-pro',
    },
    tts: {
      provider: 'gemini',
      voice: 'Zephyr',
      // model: 'gemini-2.5-flash-preview-tts',
    },
  },
  mcpServers: {
    // Example MCP servers (disabled by default)
    // github: {
    //   enabled: true,
    //   command: 'npx',
    //   args: ['@modelcontextprotocol/server-github'],
    //   env: {
    //     GITHUB_TOKEN: '${GITHUB_TOKEN}',
    //   },
    // },
    // filesystem: {
    //   enabled: true,
    //   command: 'npx',
    //   args: ['@modelcontextprotocol/server-filesystem', '/allowed/path'],
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
    }
    // Note: SSE/HTTP transport may require different handling
  }

  return servers
}

/**
 * Get list of enabled MCP server names (for display)
 */
export function getEnabledMcpServerNames(config: OsbornConfig): string[] {
  if (!config.mcpServers) return []

  return Object.entries(config.mcpServers)
    .filter(([_, serverConfig]) => serverConfig.enabled !== false && serverConfig.command)
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
  return config.voiceMode || 'realtime'
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
