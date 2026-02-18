/**
 * Smithery MCP Proxy — Bridges Smithery cloud MCP servers to Claude Agent SDK.
 *
 * The Claude Agent SDK's `type: 'http'` transport has a known bug (#18296, #7290)
 * where it forces OAuth discovery on all HTTP MCP servers, ignoring configured
 * auth headers. This proxy bypasses that by:
 *
 * 1. Using @smithery/api/mcp createConnection() to get a working transport
 * 2. Connecting an MCP Client to the remote server via that transport
 * 3. Listing available tools from the remote server
 * 4. Creating a local McpServer with proxied tool handlers
 * 5. Returning it as { type: 'sdk', name, instance } for the Claude Agent SDK
 *
 * This means the Claude SDK talks to our local McpServer (in-process, no HTTP),
 * and our McpServer forwards tool calls to Smithery via the working transport.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createConnection, SmitheryAuthorizationError } from '@smithery/api/mcp'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

// Track active proxy connections for cleanup
const activeProxies: Map<string, { client: Client; server: McpServer }> = new Map()

export interface SmitheryProxyConfig {
  /** Display name for the MCP server (e.g., 'youtube') */
  name: string
  /** Smithery Connect namespace (e.g., 'deer-y2fs') */
  namespace: string
  /** Smithery Connect connection ID (e.g., 'youtube-mcp-sfiorini-TRmB') */
  connectionId: string
  /** Upstream MCP server URL (e.g., 'https://youtube-mcp--sfiorini.run.tools') */
  mcpUrl?: string
}

/**
 * Parse a Smithery Connect URL into namespace and connectionId.
 * URL format: https://api.smithery.ai/connect/{namespace}/{connectionId}/mcp
 */
export function parseSmitheryUrl(url: string): { namespace: string; connectionId: string } | null {
  const match = url.match(/api\.smithery\.ai\/connect\/([^/]+)\/([^/]+)\/mcp/)
  if (!match) return null
  return { namespace: match[1], connectionId: match[2] }
}

/**
 * Convert a JSON Schema property definition to a Zod type.
 * Used to register proxy tools with proper parameter schemas so Claude
 * knows what arguments each tool accepts.
 */
function jsonSchemaPropertyToZod(prop: any, required: boolean): z.ZodTypeAny {
  if (!prop) return required ? z.any() : z.any().optional()

  let zodType: z.ZodTypeAny

  switch (prop.type) {
    case 'string':
      zodType = prop.enum ? z.enum(prop.enum) : z.string()
      break
    case 'number':
    case 'integer':
      zodType = z.number()
      break
    case 'boolean':
      zodType = z.boolean()
      break
    case 'array':
      zodType = z.array(z.any())
      break
    case 'object':
      zodType = z.record(z.string(), z.any())
      break
    default:
      zodType = z.any()
  }

  if (prop.description) {
    zodType = zodType.describe(prop.description)
  }

  if (!required) {
    zodType = zodType.optional()
  }

  return zodType
}

/**
 * Convert a JSON Schema object to a Zod raw shape for McpServer.tool() registration.
 */
function jsonSchemaToZodShape(inputSchema: any): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {}
  if (!inputSchema?.properties) return shape

  const requiredFields: string[] = inputSchema.required || []

  for (const [propName, propDef] of Object.entries(inputSchema.properties)) {
    const isRequired = requiredFields.includes(propName)
    shape[propName] = jsonSchemaPropertyToZod(propDef as any, isRequired)
  }

  return shape
}

/**
 * Create a proxy MCP server for a Smithery-hosted server.
 *
 * Returns a config object compatible with Claude Agent SDK's McpSdkServerConfigWithInstance.
 * The proxy connects to Smithery via createConnection(), discovers tools, and registers
 * them on a local McpServer that forwards calls to the remote server.
 */
