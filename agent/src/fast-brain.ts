/**
 * Fast Brain — Central Orchestrator for the Voice AI System
 *
 * The sole intelligence layer between the user and all backend capabilities.
 * The realtime voice model is a thin teleprompter — it speaks what this module returns.
 *
 * Capabilities:
 * - Read/write session files (spec.md + library/)
 * - Web search for quick factual lookups
 * - Record user decisions and preferences into spec.md
 * - Trigger deep research (via callbacks to index.ts)
 * - Generate teleprompter scripts for ALL voice output
 * - Post-research: synthesize findings from JSONL into spec.md + voice scripts
 * - Generate visual documents (comparison, diagram, analysis, summary)
 *
 * Central function: askFastBrain() — ALL user questions route here.
 * It returns a FastBrainResponse with a teleprompter script the voice model reads verbatim.
 *
 * Auth chain (tried in order):
 * 1. ANTHROPIC_API_KEY env var → Anthropic SDK (Haiku)
 * 2. ANTHROPIC_AUTH_TOKEN env var → Anthropic SDK (Haiku)
 * 3. GOOGLE_API_KEY env var → Gemini Flash fallback
 */

import Anthropic from '@anthropic-ai/sdk'
import { query as sdkQuery, tool as sdkTool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { GoogleGenAI } from '@google/genai'
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs'
import { dirname, basename, join } from 'path'
import { homedir } from 'os'
import { z } from 'zod'
import { getSessionWorkspace, readSessionSpec, listLibraryFiles } from './config.js'
import { FAST_BRAIN_SYSTEM_PROMPT, CHUNK_PROCESS_SYSTEM, REFINEMENT_PROCESS_SYSTEM, AUGMENT_RESULT_SYSTEM, CONTEXTUALIZE_UPDATE_SYSTEM, PROACTIVE_PROMPT_SYSTEM, VISUAL_DOCUMENT_SYSTEM, RESEARCH_COMPLETION_SYSTEM, buildFastBrainSdkPrompt } from './prompts.js'
import { getRecentToolResults, readSessionHistory, getSubagentTranscripts, getConversationText, getSessionTranscripts, searchSessionJsonl, getSessionStats } from './session-access.js'

// ============================================================
// Content extraction — pulls useful snippets from tool responses
// ============================================================

/**
 * Extract useful content snippets from tool responses, truncated by tool type.
 * Returns null for tools with no useful content (Write confirmations, etc.)
 */
export function extractToolContent(toolName: string, toolInput: any, toolResponse: any): string | null {
  if (!toolResponse) return null
  const response = typeof toolResponse === 'string' ? toolResponse : JSON.stringify(toolResponse)
  if (response.length < 20) return null // Skip trivial responses

  switch (toolName) {
    case 'Read':
      return `[File: ${basename(toolInput?.file_path || 'unknown')}]\n${response.slice(0, 600)}`
    case 'Bash':
      return `[Command: ${(toolInput?.command || '').slice(0, 80)}]\n${response.slice(0, 400)}`
    case 'Grep':
      return `[Search: "${toolInput?.pattern}"]\n${response.slice(0, 600)}`
    case 'WebSearch':
      return `[Web: "${toolInput?.query}"]\n${response.slice(0, 800)}`
    case 'WebFetch':
      return `[Page: ${toolInput?.url}]\n${response.slice(0, 800)}`
    case 'Glob':
      return `[Files matching: ${toolInput?.pattern}]\n${response.slice(0, 400)}`
    case 'Write': case 'Edit':
      return null // Skip write confirmations
    default:
      if (toolName.startsWith('mcp__'))
        return `[${toolName}]\n${response.slice(0, 500)}`
      return null
  }
}

// ============================================================
// Provider detection and client initialization
// ============================================================

type FastBrainProvider = 'agent-sdk' | 'anthropic' | 'gemini' | 'none'

let provider: FastBrainProvider = 'none'
let anthropicClient: Anthropic | null = null
let geminiClient: GoogleGenAI | null = null
let initialized = false

// Model IDs — configurable per provider
const ANTHROPIC_FAST_MODEL = 'claude-haiku-4-5-20251001'
const GEMINI_FAST_MODEL = 'gemini-2.0-flash'

// ============================================================
// Conversation history — sourced from agent.chatCtx (LiveKit in-memory context)
// ============================================================

/** A single voice conversation turn from the realtime LLM's chatCtx */
export interface ConversationTurn {
  role: 'user' | 'assistant'
  text: string
}

// Agent SDK session tracking — resume across voice questions for context continuity
let fastBrainSessionId: string | null = null

/** Clear fast brain session state — call on disconnect/reconnect/session switch */
export function clearFastBrainSession(): void {
  fastBrainSessionId = null
  console.log('🧠 Fast brain: session cleared')
}

/** @deprecated Use clearFastBrainSession() instead */
export function clearFastBrainHistory(): void {
  clearFastBrainSession()
}

function initProvider(): void {
  if (initialized) return
  initialized = true

  // Initialize fallback clients (Gemini for fallback, Anthropic direct API if key available)
  const googleKey = process.env.GOOGLE_API_KEY
  if (googleKey) {
    geminiClient = new GoogleGenAI({ apiKey: googleKey })
  }
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (apiKey) {
    anthropicClient = new Anthropic({ apiKey })
  } else {
    const authToken = process.env.ANTHROPIC_AUTH_TOKEN
    if (authToken) {
      anthropicClient = new Anthropic({ authToken })
    }
  }

  // PRIMARY: Gemini Flash — fastest (~1-2s), handles 1M tokens, no cold start.
  // Agent SDK Haiku is too slow (~10-15s) due to CLI process spawn + session overhead.
  if (geminiClient) {
    provider = 'gemini'
    console.log(`🧠 Fast brain: using Gemini Flash (primary) — fastest response time`)
    if (anthropicClient) {
      console.log(`🧠 Fast brain: Direct Anthropic API available as fallback`)
    }
  } else if (anthropicClient) {
    provider = 'anthropic'
    console.log(`🧠 Fast brain: using Anthropic API (primary) — no Gemini key available`)
  } else {
    // Last resort: Agent SDK is slow but functional
    provider = 'agent-sdk'
    console.log(`🧠 Fast brain: using Claude Agent SDK (fallback) — no API keys available`)
  }
}

// ============================================================
// Tool execution (shared across providers)
// ============================================================

// Track whether send_to_chat was called during a fast brain conversation.
// If the LLM calls send_to_chat but returns no text, we use a fallback
// instead of "No answer found."
let sendToChatCalledThisTurn = false

function executeTool(
  toolName: string,
  toolInput: Record<string, any>,
  workspace: string,
  sessionId?: string,
  workingDir?: string,
  sendToChat?: (text: string) => void
): string {
  try {
    switch (toolName) {
      case 'read_file': {
        const relPath = toolInput.path as string
        if (relPath.includes('..')) return 'Error: path traversal not allowed'
        const fullPath = `${workspace}/${relPath}`
        if (!existsSync(fullPath)) return `File not found: ${relPath}`
        const content = readFileSync(fullPath, 'utf-8')
        return content || '(empty file)'
      }

      case 'write_file': {
        const relPath = toolInput.path as string
        const content = toolInput.content as string
        if (relPath.includes('..')) return 'Error: path traversal not allowed'
        const fullPath = `${workspace}/${relPath}`
        mkdirSync(dirname(fullPath), { recursive: true })
        writeFileSync(fullPath, content, 'utf-8')
        console.log(`📝 Fast brain wrote ${relPath} (${content.length} chars)`)
        return `Written: ${relPath} (${content.length} chars)`
      }

      case 'list_library': {
        const libraryDir = `${workspace}/library`
        if (!existsSync(libraryDir)) return 'Library is empty — no research files yet.'
        try {
          const items = readdirSync(libraryDir)
          return items.length > 0 ? items.join('\n') : 'Library is empty — no research files yet.'
        } catch {
          return 'Library is empty — no research files yet.'
        }
      }

      case 'read_agent_results': {
        if (!sessionId || !workingDir) return 'Error: no active research session'
        const lastN = (toolInput.lastN as number) || 40
        const toolFilter = toolInput.toolFilter as string[] | undefined
        const results = getRecentToolResults(sessionId, workingDir, lastN, { toolNameFilter: toolFilter })
        if (results.length === 0) return `No tool results found${toolFilter ? ` for tools: ${toolFilter.join(', ')}` : ''}.`
        return `[${results.length} results${toolFilter ? ` filtered by: ${toolFilter.join(', ')}` : ''}]\n\n` +
          results.map(tr => {
            const inputPreview = JSON.stringify(tr.toolInput).substring(0, 200)
            return `[${tr.toolName}: ${inputPreview}]\n${tr.resultContent}`
          }).join('\n\n---\n\n')
      }

      case 'read_agent_text': {
        if (!sessionId || !workingDir) return 'Error: no active research session'
        const lastN = (toolInput.lastN as number) || 60
        const opts = lastN === 0
          ? { types: ['assistant' as const] }
          : { lastN, types: ['assistant' as const] }
        const messages = readSessionHistory(sessionId, workingDir, opts)
        const texts = messages.filter(m => m.text && m.text.length > 20)
        if (texts.length === 0) return 'No agent reasoning text found in JSONL.'
        return `[${texts.length} agent messages]\n\n` + texts.map(m => m.text).join('\n\n---\n\n')
      }

      case 'read_subagents': {
        if (!sessionId || !workingDir) return 'Error: no active research session'
        const transcripts = getSubagentTranscripts(sessionId, workingDir)
        if (transcripts.length === 0) return 'No sub-agent transcripts found.'
        return transcripts.map(sa => {
          const texts = sa.messages
            .filter(m => m.text && m.text.length > 20)
            .map(m => `[${m.type}] ${m.text}`)
          return `=== Sub-agent ${sa.taskId} (${sa.messages.length} msgs) ===\n${texts.join('\n')}`
        }).join('\n\n')
      }

      case 'search_jsonl': {
        if (!sessionId || !workingDir) return 'Error: no active research session'
        const keyword = toolInput.keyword as string
        if (!keyword) return 'Error: keyword is required'
        const maxResults = (toolInput.maxResults as number) || 20
        const results = searchSessionJsonl(sessionId, workingDir, keyword, { maxResults })
        if (results.length === 0) return `No matches for "${keyword}" in agent JSONL.`
        return results.map(r => `[${r.type}${r.timestamp ? ` @ ${r.timestamp}` : ''}] ${r.text}`).join('\n\n---\n\n')
      }

      case 'read_conversation': {
        if (!sessionId || !workingDir) return 'Error: no active research session'
        const lastN = (toolInput.lastN as number) || 30
        const exchanges = getConversationText(sessionId, workingDir, lastN, 2000)
        if (exchanges.length === 0) return 'No conversation history found.'
        return exchanges.map(e => `${e.role}: ${e.text}`).join('\n\n')
      }

      case 'get_session_stats': {
        if (!sessionId || !workingDir) return 'Error: no active research session'
        const stats = getSessionStats(sessionId, workingDir)
        if (!stats) return 'No session data found.'
        const toolList = Object.entries(stats.toolBreakdown)
          .sort(([, a], [, b]) => b - a)
          .map(([name, count]) => `  ${name}: ${count}`)
          .join('\n')
        return `Session Stats:
Total messages: ${stats.totalMessages}
User messages: ${stats.userMessages}
Agent messages: ${stats.assistantMessages}
Tool calls: ${stats.toolUseCount}
Tool results: ${stats.toolResultCount}
Sub-agents: ${stats.subagentCount}
File size: ${(stats.fileSizeBytes / 1024).toFixed(1)} KB
Time range: ${stats.firstTimestamp || '?'} → ${stats.lastTimestamp || '?'}

Tool breakdown:
${toolList}`
      }

      case 'deep_read_results': {
        if (!sessionId || !workingDir) return 'Error: no active research session'
        const toolFilter = toolInput.toolFilter as string[] | undefined
        const allResults = getRecentToolResults(sessionId, workingDir, 0, { toolNameFilter: toolFilter })
        if (allResults.length === 0) return `No tool results found${toolFilter ? ` for tools: ${toolFilter.join(', ')}` : ''}.`
        return `[${allResults.length} total results${toolFilter ? ` filtered by: ${toolFilter.join(', ')}` : ' (all tools)'}]\n\n` +
          allResults.map(tr => {
            const inputPreview = JSON.stringify(tr.toolInput).substring(0, 200)
            return `[${tr.toolName}: ${inputPreview}]\n${tr.resultContent}`
          }).join('\n\n---\n\n')
      }

      case 'deep_read_text': {
        if (!sessionId || !workingDir) return 'Error: no active research session'
        const allMessages = readSessionHistory(sessionId, workingDir, {
          types: ['assistant']
        })
        const allTexts = allMessages.filter(m => m.text && m.text.length > 20)
        if (allTexts.length === 0) return 'No agent reasoning text found in JSONL.'
        return `[${allTexts.length} total agent messages across entire session]\n\n` + allTexts.map(m => m.text).join('\n\n---\n\n')
      }

      case 'get_full_transcript': {
        if (!sessionId || !workingDir) return 'Error: no active research session'
        const transcripts = getSessionTranscripts(sessionId, workingDir)
        const agentTexts = transcripts.agent.messages
          .filter(m => m.text && m.text.length > 20)
          .map(m => `[${m.type}${m.toolName ? ': ' + m.toolName : ''}] ${m.text}`)
        let output = `=== Agent Transcript (${transcripts.agent.messages.length} msgs, ${transcripts.agent.fileSize} bytes) ===\n${agentTexts.join('\n\n')}`
        if (transcripts.subagents.length > 0) {
          const subTexts = transcripts.subagents.map(sa => {
            const texts = sa.messages.filter(m => m.text).map(m => `[${m.type}] ${m.text}`)
            return `=== Sub-agent ${sa.taskId} ===\n${texts.join('\n')}`
          })
          output += '\n\n' + subTexts.join('\n\n')
        }
        return output
      }

      case 'send_to_chat': {
        const text = toolInput.text as string
        if (!text) return 'Error: text is required'
        if (sendToChat) {
          console.log(`💬 [fast brain] send_to_chat: ${text.substring(0, 80)}...`)
          sendToChat(text)
          sendToChatCalledThisTurn = true
          return `Sent to chat successfully. Now return a brief spoken summary — do NOT repeat the content you just sent.`
        }
        return 'Error: chat sending not available'
      }

      default:
        return `Unknown tool: ${toolName}`
    }
  } catch (err) {
    return `Tool error: ${(err as Error).message}`
  }
}

// ============================================================
// Anthropic tool definitions
// ============================================================

function buildAnthropicTools(): Anthropic.Messages.Tool[] {
  return [
    {
      name: 'read_file',
      description: 'Read a file from the session workspace. Use relative paths like "spec.md" or "library/react-guide.md".',
      input_schema: {
        type: 'object' as const,
        properties: {
          path: { type: 'string', description: 'Relative path within session workspace' }
        },
        required: ['path']
      }
    },
    {
      name: 'write_file',
      description: 'Write or update a file in the session workspace. For spec.md, always read first then write the complete updated content.',
      input_schema: {
        type: 'object' as const,
        properties: {
          path: { type: 'string', description: 'Relative path within session workspace' },
          content: { type: 'string', description: 'The complete file content to write' }
        },
        required: ['path', 'content']
      }
    },
    {
      name: 'list_library',
      description: 'List all files in the research library directory.',
      input_schema: { type: 'object' as const, properties: {} }
    },
    {
      name: 'read_agent_results',
      description: 'Read the research agent\'s FULL memory — complete untruncated tool outputs including entire file contents the agent read, full bash command outputs, web search results, and web page fetches. This is the agent\'s raw data. Use this FIRST when asked about anything the agent just researched. Default: last 40 results.',
      input_schema: {
        type: 'object' as const,
        properties: {
          lastN: { type: 'number', description: 'Number of recent results to return (default: 40, max: 80)' }
        }
      }
    },
    {
      name: 'read_agent_text',
      description: 'Read the research agent\'s reasoning, analysis, and conclusions from JSONL. Contains the agent\'s step-by-step thinking, synthesis of findings, comparisons, and recommendations. Use this alongside read_agent_results to get the COMPLETE picture of what the agent researched and concluded. Default: last 60 messages.',
      input_schema: {
        type: 'object' as const,
        properties: {
          lastN: { type: 'number', description: 'Number of recent text messages to return (default: 60, max: 100)' }
        }
      }
    },
    {
      name: 'read_subagents',
      description: 'Read all sub-agent (parallel Task) transcripts. Contains the detailed work done by sub-agents spawned during research. Use when the main agent delegated parts of the research to sub-agents working in parallel.',
      input_schema: { type: 'object' as const, properties: {} }
    },
    {
      name: 'search_jsonl',
      description: 'Search the agent\'s JSONL transcript for a keyword. Returns matching entries across all tool results, agent reasoning, and conversation history. Use to find specific mentions of a topic, file, function, or concept.',
      input_schema: {
        type: 'object' as const,
        properties: {
          keyword: { type: 'string', description: 'The keyword to search for (case-insensitive)' },
          maxResults: { type: 'number', description: 'Maximum number of results (default: 20)' }
        },
        required: ['keyword']
      }
    },
    {
      name: 'read_conversation',
      description: 'Read the user/assistant conversation exchange history. Shows what the user asked and what the agent responded, without tool call details. Use for understanding conversation flow, user intent, and what was discussed.',
      input_schema: {
        type: 'object' as const,
        properties: {
          lastN: { type: 'number', description: 'Number of recent exchanges to return (default: 30)' }
        }
      }
    },
    {
      name: 'get_full_transcript',
      description: 'Read the COMPLETE agent transcript + all sub-agent transcripts. This is the most comprehensive view of everything the agent did — use when targeted tools (read_agent_results, read_agent_text) aren\'t enough and you need the full picture. Large output.',
      input_schema: { type: 'object' as const, properties: {} }
    },
    {
      name: 'get_session_stats',
      description: 'Get session statistics: total messages, tool call counts by name, sub-agent count, data size, time range. Use this to understand how much data is in the session before deciding whether to use deep tools.',
      input_schema: { type: 'object' as const, properties: {} }
    },
    {
      name: 'deep_read_results',
      description: 'Read ALL tool results across the ENTIRE session — not just recent ones. Returns every file read, bash output, web search, web fetch, etc. Use toolFilter to narrow by tool type. Use this for generating detailed analyses, overviews, diagrams, answering specific questions requiring full context, or when the user wants comprehensive details.',
      input_schema: {
        type: 'object' as const,
        properties: {
          toolFilter: {
            type: 'array',
            items: { type: 'string' },
            description: 'Only return results from these tools. E.g., ["Read"] for file reads, ["WebSearch","WebFetch"] for web data, ["Bash"] for commands, ["Grep","Glob"] for code searches. Omit for all tools.'
          }
        }
      }
    },
    {
      name: 'deep_read_text',
      description: 'Read ALL agent reasoning and analysis across the ENTIRE session — not just recent messages. Returns every piece of thinking, synthesis, comparison, and recommendation the agent produced. Use this for generating comprehensive overviews or when the user asks for detailed explanations of what the agent found.',
      input_schema: { type: 'object' as const, properties: {} }
    },
    {
      name: 'send_to_chat',
      description: 'Send formatted content to the user\'s chat panel. Use for URLs, links, lists, prices, code snippets, or anything that\'s better read than spoken. The content appears as a chat message in the frontend. You should STILL speak a brief summary — use this tool for the detailed/visual content.',
      input_schema: {
        type: 'object' as const,
        properties: {
          text: { type: 'string', description: 'The formatted text to display in chat. Supports markdown.' }
        },
        required: ['text']
      }
    }
  ]
}

const ANTHROPIC_WEB_SEARCH: Anthropic.Messages.WebSearchTool20250305 = {
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: 3,
}

// ============================================================
// Gemini tool definitions
// ============================================================

function buildGeminiTools(): any[] {
  // NOTE: Gemini API does NOT allow combining functionDeclarations with googleSearch
  // in the same request (400 "Tool use with function calling is unsupported").
  // Web search is implemented as a custom function that makes a separate grounded API call.
  return [
    {
      functionDeclarations: [
        {
          name: 'read_file',
          description: 'Read a file from the session workspace. Use relative paths like "spec.md" or "library/react-guide.md".',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Relative path within session workspace' }
            },
            required: ['path']
          }
        },
        {
          name: 'write_file',
          description: 'Write or update a file in the session workspace. For spec.md, always read first then write the complete updated content.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Relative path within session workspace' },
              content: { type: 'string', description: 'The complete file content to write' }
            },
            required: ['path', 'content']
          }
        },
        {
          name: 'list_library',
          description: 'List all files in the research library directory.',
          parameters: { type: 'object', properties: {} }
        },
        {
          name: 'web_search',
          description: 'Search the web for current information. Use for factual questions like "current version of X", "what is X", definitions, etc.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'The search query' }
            },
            required: ['query']
          }
        },
        {
          name: 'read_agent_results',
          description: 'Read the research agent\'s FULL memory — complete untruncated tool outputs including entire file contents the agent read, full bash command outputs, web search results, and web page fetches. This is the agent\'s raw data. Use this FIRST when asked about anything the agent just researched. Default: last 40 results.',
          parameters: {
            type: 'object',
            properties: {
              lastN: { type: 'number', description: 'Number of recent results to return (default: 40, max: 60)' }
            }
          }
        },
        {
          name: 'read_agent_text',
          description: 'Read the research agent\'s reasoning, analysis, and conclusions from JSONL. Contains the agent\'s step-by-step thinking, synthesis of findings, comparisons, and recommendations. Use this alongside read_agent_results to get the COMPLETE picture of what the agent researched and concluded. Default: last 60 messages.',
          parameters: {
            type: 'object',
            properties: {
              lastN: { type: 'number', description: 'Number of recent text messages to return (default: 60, max: 100)' }
            }
          }
        },
        {
          name: 'read_subagents',
          description: 'Read all sub-agent (parallel Task) transcripts. Contains the detailed work done by sub-agents spawned during research.',
          parameters: { type: 'object', properties: {} }
        },
        {
          name: 'search_jsonl',
          description: 'Search the agent\'s JSONL transcript for a keyword. Returns matching entries across all tool results, agent reasoning, and conversation history.',
          parameters: {
            type: 'object',
            properties: {
              keyword: { type: 'string', description: 'The keyword to search for (case-insensitive)' },
              maxResults: { type: 'number', description: 'Maximum number of results (default: 20)' }
            },
            required: ['keyword']
          }
        },
        {
          name: 'read_conversation',
          description: 'Read the user/assistant conversation exchange history. Shows what the user asked and what the agent responded.',
          parameters: {
            type: 'object',
            properties: {
              lastN: { type: 'number', description: 'Number of recent exchanges to return (default: 30)' }
            }
          }
        },
        {
          name: 'get_full_transcript',
          description: 'Read the COMPLETE agent transcript + all sub-agent transcripts. Most comprehensive view — use when targeted tools aren\'t enough.',
          parameters: { type: 'object', properties: {} }
        },
        {
          name: 'get_session_stats',
          description: 'Get session statistics: total messages, tool call counts by name, sub-agent count, data size, time range. Use to understand how much data is in the session before using deep tools.',
          parameters: { type: 'object', properties: {} }
        },
        {
          name: 'deep_read_results',
          description: 'Read ALL tool results across the ENTIRE session — not just recent ones. Use toolFilter to narrow by tool type. For detailed analyses, overviews, diagrams, specific questions requiring full context.',
          parameters: {
            type: 'object',
            properties: {
              toolFilter: {
                type: 'array',
                items: { type: 'string' },
                description: 'Only return results from these tools. E.g., ["Read"] for file reads, ["WebSearch","WebFetch"] for web data. Omit for all.'
              }
            }
          }
        },
        {
          name: 'deep_read_text',
          description: 'Read ALL agent reasoning across the ENTIRE session. For comprehensive overviews or detailed explanations of what the agent found throughout the session.',
          parameters: { type: 'object', properties: {} }
        },
        {
          name: 'send_to_chat',
          description: 'Send formatted content to the user\'s chat panel. Use for URLs, links, lists, prices, code snippets, or anything better read than spoken. Still speak a brief summary — use this for the detailed/visual content.',
          parameters: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'The formatted text to display in chat. Supports markdown.' }
            },
            required: ['text']
          }
        }
      ]
    }
  ]
}

