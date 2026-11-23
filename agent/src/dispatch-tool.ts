/**
 * The hub's `dispatch` tool as an in-process SDK MCP server (names and text in dispatch.ts). The hub's
 * ClaudeLLM gets it through its `hubTools` option, a factory called for each query: an McpServer
 * instance takes one transport at a time, so a rebuilt, parked or second hub needs its own.
 * A background slot passes no `hubTools`, so it never has the tool.
 */
import { createSdkMcpServer, tool, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { DISPATCH_SERVER } from './dispatch.js'

export const TOOL_NAME = 'send'

/** A factory for the hub's servers; `send` runs the dispatch and returns the text the model sees. */
export function dispatchServers(send: (project: string, instruction: string) => Promise<string>): () => Record<string, McpServerConfig> {
  return () => ({
    [DISPATCH_SERVER]: createSdkMcpServer({
      name: DISPATCH_SERVER,
      tools: [tool(TOOL_NAME, "Send a task to another project's own session; the result comes back to you as a notification.",
        { project: z.string().describe("the project's folder name"), instruction: z.string().describe('the task, self-contained: that session has none of this conversation') },
        async ({ project, instruction }) => ({ content: [{ type: 'text' as const, text: await send(project, instruction) }] }))],
    }),
  })
}

/** The mcpServers a query gets from its `hubTools` option: only the hub has one. */
export const hubMcpServers = (hubTools?: () => Record<string, McpServerConfig>): Record<string, McpServerConfig> | undefined => hubTools?.()