export async function createSmitheryProxy(
  config: SmitheryProxyConfig
): Promise<{ type: 'sdk'; name: string; instance: McpServer }> {
  const { name, namespace, connectionId, mcpUrl } = config

  console.log(`🔌 Smithery proxy: connecting to ${name} (${namespace}/${connectionId})...`)

  // Clean up any existing proxy for this name
  await destroySmitheryProxy(name)

  // 1. Get authenticated transport from Smithery SDK
  const connection = await createConnection({
    namespace,
    connectionId,
    mcpUrl,
  })

  console.log(`🔌 Smithery proxy: transport ready for ${name} (url: ${connection.url})`)

  // 2. Connect MCP Client to the remote server
  const remoteClient = new Client(
    { name: `${name}-proxy-client`, version: '1.0.0' },
    { capabilities: {} }
  )
  await remoteClient.connect(connection.transport)
  console.log(`🔌 Smithery proxy: client connected to ${name}`)

  // 3. List tools from remote server
  const toolsList = await remoteClient.listTools()
  console.log(`🔌 Smithery proxy: ${name} has ${toolsList.tools.length} tools: ${toolsList.tools.map(t => t.name).join(', ')}`)

  // 4. Create local McpServer and register proxied tools
  const proxyServer = new McpServer(
    { name: `${name}-proxy`, version: '1.0.0' },
    { capabilities: { tools: {} } }
  )

  for (const remoteTool of toolsList.tools) {
    const zodShape = jsonSchemaToZodShape(remoteTool.inputSchema)
    const hasParams = Object.keys(zodShape).length > 0

    if (hasParams) {
      proxyServer.tool(
        remoteTool.name,
        remoteTool.description || '',
        zodShape,
        async (args) => {
          console.log(`🔌 Smithery proxy [${name}]: calling ${remoteTool.name}`)
          const result = await remoteClient.callTool({
            name: remoteTool.name,
            arguments: args,
          })
          return result as CallToolResult
        }
      )
    } else {
      proxyServer.tool(
        remoteTool.name,
        remoteTool.description || '',
        async () => {
          console.log(`🔌 Smithery proxy [${name}]: calling ${remoteTool.name}`)
          const result = await remoteClient.callTool({
            name: remoteTool.name,
            arguments: {},
          })
          return result as CallToolResult
        }
      )
    }
  }

  // Patch McpServer and its internal Server to allow reconnection across SDK query() calls.
  // The Claude SDK connects to the McpServer on each query() but never disconnects,
  // so the second query throws "Already connected to a transport". This patch
  // auto-closes the previous transport before accepting a new one.
  // We patch at both levels because McpServer.connect may throw before reaching Server.connect.
  const proxyServerAny = proxyServer as any
  if (proxyServerAny.connect) {
    const originalMcpConnect = proxyServerAny.connect.bind(proxyServerAny)
    proxyServerAny.connect = async function (transport: any) {
      if (this._transport) {
        try { await this._transport.close() } catch {}
        this._transport = undefined
      }
      const inner = this._server
      if (inner?._transport) {
        try { await inner._transport.close() } catch {}
        inner._transport = undefined
      }
      return originalMcpConnect(transport)
    }
  }

  // Track for cleanup
  activeProxies.set(name, { client: remoteClient, server: proxyServer })

  console.log(`✅ Smithery proxy: ${name} ready with ${toolsList.tools.length} tools`)

  return {
    type: 'sdk',
    name,
    instance: proxyServer,
  }
}

/**
 * Destroy an active proxy connection and clean up resources.
 */
export async function destroySmitheryProxy(name: string): Promise<void> {
  const proxy = activeProxies.get(name)
  if (proxy) {
    try {
      await proxy.client.close()
      await proxy.server.close()
    } catch (e) {
      // Ignore cleanup errors
    }
    activeProxies.delete(name)
    console.log(`🔌 Smithery proxy: ${name} destroyed`)
  }
}

/**
 * Check if a URL is a Smithery Connect URL.
 */
export function isSmitheryUrl(url: string): boolean {
  return url.includes('api.smithery.ai/connect/')
}

export { SmitheryAuthorizationError }