/**
 * Perform a web search via Gemini's Google Search grounding.
 * This is called as a separate API request because Gemini doesn't allow
 * combining googleSearch with functionDeclarations in the same request.
 */
async function geminiWebSearch(query: string): Promise<string> {
  try {
    const ai = geminiClient!
    const response = await ai.models.generateContent({
      model: GEMINI_FAST_MODEL,
      contents: [{ role: 'user', parts: [{ text: query }] }],
      config: {
        tools: [{ googleSearch: {} }],
      }
    })
    return response.text || 'No web results found.'
  } catch (err) {
    console.error('❌ Gemini web search failed:', err)
    return `Web search failed: ${(err as Error).message}`
  }
}

// ============================================================
// Agent SDK Q&A implementation — replaces direct Anthropic API for Q&A
// ============================================================

/**
 * Create an in-process MCP server with the send_to_chat tool for the Agent SDK fast brain.
 */
function createFastBrainMcpServer(sendToChat?: (text: string) => void) {
  const tools: any[] = []

  if (sendToChat) {
    tools.push(
      sdkTool(
        'send_to_chat',
        'Send formatted content to the user\'s chat panel. Use for URLs, links, lists, prices, code snippets, tables, or anything better read than spoken. Supports markdown. You should STILL speak a brief summary — the chat content is supplementary.',
        { text: z.string().describe('The formatted text to display in chat. Supports markdown.') },
        async ({ text }) => {
          sendToChat(text)
          sendToChatCalledThisTurn = true
          return { content: [{ type: 'text' as const, text: 'Sent to chat. Now give a brief spoken summary of what you sent.' }] }
        }
      )
    )
  }

  return createSdkMcpServer({
    name: 'osborn-fast-brain',
    version: '1.0.0',
    tools,
  })
}

