import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { parse, stringify } from 'yaml'
import type { McpServerConfig } from './claude-handler.js'

// Config file paths
const CONFIG_DIR = join(homedir(), '.osborn')
const CONFIG_FILE = join(CONFIG_DIR, 'config.yaml')

export interface OsbornConfig {
  // Working directory for the coding agent
  workingDirectory?: string

  // MCP servers configuration
  mcpServers?: Record<string, McpServerConfigYaml>

  // Default voice provider
  defaultProvider?: 'openai' | 'gemini'

  // Default coding agent
  defaultCodingAgent?: 'claude' | 'codex'
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
