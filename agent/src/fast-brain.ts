/**
 * Fast Brain Agent — Middle-tier intelligence for the Voice AI System
 *
 * A fast intermediary between the realtime voice model and the Claude SDK agent.
 * Uses direct API calls for ~2 second responses.
 *
 * Capabilities:
 * - Read/write session files (spec.md + library/)
 * - Web search for quick factual lookups
 * - Record user decisions and preferences into spec.md
 * - Post-research: synthesize findings into spec.md
 * - Escalate to ask_agent when deeper research is needed
 *
 * Key constraint: The fast brain NEVER calls ask_agent. The realtime model is always the router.
 *
 * Auth chain (tried in order):
 * 1. ANTHROPIC_API_KEY env var → Anthropic SDK (Haiku)
 * 2. ANTHROPIC_AUTH_TOKEN env var → Anthropic SDK (Haiku)
 * 3. GOOGLE_API_KEY env var → Gemini Flash fallback
 *
 * Note: Claude Code OAuth (macOS Keychain) was tested but Anthropic's Messages API
 * rejects OAuth tokens with 401 "OAuth authentication is currently not supported."
 */

import Anthropic from '@anthropic-ai/sdk'
import { GoogleGenAI } from '@google/genai'
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs'
import { dirname, basename } from 'path'
import { getSessionWorkspace, readSessionSpec, listLibraryFiles } from './config.js'
import { FAST_BRAIN_SYSTEM_PROMPT, CHUNK_PROCESS_SYSTEM, REFINEMENT_PROCESS_SYSTEM } from './prompts.js'
import { getRecentToolResults, readSessionHistory, getSubagentTranscripts } from './session-access.js'

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

type FastBrainProvider = 'anthropic' | 'gemini' | 'none'

let provider: FastBrainProvider = 'none'
let anthropicClient: Anthropic | null = null
let geminiClient: GoogleGenAI | null = null
let initialized = false

// Model IDs — configurable per provider
const ANTHROPIC_FAST_MODEL = 'claude-haiku-4-5-20251001'
const GEMINI_FAST_MODEL = 'gemini-2.0-flash'

function initProvider(): void {
  if (initialized) return
  initialized = true

  // 1. ANTHROPIC_API_KEY
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (apiKey) {
    anthropicClient = new Anthropic({ apiKey })
    provider = 'anthropic'
    console.log('🧠 Fast brain: using Anthropic API (ANTHROPIC_API_KEY)')
    return
  }

  // 2. ANTHROPIC_AUTH_TOKEN (if user sets it explicitly)
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN
  if (authToken) {
    anthropicClient = new Anthropic({ authToken })
    provider = 'anthropic'
    console.log('🧠 Fast brain: using Anthropic API (ANTHROPIC_AUTH_TOKEN)')
    return
  }

  // NOTE: Claude Code OAuth (macOS Keychain) was tested but Anthropic's Messages API
  // returns 401 "OAuth authentication is currently not supported." — cannot reuse it.

  // 3. Gemini Flash fallback (uses GOOGLE_API_KEY already in .env)
  const googleKey = process.env.GOOGLE_API_KEY
  if (googleKey) {
    geminiClient = new GoogleGenAI({ apiKey: googleKey })
    provider = 'gemini'
    console.log(`🧠 Fast brain: using Gemini Flash fallback (${GEMINI_FAST_MODEL})`)
    return
  }

  // No provider available
  provider = 'none'
  console.error('⚠️ Fast brain: no API key available — fast brain disabled')
  console.error('   Set ANTHROPIC_API_KEY or GOOGLE_API_KEY in agent/.env')
}

// ============================================================
// Tool execution (shared across providers)
// ============================================================