/**
 * Ask via Claude Agent SDK — the agent traverses JSONL files natively using Read/Grep/Glob.
 * Falls back to Gemini on timeout or error.
 */
async function askViaAgentSdk(
  question: string,
  workspace: string,
  researchContext?: string,
  sessionId?: string,
  workingDir?: string,
  chatHistory?: ConversationTurn[],
  sendToChat?: (text: string) => void,
  sessionBaseDir?: string,
): Promise<string> {
  sendToChatCalledThisTurn = false

  // Build the prompt with conversation context
  let prompt = question
  if (researchContext) {
    prompt += `\n\n[LIVE RESEARCH CONTEXT — the deep research agent is currently working]\n${researchContext}`
  }
  if (chatHistory && chatHistory.length > 0) {
    const historyStr = chatHistory.slice(-15).map(t => `${t.role}: ${t.text}`).join('\n')
    prompt = `[Recent voice conversation]\n${historyStr}\n\n[Current question]\n${prompt}`
  }

  // Create MCP server for send_to_chat
  const mcpServer = createFastBrainMcpServer(sendToChat)

  // Build system prompt with computed paths
  const systemPrompt = buildFastBrainSdkPrompt(
    workingDir || workspace,
    sessionId || '',
    sessionBaseDir || workingDir || workspace,
  )

  // Tools: Read/Write/Edit for files, Grep/Glob for search, WebSearch/WebFetch for web
  const toolNames = ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'WebSearch', 'WebFetch']
  const mcpToolPatterns = sendToChat ? ['mcp__osborn-fast-brain__*'] : []

  const options: any = {
    model: ANTHROPIC_FAST_MODEL,
    cwd: workingDir,
    systemPrompt,
    maxTurns: 8,
    tools: toolNames,
    allowedTools: [...toolNames, ...mcpToolPatterns],
    mcpServers: { 'osborn-fast-brain': mcpServer },
  }

  if (fastBrainSessionId) {
    options.resume = fastBrainSessionId
  }

  // Run with 15s timeout — falls back to Gemini on timeout
  const TIMEOUT_MS = 15000
  let timeoutHandle: ReturnType<typeof setTimeout>
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error('fast-brain-timeout')), TIMEOUT_MS)
  })

  const queryPromise = (async () => {
    let result = ''

    try {
      for await (const message of sdkQuery({ prompt, options })) {
        if (message.type === 'result') {
          result = (message as any).result || ''
        }
        // Capture session ID eagerly — even if we timeout, next call can resume
        if (message.type === 'assistant' && (message as any).session_id) {
          const sid = (message as any).session_id
          if (sid !== fastBrainSessionId) {
            fastBrainSessionId = sid
            console.log(`🧠 Fast brain session: ${sid.substring(0, 12)}... (${options.resume ? 'resumed' : 'new'})`)
          }
        }
      }
    } catch (err) {
      console.error('❌ Agent SDK query error:', err)
      throw err
    }

    clearTimeout(timeoutHandle!)
    return result
  })()

  try {
    const result = await Promise.race([queryPromise, timeoutPromise])
    if (!result || result.trim().length === 0) {
      if (sendToChatCalledThisTurn) return "I've sent the details to your chat panel."
      return 'No answer found.'
    }
    console.log(`🧠 Agent SDK fast brain: ${result.length} chars (session: ${fastBrainSessionId?.substring(0, 8) || 'new'})`)
    return result
  } catch (err: any) {
    clearTimeout(timeoutHandle!)
    if (err.message === 'fast-brain-timeout') {
      console.log('⏱️ Agent SDK fast brain timed out (15s), falling back to Gemini')
    } else {
      console.error('❌ Agent SDK fast brain error:', err.message || err)
    }
    // Fall back to Gemini if available
    if (geminiClient) {
      console.log('🔄 Falling back to Gemini fast brain')
      return askViaGemini(question, workspace, researchContext, sessionId, workingDir, chatHistory, sendToChat)
    }
    // Fall back to direct Anthropic API if no Gemini
    if (anthropicClient) {
      console.log('🔄 Falling back to direct Anthropic API')
      return askViaAnthropic(question, workspace, researchContext, sessionId, workingDir, chatHistory, sendToChat)
    }
    return 'Fast brain unavailable. Try asking me to research it.'
  }
}

// ============================================================
// Direct Anthropic API Q&A — kept as fallback for Agent SDK failures
// ============================================================

async function askViaAnthropic(
  question: string,
  workspace: string,
  researchContext?: string,
  sessionId?: string,
  workingDir?: string,
  chatHistory?: ConversationTurn[],
  sendToChat?: (text: string) => void
): Promise<string> {
  const client = anthropicClient!
  const tools = buildAnthropicTools()
  sendToChatCalledThisTurn = false

  const userContent = researchContext
    ? `${question}\n\n[LIVE RESEARCH CONTEXT — the research agent is currently working]\n${researchContext}`
    : question

  // Build messages from live voice conversation history (from agent.chatCtx)
  const messages: Anthropic.Messages.MessageParam[] = []
  if (chatHistory && chatHistory.length > 0) {
    for (const turn of chatHistory) {
      messages.push({ role: turn.role, content: turn.text })
    }
  }
  messages.push({ role: 'user', content: userContent })

  const allTools: Anthropic.Messages.Tool[] | any[] = [...tools, ANTHROPIC_WEB_SEARCH]
  const noAnswerFallback = () => sendToChatCalledThisTurn
    ? "I've sent the details to your chat panel."
    : 'No answer found.'

  for (let i = 0; i < 10; i++) {
    const response = await client.messages.create({
      model: ANTHROPIC_FAST_MODEL,
      max_tokens: 10000,
      system: FAST_BRAIN_SYSTEM_PROMPT,
      tools: allTools,
      messages,
    })

    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find(
        (b): b is Anthropic.Messages.TextBlock => b.type === 'text'
      )
      return textBlock?.text || noAnswerFallback()
    }

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use'
    )

    if (toolUseBlocks.length === 0 && response.stop_reason !== 'tool_use') {
      const textBlock = response.content.find(
        (b): b is Anthropic.Messages.TextBlock => b.type === 'text'
      )
      return textBlock?.text || noAnswerFallback()
    }

    messages.push({ role: 'assistant', content: response.content as any })

    if (toolUseBlocks.length > 0) {
      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = toolUseBlocks.map(toolUse => ({
        type: 'tool_result' as const,
        tool_use_id: toolUse.id,
        content: executeTool(toolUse.name, toolUse.input as Record<string, any>, workspace, sessionId, workingDir, sendToChat),
      }))
      messages.push({ role: 'user', content: toolResults })
    }
  }

  if (sendToChatCalledThisTurn) {
    return "I've sent the full details to your chat. Let me know if you want to dive deeper into anything."
  }
  return 'Fast brain reached maximum tool iterations. Try ask_agent for a deeper search.'
}

// ============================================================
// Gemini Q&A implementation
// ============================================================

async function askViaGemini(
  question: string,
  workspace: string,
  researchContext?: string,
  sessionId?: string,
  workingDir?: string,
  chatHistory?: ConversationTurn[],
  sendToChat?: (text: string) => void,
  sessionBaseDir?: string,
): Promise<string> {
  const ai = geminiClient!
  const tools = buildGeminiTools()
  sendToChatCalledThisTurn = false

  const userContent = researchContext
    ? `${question}\n\n[LIVE RESEARCH CONTEXT — the research agent is currently working]\n${researchContext}`
    : question

  // Build contents from live voice conversation history (from agent.chatCtx)
  const contents: any[] = []
  if (chatHistory && chatHistory.length > 0) {
    for (const turn of chatHistory) {
      contents.push({
        role: turn.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: turn.text }],
      })
    }
  }
  contents.push({ role: 'user', parts: [{ text: userContent }] })

  const systemPrompt = FAST_BRAIN_SYSTEM_PROMPT

  for (let i = 0; i < 10; i++) {
    const response = await ai.models.generateContent({
      model: GEMINI_FAST_MODEL,
      contents,
      config: {
        systemInstruction: systemPrompt,
        tools,
      }
    })

    const functionCalls = response.functionCalls
    if (!functionCalls || functionCalls.length === 0) {
      const text = response.text
      if (text) return text
      // If LLM returned empty text but sent content to chat, use fallback
      if (sendToChatCalledThisTurn) return "I've sent the details to your chat panel."
      return 'No answer found.'
    }

    // Add model response to conversation
    if (response.candidates?.[0]?.content) {
      contents.push(response.candidates[0].content)
    }

    // Execute tools and send results back (web_search is async, others are sync)
    const functionResponses = await Promise.all(functionCalls.map(async (call: any) => {
      let result: string
      if (call.name === 'web_search') {
        result = await geminiWebSearch(call.args?.query || question)
      } else {
        result = executeTool(call.name, call.args || {}, workspace, sessionId, workingDir, sendToChat)
      }
      return {
        functionResponse: {
          name: call.name,
          response: { result }
        }
      }
    }))

    contents.push({ role: 'user', parts: functionResponses })
  }

  if (sendToChatCalledThisTurn) {
    return "I've sent the full details to your chat. Let me know if you want to dive deeper into anything."
  }
  return 'Fast brain reached maximum tool iterations. Try ask_agent for a deeper search.'
}

// ============================================================
// askHaiku — Main Q&A function (dispatches to provider)
// ============================================================

/**
 * Ask the fast brain a question with access to session files and web search.
 * Returns an answer or "NEEDS_DEEPER_RESEARCH: ..." for escalation.
 *
 * Auth chain: Anthropic (API key → auth token → Keychain OAuth) → Gemini Flash fallback
 *
 * @param researchContext - Optional snapshot of the live research log.
 * ~2 second response time for most queries.
 */
export async function askHaiku(
  workingDir: string,
  sessionId: string,
  question: string,
  researchContext?: string,
  chatHistory?: ConversationTurn[],
  sendToChat?: (text: string) => void,
  sessionBaseDir?: string,
): Promise<string> {
  initProvider()

  // workspace uses sessionBaseDir (Osborn install dir) for spec.md/library
  // workingDir is for JSONL access (matches Claude SDK cwd)
  const wsDir = sessionBaseDir || workingDir
  const workspace = getSessionWorkspace(wsDir, sessionId)

  // Primary: Gemini Flash (~1-2s) with pre-loaded JSONL context
  // Fallback: Anthropic direct API or Agent SDK (slower but functional)
  if (provider === 'gemini') {
    return askViaGemini(question, workspace, researchContext, sessionId, workingDir, chatHistory, sendToChat, wsDir)
  } else if (provider === 'anthropic' || provider === 'agent-sdk') {
    return askViaAgentSdk(question, workspace, researchContext, sessionId, workingDir, chatHistory, sendToChat, wsDir)
  } else {
    return 'NEEDS_DEEPER_RESEARCH: Fast brain unavailable (no API key or CLI auth). Try ask_agent instead.'
  }
}

// ============================================================
// Central orchestrator — askFastBrain
// ============================================================

/** Callbacks for the fast brain to trigger side effects in index.ts */
export interface FastBrainCallbacks {
  triggerResearch: (task: string) => void
  queueVoice: (script: string) => void
  sendToFrontend: (data: any) => void
}

/** Structured response from the fast brain orchestrator */
export interface FastBrainResponse {
  /** Teleprompter script for the voice model to speak */
  script: string
  /** Response type for caller routing */
  type: 'answer' | 'research_started' | 'recorded' | 'question'
}

let researchTaskCounter = 0

/**
 * Central orchestrator — ALL user questions from the realtime model come here.
 * Routes to: direct answer, research triggering, decision recording, or document generation.
 * Returns a teleprompter script the voice model reads verbatim.
 */
export async function askFastBrain(
  workingDir: string,
  sessionId: string,
  question: string,
  opts: {
    chatHistory?: ConversationTurn[]
    researchContext?: string
    callbacks: FastBrainCallbacks
    sessionBaseDir?: string
  }
): Promise<FastBrainResponse> {
  const { chatHistory, researchContext, callbacks } = opts
  const wsDir = opts.sessionBaseDir || workingDir

  // Detect document generation requests
  const docMatch = detectDocumentRequest(question)
  if (docMatch) {
    try {
      const result = await generateVisualDocument(workingDir, sessionId, question, docMatch, wsDir)
      if (result) {
        const fullPath = `${wsDir}/.osborn/sessions/${sessionId}/library/${result.fileName}`
        callbacks.sendToFrontend({
          type: 'research_artifact_updated',
          filePath: fullPath,
          fileName: result.fileName,
        })
        return {
          script: `I've created a ${docMatch} document called ${result.fileName}. You can see it in the files panel.`,
          type: 'answer',
        }
      }
    } catch (err) {
      console.error('❌ askFastBrain: document generation failed:', err)
    }
    // Fall through to regular handling if document gen fails
  }

  // Create sendToChat wrapper that sends assistant_response to frontend
  const sendToChat = (text: string) => {
    callbacks.sendToFrontend({ type: 'assistant_response', text })
  }

  // Core: ask the fast brain LLM
  const answer = await askHaiku(workingDir, sessionId, question, researchContext, chatHistory, sendToChat, wsDir)

  // Parse the response to determine routing
  if (answer.startsWith('RECORDED:') || answer.includes('\nRECORDED:')) {
    // Decision was recorded — extract the confirmation
    const recordedLine = answer.split('\n').find(l => l.startsWith('RECORDED:'))
    const confirmation = recordedLine
      ? recordedLine.replace('RECORDED:', '').trim()
      : 'Got it, noted.'

    // Notify frontend about spec update
    const specPath = `${wsDir}/.osborn/sessions/${sessionId}/spec.md`
    callbacks.sendToFrontend({
      type: 'research_artifact_updated',
      filePath: specPath,
      fileName: 'spec.md',
    })

    return { script: confirmation, type: 'recorded' }
  }

  // Handle ASK_USER — questions directed at the user (not research tasks)
  if (answer.startsWith('ASK_USER:') || answer.includes('\nASK_USER:')) {
    const askLine = answer.split('\n').find(l => l.includes('ASK_USER:'))
    const userQuestion = askLine
      ? askLine.replace(/^ASK_USER:\s*/, '').trim()
      : answer.replace(/^ASK_USER:\s*/, '').trim()
    return { script: userQuestion, type: 'question' }
  }

  if (answer.includes('NEEDS_DEEPER_RESEARCH')) {
    // Extract the research task context
    const needsLine = answer.split('\n').find(l => l.includes('NEEDS_DEEPER_RESEARCH'))
    const contextLine = answer.split('\n').find(l => l.startsWith('CONTEXT:'))
    const researchTask = needsLine
      ? needsLine.replace(/^(PARTIAL:\s*)?NEEDS_DEEPER_RESEARCH:\s*/, '').trim()
      : question
    const contextStr = contextLine ? contextLine.replace('CONTEXT:', '').trim() : ''

    // Safety check: if the "research task" looks like a question for the user
    // (ends with ?, asks about preferences/needs, is very short), treat it as ASK_USER instead.
    // This catches the common Gemini bug where clarification questions are formatted as research tasks.
    const taskLower = researchTask.toLowerCase()
    const looksLikeUserQuestion = (
      researchTask.endsWith('?') && (
        taskLower.includes('would you') ||
        taskLower.includes('do you') ||
        taskLower.includes('could you') ||
        taskLower.includes('what kind of') ||
        taskLower.includes('which') ||
        taskLower.includes('your needs') ||
        taskLower.includes('your preference') ||
        taskLower.includes('more details') ||
        taskLower.includes('clarif') ||
        taskLower.includes('specify') ||
        taskLower.includes('interested in') ||
        researchTask.length < 80 // Very short "tasks" ending in ? are almost always user questions
      )
    )

    if (looksLikeUserQuestion) {
      console.log(`🧠 [fast brain] Caught question-as-research-task, redirecting to ASK_USER: "${researchTask.substring(0, 100)}"`)
      return { script: researchTask, type: 'question' }
    }

    const fullTask = contextStr ? `${researchTask}\n\nContext: ${contextStr}` : researchTask

    // Extract any partial answer (spoken script before NEEDS_DEEPER_RESEARCH)
    const partialMatch = answer.match(/^PARTIAL:\s*([\s\S]*?)(?=\nNEEDS_DEEPER_RESEARCH)/m)
    const partialScript = partialMatch ? partialMatch[1].trim() : ''

    // Generate a task ID for frontend tracking
    researchTaskCounter++
    const taskId = `research-${researchTaskCounter}-${Date.now()}`

    // Trigger research in background
    callbacks.triggerResearch(fullTask)
    callbacks.sendToFrontend({
      type: 'research_task_started',
      task: researchTask.substring(0, 200),
      taskId,
    })

    // Generate acknowledgment script
    let script: string
    if (partialScript) {
      script = `${partialScript} Let me dig deeper on the rest.`
    } else {
      // Generate a contextual ack based on conversation flow
      script = generateResearchAck(question, chatHistory)
    }

    return { script, type: 'research_started' }
  }

  // Direct answer — the response IS the teleprompter script
  return { script: answer, type: 'answer' }
}