function executeTool(
  toolName: string,
  toolInput: Record<string, any>,
  workspace: string,
  sessionId?: string,
  workingDir?: string
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
        const lastN = (toolInput.lastN as number) || 5
        const results = getRecentToolResults(sessionId, workingDir, lastN)
        if (results.length === 0) return 'No tool results found in agent JSONL.'
        return results.map(tr => {
          const inputPreview = JSON.stringify(tr.toolInput).substring(0, 200)
          return `[${tr.toolName}: ${inputPreview}]\n${tr.resultContent}`
        }).join('\n\n---\n\n')
      }

      case 'read_agent_text': {
        if (!sessionId || !workingDir) return 'Error: no active research session'
        const lastN = (toolInput.lastN as number) || 10
        const messages = readSessionHistory(sessionId, workingDir, {
          lastN,
          types: ['assistant']
        })
        const texts = messages.filter(m => m.text && m.text.length > 20)
        if (texts.length === 0) return 'No agent reasoning text found in JSONL.'
        return texts.map(m => m.text).join('\n\n---\n\n')
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
      description: 'Read recent tool results from the research agent JSONL. Returns FULL untruncated tool outputs (file contents, command outputs, web search results).',
      input_schema: {
        type: 'object' as const,
        properties: {
          lastN: { type: 'number', description: 'Number of recent results to return (default: 5)' }
        }
      }
    },
    {
      name: 'read_agent_text',
      description: 'Read recent agent reasoning and analysis text from JSONL. Returns the agent\'s thinking and conclusions.',
      input_schema: {
        type: 'object' as const,
        properties: {
          lastN: { type: 'number', description: 'Number of recent text messages to return (default: 10)' }
        }
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
          description: 'Read recent tool results from the research agent JSONL. Returns FULL untruncated tool outputs (file contents, command outputs, web search results).',
          parameters: {
            type: 'object',
            properties: {
              lastN: { type: 'number', description: 'Number of recent results to return (default: 5)' }
            }
          }
        },
        {
          name: 'read_agent_text',
          description: 'Read recent agent reasoning and analysis text from JSONL. Returns the agent\'s thinking and conclusions.',
          parameters: {
            type: 'object',
            properties: {
              lastN: { type: 'number', description: 'Number of recent text messages to return (default: 10)' }
            }
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
// Anthropic Q&A implementation
// ============================================================

async function askViaAnthropic(
  question: string,
  workspace: string,
  researchContext?: string,
  sessionId?: string,
  workingDir?: string
): Promise<string> {
  const client = anthropicClient!
  const tools = buildAnthropicTools()

  const userContent = researchContext
    ? `${question}\n\n[LIVE RESEARCH CONTEXT — the research agent is currently working]\n${researchContext}`
    : question

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: 'user', content: userContent }
  ]

  const allTools: Anthropic.Messages.Tool[] | any[] = [...tools, ANTHROPIC_WEB_SEARCH]

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
      return textBlock?.text || 'No answer found.'
    }

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use'
    )

    if (toolUseBlocks.length === 0 && response.stop_reason !== 'tool_use') {
      const textBlock = response.content.find(
        (b): b is Anthropic.Messages.TextBlock => b.type === 'text'
      )
      return textBlock?.text || 'No answer found.'
    }

    messages.push({ role: 'assistant', content: response.content as any })

    if (toolUseBlocks.length > 0) {
      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = toolUseBlocks.map(toolUse => ({
        type: 'tool_result' as const,
        tool_use_id: toolUse.id,
        content: executeTool(toolUse.name, toolUse.input as Record<string, any>, workspace, sessionId, workingDir),
      }))
      messages.push({ role: 'user', content: toolResults })
    }
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
  workingDir?: string
): Promise<string> {
  const ai = geminiClient!
  const tools = buildGeminiTools()

  const userContent = researchContext
    ? `${question}\n\n[LIVE RESEARCH CONTEXT — the research agent is currently working]\n${researchContext}`
    : question

  // Gemini uses a different content format
  const contents: any[] = [
    { role: 'user', parts: [{ text: userContent }] }
  ]

  for (let i = 0; i < 10; i++) {
    const response = await ai.models.generateContent({
      model: GEMINI_FAST_MODEL,
      contents,
      config: {
        systemInstruction: FAST_BRAIN_SYSTEM_PROMPT,
        tools,
      }
    })

    const functionCalls = response.functionCalls
    if (!functionCalls || functionCalls.length === 0) {
      return response.text || 'No answer found.'
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
        result = executeTool(call.name, call.args || {}, workspace, sessionId, workingDir)
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
  researchContext?: string
): Promise<string> {
  initProvider()

  if (provider === 'none') {
    return 'NEEDS_DEEPER_RESEARCH: Fast brain unavailable (no API key). Try ask_agent instead.'
  }

  const workspace = getSessionWorkspace(workingDir, sessionId)

  if (provider === 'anthropic') {
    return askViaAnthropic(question, workspace, researchContext, sessionId, workingDir)
  } else {
    return askViaGemini(question, workspace, researchContext, sessionId, workingDir)
  }
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
  isRefinement?: boolean
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
  try {
    const workspace = getSessionWorkspace(workingDir, sessionId)
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
      const existingFiles = listLibraryFiles(workingDir, sessionId)
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

    if (provider === 'anthropic') {
      const response = await anthropicClient!.messages.create({
        model: ANTHROPIC_FAST_MODEL,
        max_tokens: isRefinement ? 20000 : 10000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }]
      })
      responseText = response.content[0].type === 'text' ? response.content[0].text : null
    } else {
      const response = await geminiClient!.models.generateContent({
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
  researchLog: string[]
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
    return processResearchChunk(workingDir, sessionId, task, contentChunks, true)
  } catch (err) {
    console.error('❌ updateSpecFromJSONL failed:', err)
    return null
  }
}