/** Detect if the user's question is an EXPLICIT document generation request.
 * Must be very specific — don't catch general questions about analysis or comparisons.
 * Only triggers when the user explicitly asks for a written document/artifact. */
function detectDocumentRequest(question: string): 'comparison' | 'diagram' | 'analysis' | 'summary' | null {
  const q = question.toLowerCase()
  // Only match explicit document requests — "create a comparison", "make a diagram", "write a summary"
  // Do NOT match: "compare X and Y", "analyze the code", "give me an overview"
  const docVerbs = /(create|make|generate|write|build|produce|draw)\s+(a\s+|an\s+|the\s+)?/
  if (!docVerbs.test(q)) return null
  if (q.includes('comparison') || q.includes('comparison table') || q.includes('comparison document')) return 'comparison'
  if (q.includes('diagram') || q.includes('flow chart') || q.includes('architecture diagram')) return 'diagram'
  if (q.includes('analysis document') || q.includes('tradeoff document')) return 'analysis'
  if (q.includes('summary document') || q.includes('overview document')) return 'summary'
  return null
}

/** Generate a natural research acknowledgment based on conversation context */
function generateResearchAck(question: string, chatHistory?: ConversationTurn[]): string {
  // Use simple heuristics for a natural ack — no LLM call needed
  const q = question.toLowerCase()
  if (q.includes('how') && (q.includes('work') || q.includes('implement'))) {
    return "Let me look into how that works. I'll have the details for you shortly."
  }
  if (q.includes('what') && (q.includes('option') || q.includes('available') || q.includes('choice'))) {
    return "Let me research the options for you."
  }
  if (q.includes('why') || q.includes('explain')) {
    return "Good question. Let me dig into that."
  }
  if (q.includes('find') || q.includes('search') || q.includes('look')) {
    return "On it. Give me a moment to look into that."
  }
  return "Let me research that for you. I'll have findings shortly."
}

// ============================================================
// processResearchChunk — Incremental content processing during research
// ============================================================

/**
 * Process a batch of research content chunks through the fast brain.
 * Updates spec.md and library/ files incrementally during research.
 *
 * @param isRefinement - true for the final post-research consolidation pass (higher token budget)
 */
export async function processResearchChunk(
  workingDir: string,
  sessionId: string,
  task: string,
  contentChunks: string[],
  isRefinement?: boolean,
  sessionBaseDir?: string,
): Promise<{ spec: string | null, libraryFiles: string[] } | null> {
  initProvider()
  if (provider === 'none') return null
  if (contentChunks.length === 0) return null

  // Prevent concurrent spec writes
  if (specUpdateInProgress) {
    console.log('⏸️ processResearchChunk: spec update already in progress, skipping')
    return null
  }

  specUpdateInProgress = true
  const wsDir = sessionBaseDir || workingDir
  try {
    const workspace = getSessionWorkspace(wsDir, sessionId)
    const specPath = `${workspace}/spec.md`
    if (!existsSync(specPath)) {
      console.log('⚠️ processResearchChunk: spec.md not found, skipping')
      return null
    }

    const currentSpec = readFileSync(specPath, 'utf-8')
    const libraryDir = `${workspace}/library`

    // Only read library files during refinement pass (final consolidation)
    // Mid-research: skip library entirely to stay fast and avoid file proliferation
    let existingSection = ''
    if (isRefinement) {
      const existingFiles = listLibraryFiles(wsDir, sessionId)
      const existingContents: string[] = []
      for (const file of existingFiles) {
        const filePath = `${libraryDir}/${file}`
        if (existsSync(filePath)) {
          try {
            const content = readFileSync(filePath, 'utf-8')
            existingContents.push(`--- ${file} ---\n${content}`)
          } catch { /* skip */ }
        }
      }
      existingSection = existingContents.length > 0
        ? `\n\nExisting library/ files:\n${existingContents.join('\n\n')}`
        : ''
    }

    // No content capping — models handle 200K+ tokens (Haiku) / 1M+ (Gemini Flash)
    const chunksText = contentChunks.join('\n\n---\n\n')

    // Use different prompts: mid-research = spec only, refinement = spec + library
    const systemPrompt = isRefinement ? REFINEMENT_PROCESS_SYSTEM : CHUNK_PROCESS_SYSTEM

    const userMessage = `Research task: "${task}"

Current spec.md:
\`\`\`markdown
${currentSpec}
\`\`\`
${existingSection}

Content chunks from research:
${chunksText}

Return ONLY valid JSON — no code fences, no explanation.`

    let responseText: string | null = null

    if (anthropicClient) {
      const response = await anthropicClient.messages.create({
        model: ANTHROPIC_FAST_MODEL,
        max_tokens: isRefinement ? 20000 : 10000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }]
      })
      responseText = response.content[0].type === 'text' ? response.content[0].text : null
    } else if (geminiClient) {
      const response = await geminiClient.models.generateContent({
        model: GEMINI_FAST_MODEL,
        contents: userMessage,
        config: { systemInstruction: systemPrompt }
      })
      responseText = response.text || null
    }

    if (!responseText) return null

    // Parse JSON response — multi-strategy for robustness
    const parsed = parseChunkResponse(responseText)
    if (!parsed) return null

    let updatedSpec: string | null = null
    const writtenFiles: string[] = []

    // Write spec.md
    if (parsed.spec && typeof parsed.spec === 'string' && parsed.spec.length > 50) {
      writeFileSync(specPath, parsed.spec, 'utf-8')
      updatedSpec = parsed.spec
      const label = isRefinement ? 'refinement pass' : 'chunk'
      console.log(`📋 Fast brain processed research ${label} — spec.md updated (${parsed.spec.length} chars)`)
    }

    // Write library files — ONLY during refinement pass (prevents file proliferation)
    if (isRefinement && parsed.library && Array.isArray(parsed.library) && parsed.library.length > 0) {
      mkdirSync(libraryDir, { recursive: true })
      for (const file of parsed.library) {
        if (!file.filename || !file.content) continue
        const safeName = file.filename.replace(/[^a-zA-Z0-9._-]/g, '-')
        const filePath = `${libraryDir}/${safeName}`
        writeFileSync(filePath, file.content, 'utf-8')
        console.log(`📝 Fast brain wrote library/${safeName} (${file.content.length} chars)`)
        writtenFiles.push(safeName)
      }
    }

    const label = isRefinement ? 'refinement' : `${contentChunks.length} content items`
    console.log(`📋 Fast brain processed research chunk (${label})`)

    return { spec: updatedSpec, libraryFiles: writtenFiles }
  } catch (err) {
    console.error('❌ processResearchChunk failed:', err)
    return null
  } finally {
    specUpdateInProgress = false
  }
}

// Simple lock to prevent concurrent spec writes during research
let specUpdateInProgress = false

// ============================================================
// parseChunkResponse — Robust JSON parsing for LLM output
// ============================================================

/**
 * Multi-strategy JSON parser for LLM chunk processing responses.
 * Handles code fences, control characters, and raw markdown fallbacks.
 *
 * Strategies (tried in order):
 * 1. Direct JSON.parse after stripping code fences
 * 2. Control character stripping (newlines, tabs in string values)
 * 3. Regex extraction of spec field from malformed JSON
 * 4. Raw markdown detection (LLM returned spec directly instead of JSON)
 */
function parseChunkResponse(
  responseText: string
): { spec?: string, library?: { filename: string, content: string }[] } | null {
  const cleaned = responseText.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim()

  // Strategy 1: Direct parse
  try {
    return JSON.parse(cleaned)
  } catch { /* continue */ }

  // Strategy 2: Strip control characters in string values
  try {
    const sanitized = cleaned.replace(/[\x00-\x1f]/g, (ch) => {
      if (ch === '\n') return '\\n'
      if (ch === '\r') return '\\r'
      if (ch === '\t') return '\\t'
      return ''
    })
    return JSON.parse(sanitized)
  } catch { /* continue */ }

  // Strategy 3: Regex extract spec field
  const specMatch = cleaned.match(/"spec"\s*:\s*"((?:[^"\\]|\\.)*)"/s)
  if (specMatch) {
    try {
      const specContent = JSON.parse(`"${specMatch[1]}"`)
      return { spec: specContent }
    } catch { /* continue */ }
  }

  // Strategy 4: Raw markdown — LLM returned spec directly
  if (cleaned.startsWith('#') && cleaned.includes('## ')) {
    console.log('⚠️ parseChunkResponse: detected raw markdown, treating as spec')
    return { spec: cleaned }
  }

  console.error('⚠️ parseChunkResponse: all strategies failed')
  return null
}

// ============================================================
// augmentResearchResult — Fast brain adds spec context to agent results (NO summarization)
// ============================================================

/**
 * Augment agent SDK research results with context from spec.md.
 * Passes ALL specific details through verbatim — only ADDS context annotations.
 * The voice model downstream handles summarization for speech.
 *
 * Falls back to returning the original result if the fast brain is unavailable.
 */
export async function augmentResearchResult(
  workingDir: string,
  sessionId: string,
  task: string,
  agentResult: string
): Promise<string> {
  initProvider()
  if (provider === 'none') return agentResult

  try {
    // Read spec for context
    const specContent = readSessionSpec(workingDir, sessionId)
    const libraryFiles = listLibraryFiles(workingDir, sessionId)

    const specSection = specContent
      ? `\n\nCurrent spec.md:\n${specContent}`
      : ''
    const libSection = libraryFiles.length > 0
      ? `\n\nLibrary files available: ${libraryFiles.join(', ')}`
      : ''

    const userMessage = `Research task: "${task}"

Agent findings:
${agentResult}
${specSection}${libSection}

Augment the agent's findings with relevant context from the spec. Pass ALL details through verbatim.`

    let responseText: string | null = null

    if (anthropicClient) {
      const response = await anthropicClient.messages.create({
        model: ANTHROPIC_FAST_MODEL,
        max_tokens: 16000,
        system: AUGMENT_RESULT_SYSTEM,
        messages: [{ role: 'user', content: userMessage }]
      })
      responseText = response.content[0].type === 'text' ? response.content[0].text : null
    } else if (geminiClient) {
      const response = await geminiClient.models.generateContent({
        model: GEMINI_FAST_MODEL,
        contents: userMessage,
        config: { systemInstruction: AUGMENT_RESULT_SYSTEM }
      })
      responseText = response.text || null
    }

    if (!responseText || responseText.length < agentResult.length * 0.5) {
      // If augmented result is suspiciously shorter, the LLM likely summarized — use original
      console.log('⚠️ augmentResearchResult: augmented result too short, using original')
      return agentResult
    }

    console.log(`🔄 augmentResearchResult: augmented ${agentResult.length} → ${responseText.length} chars`)
    return responseText
  } catch (err) {
    console.error('❌ augmentResearchResult failed:', err)
    return agentResult // Fallback to original on error
  }
}

// ============================================================
// updateSpecFromJSONL — Post-research spec consolidation via JSONL
// ============================================================

/**
 * Update spec.md and library/ files after research completes.
 * Reads FULL untruncated data directly from Claude Agent SDK JSONL files
 * instead of receiving pre-truncated content chunks.
 *
 * Data sources:
 * - getRecentToolResults() — last 30 full tool results (Read, Bash, WebSearch, etc.)
 * - readSessionHistory() — last 50 assistant messages (agent reasoning/analysis)
 * - getSubagentTranscripts() — all sub-agent findings
 *
 * Returns { spec, libraryFiles } or null if update failed.
 */
export async function updateSpecFromJSONL(
  workingDir: string,
  sessionId: string,
  task: string,
  researchLog: string[],
  sessionBaseDir?: string,
): Promise<{ spec: string | null, libraryFiles: string[] } | null> {
  initProvider()
  if (provider === 'none') return null

  try {
    // 1. Read FULL data from JSONL — no truncation
    const toolResults = getRecentToolResults(sessionId, workingDir, 30)
    const assistantMessages = readSessionHistory(sessionId, workingDir, {
      lastN: 50,
      types: ['assistant']
    })
    const subagents = getSubagentTranscripts(sessionId, workingDir)

    // 2. Build comprehensive content from FULL data
    const contentChunks: string[] = []

    // Tool results — full content
    if (toolResults.length > 0) {
      const toolContent = toolResults.map(tr => {
        const inputPreview = JSON.stringify(tr.toolInput).substring(0, 200)
        return `[${tr.toolName}: ${inputPreview}]\n${tr.resultContent}`
      }).join('\n\n---\n\n')
      contentChunks.push(toolContent)
    }

    // Agent reasoning — full text
    const agentTexts = assistantMessages
      .filter(m => m.text && m.text.length > 20)
      .map(m => `[Agent reasoning]\n${m.text}`)
    if (agentTexts.length > 0) {
      contentChunks.push(agentTexts.join('\n\n'))
    }

    // Sub-agent findings — full text
    if (subagents.length > 0) {
      const subagentContent = subagents.map(sa => {
        const findings = sa.messages
          .filter(m => m.type === 'assistant' && m.text)
          .map(m => `[Sub-agent ${sa.taskId}]\n${m.text}`)
        return findings.join('\n\n')
      }).filter(c => c.length > 0)
      if (subagentContent.length > 0) {
        contentChunks.push(subagentContent.join('\n\n'))
      }
    }

    // Research log summary
    if (researchLog.length > 0) {
      contentChunks.push(`[Research log summary]\n${researchLog.slice(0, 25).join('\n')}`)
    }

    if (contentChunks.length === 0) {
      console.log('⚠️ updateSpecFromJSONL: no content found in JSONL')
      return null
    }

    const totalChars = contentChunks.reduce((sum, c) => sum + c.length, 0)
    console.log(`📖 updateSpecFromJSONL: read ${toolResults.length} tool results, ${agentTexts.length} agent messages, ${subagents.length} sub-agents (${totalChars} total chars)`)

    // 3. Pass to processResearchChunk with isRefinement=true
    return processResearchChunk(workingDir, sessionId, task, contentChunks, true, sessionBaseDir)
  } catch (err) {
    console.error('❌ updateSpecFromJSONL failed:', err)
    return null
  }
}

// ============================================================
// Fire-and-forget: Question Writer — writes user question to spec BEFORE agent starts
// ============================================================

/**
 * Fire-and-forget: Write a user question to spec.md Open Questions > From User
 * before the agent starts researching. Ensures every escalated question is tracked.
 *
 * Uses a simple LLM call to fuzzy-match existing questions and avoid duplicates.
 * Skips if spec.md doesn't exist yet or no provider is available.
 */
export async function writeQuestionToSpec(
  workingDir: string,
  sessionId: string,
  question: string
): Promise<void> {
  initProvider()
  if (provider === 'none') return

  try {
    const workspace = getSessionWorkspace(workingDir, sessionId)
    const specPath = `${workspace}/spec.md`
    if (!existsSync(specPath)) return

    const currentSpec = readFileSync(specPath, 'utf-8')

    // Quick check: if the question (or something very similar) is already in the spec, skip
    const normalizedQ = question.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim()
    if (normalizedQ.length < 10) return // Too short to track

    const systemPrompt = `You manage the "Open Questions" section of a research spec file.

Given the current spec.md and a new user question, decide:
1. Is this question (or something very similar) already tracked? If yes, output: SKIP
2. If not, output the COMPLETE updated spec.md with the question added under "## Open Questions > ### From User (unanswered)" as a checkbox: - [ ] Question

Rules:
- Add a timestamp: (asked ${new Date().toLocaleTimeString()})
- Do NOT modify any other section of the spec
- Do NOT mark existing questions as answered
- Output ONLY the full spec.md content or the word SKIP — nothing else`

    const userMessage = `Current spec.md:\n\`\`\`\n${currentSpec}\n\`\`\`\n\nNew user question to track:\n"${question}"`

    let responseText: string | null = null

    if (anthropicClient) {
      const response = await anthropicClient.messages.create({
        model: ANTHROPIC_FAST_MODEL,
        max_tokens: 8000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }]
      })
      responseText = response.content[0].type === 'text' ? response.content[0].text : null
    } else if (geminiClient) {
      const response = await geminiClient.models.generateContent({
        model: GEMINI_FAST_MODEL,
        contents: userMessage,
        config: { systemInstruction: systemPrompt }
      })
      responseText = response.text || null
    }

    if (!responseText || responseText.trim() === 'SKIP') {
      console.log(`📝 writeQuestionToSpec: question already tracked or skipped`)
      return
    }

    // Strip code fences if present
    let updatedSpec = responseText.trim()
    if (updatedSpec.startsWith('```')) {
      updatedSpec = updatedSpec.replace(/^```(?:markdown)?\n?/, '').replace(/\n?```$/, '')
    }

    // Sanity check: updated spec should be at least as long as current spec
    if (updatedSpec.length >= currentSpec.length * 0.8) {
      writeFileSync(specPath, updatedSpec, 'utf-8')
      console.log(`📝 writeQuestionToSpec: added question to spec (${updatedSpec.length} chars)`)
    }
  } catch (err) {
    console.error('❌ writeQuestionToSpec failed:', err)
  }
}

// ============================================================
// Fire-and-forget: Answer Checker — checks agent output against open questions
// ============================================================

// Debounce guard: prevent flooding during rapid tool_result sequences
let answerCheckTimer: ReturnType<typeof setTimeout> | null = null
let pendingAnswerCheck: { workingDir: string, sessionId: string, output: string, outputType: string } | null = null

/**
 * Fire-and-forget: Check if substantial agent output answers any open questions in spec.md.
 * Debounced (3s) to prevent flooding during rapid tool_result sequences.
 *
 * When a question is answered, marks it with [x] and moves the answer to Findings.
 */
export async function checkOutputAgainstQuestions(
  workingDir: string,
  sessionId: string,
  output: string,
  outputType: 'tool_result' | 'assistant_text'
): Promise<void> {
  // Store the latest check request (newer output replaces older)
  pendingAnswerCheck = { workingDir, sessionId, output, outputType }

  // Debounce: only fire after 3s of quiet
  if (answerCheckTimer) return
  answerCheckTimer = setTimeout(async () => {
    answerCheckTimer = null
    const check = pendingAnswerCheck
    pendingAnswerCheck = null
    if (!check) return

    await executeAnswerCheck(check.workingDir, check.sessionId, check.output, check.outputType)
  }, 3000)
}

async function executeAnswerCheck(
  workingDir: string,
  sessionId: string,
  output: string,
  outputType: string
): Promise<void> {
  initProvider()
  if (provider === 'none') return

  try {
    const workspace = getSessionWorkspace(workingDir, sessionId)
    const specPath = `${workspace}/spec.md`
    if (!existsSync(specPath)) return

    const currentSpec = readFileSync(specPath, 'utf-8')

    // Quick check: are there any open questions?
    if (!currentSpec.includes('- [ ]')) {
      return // No open questions to check against
    }

    const systemPrompt = `You check if research output answers any open questions in a spec file.

Given the current spec.md and a piece of agent output (${outputType}), decide:
1. Does this output answer (fully or partially) any "- [ ]" questions in "## Open Questions"?
2. If YES: output the COMPLETE updated spec.md with:
   - Answered questions marked: - [x] Question → Brief answer summary (from research)
   - Key findings added to "## Findings & Resources" section
3. If NO questions are answered: output NONE

Rules:
- Only mark a question answered if the output CLEARLY provides the answer
- Keep the answer summary brief (1-2 sentences)
- Do NOT modify questions that aren't answered by this output
- Do NOT remove or rewrite existing Findings
- Output ONLY the full spec.md content or the word NONE — nothing else`

    // Truncate output to avoid overwhelming the model on very large tool results
    const truncatedOutput = output.length > 15000 ? output.substring(0, 15000) + '\n[... truncated]' : output

    const userMessage = `Current spec.md:\n\`\`\`\n${currentSpec}\n\`\`\`\n\nAgent output (${outputType}):\n\`\`\`\n${truncatedOutput}\n\`\`\``

    let responseText: string | null = null

    if (anthropicClient) {
      const response = await anthropicClient.messages.create({
        model: ANTHROPIC_FAST_MODEL,
        max_tokens: 8000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }]
      })
      responseText = response.content[0].type === 'text' ? response.content[0].text : null
    } else if (geminiClient) {
      const response = await geminiClient.models.generateContent({
        model: GEMINI_FAST_MODEL,
        contents: userMessage,
        config: { systemInstruction: systemPrompt }
      })
      responseText = response.text || null
    }

    if (!responseText || responseText.trim() === 'NONE') {
      return
    }

    // Strip code fences if present
    let updatedSpec = responseText.trim()
    if (updatedSpec.startsWith('```')) {
      updatedSpec = updatedSpec.replace(/^```(?:markdown)?\n?/, '').replace(/\n?```$/, '')
    }

    // Sanity check
    if (updatedSpec.length >= currentSpec.length * 0.8) {
      writeFileSync(specPath, updatedSpec, 'utf-8')
      console.log(`✅ checkOutputAgainstQuestions: marked question(s) as answered in spec (${updatedSpec.length} chars)`)
    }
  } catch (err) {
    console.error('❌ checkOutputAgainstQuestions failed:', err)
  }
}

// ============================================================
// contextualizeResearchUpdate — Fast brain generates natural voice updates during research
// ============================================================

/**
 * Generate a natural, contextualized voice update from raw research events.
 * Called by scheduleResearchBatch() instead of injecting raw events directly.
 *
 * Returns a natural 1-2 sentence update, or null if nothing interesting to say.
 * 3-second timeout — returns null if the LLM is too slow.
 */
export async function contextualizeResearchUpdate(
  workingDir: string,
  sessionId: string,
  task: string,
  batchEvents: string[],
  researchLog: string[],
  chatHistory?: ConversationTurn[],
  sessionBaseDir?: string,
): Promise<string | null> {
  initProvider()
  if (provider === 'none') return null

  const wsDir = sessionBaseDir || workingDir
  try {
    const specContent = readSessionSpec(wsDir, sessionId)
    const specTruncated = specContent ? specContent.substring(0, 1500) : ''

    // Read last 5 tool results for what was just found
    const recentResults = getRecentToolResults(sessionId, workingDir, 5)
    const resultsSummary = recentResults.map(tr => {
      const inputPreview = JSON.stringify(tr.toolInput).substring(0, 100)
      const resultPreview = tr.resultContent.substring(0, 200)
      return `[${tr.toolName}: ${inputPreview}] ${resultPreview}`
    }).join('\n')

    const userMessage = `Research question: "${task}"

Recent events: ${batchEvents.slice(-10).join('. ')}

Research log (${researchLog.length} total steps): ${researchLog.slice(-15).join('. ')}

Recent findings:
${resultsSummary}

${specTruncated ? `Spec context:\n${specTruncated}` : ''}`

    const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000))

    let responsePromise: Promise<string | null>

    if (anthropicClient) {
      responsePromise = anthropicClient.messages.create({
        model: ANTHROPIC_FAST_MODEL,
        max_tokens: 200,
        system: CONTEXTUALIZE_UPDATE_SYSTEM,
        messages: [{ role: 'user', content: userMessage }]
      }).then(r => r.content[0].type === 'text' ? r.content[0].text : null)
    } else if (geminiClient) {
      responsePromise = geminiClient.models.generateContent({
        model: GEMINI_FAST_MODEL,
        contents: userMessage,
        config: { systemInstruction: CONTEXTUALIZE_UPDATE_SYSTEM }
      }).then(r => r.text || null)
    } else {
      return null
    }

    const result = await Promise.race([responsePromise, timeoutPromise])
    if (!result || result.trim() === 'NOTHING') return null
    return result.trim()
  } catch (err) {
    console.error('❌ contextualizeResearchUpdate failed:', err)
    return null
  }
}

// ============================================================
// generateProactivePrompt — Fast brain generates conversation during research silence
// ============================================================

/**
 * Generate a proactive conversational prompt to keep the user engaged during research.
 * Called periodically (every 15s) during active research.
 *
 * Can ask open questions, discuss implications of findings, or give progress with depth.
 * Returns null/NOTHING if nothing interesting to say.
 * 3-second timeout.
 */
export async function generateProactivePrompt(
  workingDir: string,
  sessionId: string,
  task: string,
  researchLog: string[],
  previousPrompts: string[],
  sessionBaseDir?: string,
): Promise<string | null> {
  initProvider()
  if (provider === 'none') return null

  const wsDir = sessionBaseDir || workingDir
  try {
    const specContent = readSessionSpec(wsDir, sessionId)
    const specTruncated = specContent ? specContent.substring(0, 2000) : ''

    // Read recent discoveries from JSONL
    const recentResults = getRecentToolResults(sessionId, workingDir, 8)
    const resultsSummary = recentResults.map(tr => {
      const inputPreview = JSON.stringify(tr.toolInput).substring(0, 100)
      const resultPreview = tr.resultContent.substring(0, 300)
      return `[${tr.toolName}: ${inputPreview}] ${resultPreview}`
    }).join('\n')

    // Read recent agent reasoning
    const recentText = readSessionHistory(sessionId, workingDir, {
      lastN: 5,
      types: ['assistant']
    })
    const reasoningSummary = recentText
      .filter(m => m.text && m.text.length > 20)
      .map(m => m.text!.substring(0, 300))
      .join('\n')

    const userMessage = `Research question: "${task}"

Research progress (${researchLog.length} steps so far): ${researchLog.slice(-10).join('. ')}

Recent findings:
${resultsSummary}

Agent reasoning:
${reasoningSummary}

${specTruncated ? `Session spec:\n${specTruncated}` : ''}

Previous things already said (DO NOT repeat):
${previousPrompts.length > 0 ? previousPrompts.join('\n') : '(none yet)'}`

    const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000))

    let responsePromise: Promise<string | null>

    if (anthropicClient) {
      responsePromise = anthropicClient.messages.create({
        model: ANTHROPIC_FAST_MODEL,
        max_tokens: 200,
        system: PROACTIVE_PROMPT_SYSTEM,
        messages: [{ role: 'user', content: userMessage }]
      }).then(r => r.content[0].type === 'text' ? r.content[0].text : null)
    } else if (geminiClient) {
      responsePromise = geminiClient.models.generateContent({
        model: GEMINI_FAST_MODEL,
        contents: userMessage,
        config: { systemInstruction: PROACTIVE_PROMPT_SYSTEM }
      }).then(r => r.text || null)
    } else {
      return null
    }

    const result = await Promise.race([responsePromise, timeoutPromise])
    if (!result || result.trim() === 'NOTHING') return null
    return result.trim()
  } catch (err) {
    console.error('❌ generateProactivePrompt failed:', err)
    return null
  }
}

// ============================================================
// generateVisualDocument — Fast brain generates structured visual documents
// ============================================================

/**
 * Generate a structured visual document (comparison table, Mermaid diagram,
 * analysis, or summary) from research findings.
 *
 * Reads spec.md, JSONL results, and library for context.
 * Writes the result to library/ and returns the filename + content.
 */
export async function generateVisualDocument(
  workingDir: string,
  sessionId: string,
  request: string,
  documentType: 'comparison' | 'diagram' | 'analysis' | 'summary',
  sessionBaseDir?: string,
): Promise<{ fileName: string; content: string } | null> {
  initProvider()
  if (provider === 'none') return null

  const wsDir = sessionBaseDir || workingDir
  try {
    const workspace = getSessionWorkspace(wsDir, sessionId)
    const specContent = readSessionSpec(wsDir, sessionId) || ''
    const libraryFiles = listLibraryFiles(wsDir, sessionId)

    // Read library contents for context
    const libraryDir = `${workspace}/library`
    const libraryContents: string[] = []
    for (const file of libraryFiles.slice(0, 5)) {
      const filePath = `${libraryDir}/${file}`
      if (existsSync(filePath)) {
        try {
          const content = readFileSync(filePath, 'utf-8')
          libraryContents.push(`--- ${file} ---\n${content.substring(0, 3000)}`)
        } catch { /* skip */ }
      }
    }

    // Read recent JSONL results for raw data
    const toolResults = getRecentToolResults(sessionId, workingDir, 20)
    const toolResultsSummary = toolResults.map(tr => {
      const inputPreview = JSON.stringify(tr.toolInput).substring(0, 150)
      return `[${tr.toolName}: ${inputPreview}]\n${tr.resultContent.substring(0, 1000)}`
    }).join('\n\n---\n\n')

    const userMessage = `Document request: "${request}"
Document type: ${documentType}

Session spec:
${specContent}

${libraryContents.length > 0 ? `Library files:\n${libraryContents.join('\n\n')}` : ''}

Recent research data:
${toolResultsSummary}

Return JSON: {"fileName": "descriptive-name.md", "content": "full markdown content"}`

    let responseText: string | null = null

    if (anthropicClient) {
      const response = await anthropicClient.messages.create({
        model: ANTHROPIC_FAST_MODEL,
        max_tokens: 16000,
        system: VISUAL_DOCUMENT_SYSTEM,
        messages: [{ role: 'user', content: userMessage }]
      })
      responseText = response.content[0].type === 'text' ? response.content[0].text : null
    } else if (geminiClient) {
      const response = await geminiClient.models.generateContent({
        model: GEMINI_FAST_MODEL,
        contents: userMessage,
        config: { systemInstruction: VISUAL_DOCUMENT_SYSTEM }
      })
      responseText = response.text || null
    }

    if (!responseText) return null

    // Parse JSON response
    const cleaned = responseText.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim()
    let parsed: { fileName?: string; content?: string }
    try {
      parsed = JSON.parse(cleaned)
    } catch {
      // Try to extract from malformed response
      const fnMatch = cleaned.match(/"fileName"\s*:\s*"([^"]+)"/)
      const ctMatch = cleaned.match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"/s)
      if (fnMatch && ctMatch) {
        try {
          parsed = { fileName: fnMatch[1], content: JSON.parse(`"${ctMatch[1]}"`) }
        } catch {
          console.error('⚠️ generateVisualDocument: failed to parse response')
          return null
        }
      } else {
        return null
      }
    }

    if (!parsed.fileName || !parsed.content) return null

    // Write to library
    const safeName = parsed.fileName.replace(/[^a-zA-Z0-9._-]/g, '-')
    const libraryPath = `${workspace}/library`
    mkdirSync(libraryPath, { recursive: true })
    const filePath = `${libraryPath}/${safeName}`
    writeFileSync(filePath, parsed.content, 'utf-8')
    console.log(`📊 generateVisualDocument: wrote ${safeName} (${parsed.content.length} chars)`)

    return { fileName: safeName, content: parsed.content }
  } catch (err) {
    console.error('❌ generateVisualDocument failed:', err)
    return null
  }
}

// ============================================================
// processResearchCompletion — Generate teleprompter script from research results
// ============================================================

/**
 * Generate a complete teleprompter script from research results.
 * Replaces augmentResearchResult + extractPriorityContent.
 * Reads full JSONL and produces a spoken monologue.
 */
export async function processResearchCompletion(
  workingDir: string,
  sessionId: string,
  task: string,
  agentResult: string,
  chatHistory?: ConversationTurn[],
  sendToChat?: (text: string) => void,
  sessionBaseDir?: string,
): Promise<string> {
  initProvider()
  if (provider === 'none') return agentResult.substring(0, 500)

  const wsDir = sessionBaseDir || workingDir
  try {
    // Read spec for context
    const specContent = readSessionSpec(wsDir, sessionId) || ''

    // Read FULL JSONL data — not truncated. The user waited for this research;
    // give the completion generator the complete picture.
    const toolResults = getRecentToolResults(sessionId, workingDir, 30)
    const toolSummary = toolResults.map(tr => {
      const inputPreview = JSON.stringify(tr.toolInput).substring(0, 200)
      return `[${tr.toolName}: ${inputPreview}]\n${tr.resultContent}`
    }).join('\n\n---\n\n')

    // Also read agent reasoning for synthesis context
    const agentTexts = readSessionHistory(sessionId, workingDir, {
      lastN: 20,
      types: ['assistant']
    }).filter(m => m.text && m.text.length > 30)
      .map(m => m.text!)
      .join('\n\n')

    // Read sub-agent findings if any
    const subagents = getSubagentTranscripts(sessionId, workingDir)
    const subagentSummary = subagents.length > 0
      ? subagents.map(sa => {
          const texts = sa.messages.filter(m => m.text && m.text.length > 30).map(m => m.text!)
          return `[Sub-agent ${sa.taskId}]\n${texts.join('\n')}`
        }).join('\n\n')
      : ''

    const historyStr = chatHistory
      ? chatHistory.slice(-10).map(t => `${t.role}: ${t.text}`).join('\n')
      : ''

    const userMessage = `Research task: "${task}"

Agent's headline findings:
${agentResult}

Full tool outputs (${toolResults.length} results):
${toolSummary}

${agentTexts ? `Agent reasoning and analysis:\n${agentTexts.substring(0, 8000)}` : ''}

${subagentSummary ? `Sub-agent findings:\n${subagentSummary.substring(0, 4000)}` : ''}

${specContent ? `Session spec (for context):\n${specContent.substring(0, 3000)}` : ''}

${historyStr ? `Recent conversation (match this vocabulary):\n${historyStr}` : ''}

Write the spoken monologue now. The user waited for this research — be comprehensive.${sendToChat ? ' If you have structured data (lists, URLs, code, steps), include a CHAT_CONTENT section at the end after a line "---CHAT---" with markdown content to send to the chat panel.' : ''}`

    let script: string | null = null

    if (anthropicClient) {
      const response = await anthropicClient.messages.create({
        model: ANTHROPIC_FAST_MODEL,
        max_tokens: 4000,
        system: RESEARCH_COMPLETION_SYSTEM,
        messages: [{ role: 'user', content: userMessage }]
      })
      script = response.content[0].type === 'text' ? response.content[0].text : null
    } else if (geminiClient) {
      const response = await geminiClient.models.generateContent({
        model: GEMINI_FAST_MODEL,
        contents: userMessage,
        config: { systemInstruction: RESEARCH_COMPLETION_SYSTEM }
      })
      script = response.text || null
    }

    if (!script) return agentResult.substring(0, 500)

    // Check for chat content section
    if (sendToChat && script.includes('---CHAT---')) {
      const parts = script.split('---CHAT---')
      const spokenPart = parts[0].trim()
      const chatPart = parts[1]?.trim()
      if (chatPart) {
        console.log(`💬 processResearchCompletion: sending ${chatPart.length} chars to chat`)
        sendToChat(chatPart)
      }
      console.log(`🎙️ processResearchCompletion: generated ${spokenPart.length} char script + ${chatPart?.length || 0} char chat content`)
      return spokenPart
    }

    console.log(`🎙️ processResearchCompletion: generated ${script.length} char script`)
    return script
  } catch (err) {
    console.error('❌ processResearchCompletion failed:', err)
    // Fallback: return truncated agent result as-is
    return agentResult.substring(0, 500)
  }
}

// ============================================================
// handleResearchBatch — Decide whether research events are worth speaking
// ============================================================

/**
 * Process a batch of research events and decide whether to speak.
 * Replaces contextualizeResearchUpdate — but usually returns null (silent).
 * Only speaks when something genuinely critical is found.
 */
export async function handleResearchBatch(
  workingDir: string,
  sessionId: string,
  task: string,
  batchEvents: string[],
  researchLog: string[],
  chatHistory?: ConversationTurn[],
  sessionBaseDir?: string,
): Promise<string | null> {
  // Usually: stay silent. The frontend spinner handles visual feedback.
  // Only speak if the batch contains something genuinely interesting.

  // Quick heuristic: if fewer than 5 research steps, too early to say anything useful
  if (researchLog.length < 5) return null

  // Check if any event mentions something critical (error, user-impacting finding)
  const hasCritical = batchEvents.some(e =>
    e.toLowerCase().includes('error') ||
    e.toLowerCase().includes('warning') ||
    e.toLowerCase().includes('breaking') ||
    e.toLowerCase().includes('deprecated')
  )

  if (!hasCritical) return null

  // Something interesting — generate a brief spoken update via contextualizeResearchUpdate
  return contextualizeResearchUpdate(workingDir, sessionId, task, batchEvents, researchLog, chatHistory, sessionBaseDir)
}

// ============================================================
// prepareBriefingScript — Session resume/switch spoken briefing
// ============================================================

/**
 * Generate a brief spoken script for session resume or switch.
 * Replaces buildContextBriefing + getSpecForVoiceModel.
 */
export async function prepareBriefingScript(
  workingDir: string,
  sessionId: string,
  conversationHistory?: { role: string; text: string }[],
  type: 'resume' | 'switch' | 'default' = 'default'
): Promise<string> {
  initProvider()

  // Read spec for context
  const specContent = readSessionSpec(workingDir, sessionId)

  if (!specContent && (!conversationHistory || conversationHistory.length === 0)) {
    return type === 'switch'
      ? 'Switched sessions. What would you like to work on?'
      : 'Welcome back. What would you like to work on?'
  }

  // Extract goal and last topic from spec
  const goalMatch = specContent?.match(/## Goal\s*\n([\s\S]*?)(?=\n##|$)/)
  const goal = goalMatch ? goalMatch[1].trim().substring(0, 200) : ''

  const prefix = type === 'switch' ? 'Switched over.' : 'Welcome back.'

  // If we have a goal, generate a brief spoken briefing
  if (goal) {
    const lastExchanges = conversationHistory
      ? conversationHistory.slice(-3).map(e => `${e.role}: ${e.text.substring(0, 100)}`).join('. ')
      : ''

    if (lastExchanges) {
      return `${prefix} We were working on ${goal}. Last time we discussed ${lastExchanges.substring(0, 150)}. Where would you like to pick up?`
    }
    return `${prefix} We were working on ${goal}. Where would you like to pick up?`
  }

  return type === 'switch'
    ? 'Switched sessions. What would you like to work on?'
    : 'Session resumed. What would you like to work on?'
}

// ============================================================
// prepareRecoveryScript — Gemini crash recovery spoken script
// ============================================================

/**
 * Generate a spoken script after Gemini auto-recovery.
 * Replaces inline recovery logic in index.ts.
 */
export async function prepareRecoveryScript(
  conversationHistory?: { role: string; text: string }[]
): Promise<string> {
  if (conversationHistory && conversationHistory.length > 0) {
    const lastTopic = conversationHistory[conversationHistory.length - 1]
    return `Voice session was briefly interrupted but I'm back. We were talking about ${lastTopic.text.substring(0, 100)}. Where were we?`
  }
  return 'Voice session was briefly interrupted but I\'m back. What were we working on?'
}
