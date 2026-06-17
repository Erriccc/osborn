/**
 * pipeline-fastbrain.ts — Pipeline Fast Brain (Agent with AFC)
 *
 * Uses Gemini Flash as an AGENT with Automatic Function Calling (AFC).
 * One generateContent() call handles everything:
 *   - Gemini decides IF it needs to search (skips for greetings/follow-ups)
 *   - Gemini decides WHAT to search (smart phrase selection)
 *   - Gemini can multi-step: search → not enough → refine → search again
 *   - AFC handles the tool loop internally (up to 3 rounds)
 *
 * Tools:
 *   search_session — ripgrep the summary index + read full content via byte offsets
 *
 * No separate phrase extraction call. No manual tool loop. One API invocation.
 */

import { GoogleGenAI, type FunctionCall, type Part, type CallableTool, type Tool } from '@google/genai'

// ============================================================
// TYPES
// ============================================================

export interface PipelineFastBrainResult {
  script: string
  type: 'answer' | 'research_needed' | 'acknowledgment' | 'error'
  toolsUsed: string[]
}

export interface PipelineFastBrainOptions {
  chatHistory?: { role: string; content: string }[]
  researchContext?: string
  sessionBaseDir?: string
  agentControl?: AgentControlCallbacks
}

// ============================================================
// CONSTANTS
// ============================================================

const GEMINI_MODEL = 'gemini-2.5-flash'  // 0.9.67: was gemini-2.0-flash — 404 deprecated by Google
const TIMEOUT_MS = 20_000  // AFC needs time for tool calls + processing + synthesis
const MAX_AFC_CALLS = 4

// ============================================================
// PERSISTENT STATE
// ============================================================

let persistentContents: any[] = []
let persistentSessionId: string | null = null

/** Clear the pipeline fast brain session (call on disconnect/reconnect) */
export function clearPipelineFastBrainSession() {
  persistentContents = []
  persistentSessionId = null
}

/** No-op — kept for backward compatibility with index.ts import */
export async function prewarmBM25Index(_sessionId: string, _workingDir: string) {}

// ============================================================
// SEARCH TOOL (CallableTool for AFC)
// ============================================================

/**
 * Create a CallableTool that wraps ripgrep search of the summary index
 * + byte-offset full content reads from raw JSONL.
 */
export interface AgentControlCallbacks {
  interrupt: () => Promise<boolean>
  abort: () => void
  hasActiveAgent: () => boolean
  getRecentUserMessages: (count: number) => string[]  // raw user STT transcripts only
  sendPrompt: (prompt: string) => void                 // send new message to Claude via chat()
}

function createSearchTool(
  sessionId: string,
  workingDir: string,
  sessionBaseDir: string,
  agentControl?: AgentControlCallbacks,
): { tool: CallableTool; searchCount: number; getSearchCount: () => number } {
  let searchCount = 0

  const callableTool: CallableTool = {
    async tool(): Promise<Tool> {
      return {
        functionDeclarations: [
          {
            name: 'search_session',
            description: 'Search session history by keywords. Returns summaries + full untruncated content. Use for questions about what was discussed, decided, researched, or built.',
            parameters: {
              type: 'OBJECT' as any,
              properties: {
                phrases: {
                  type: 'ARRAY' as any,
                  items: { type: 'STRING' as any },
                  description: '2-3 word search phrases, lowercase. Include one phrase per topic.',
                },
              },
              required: ['phrases'],
            },
          },
          {
            name: 'get_recent',
            description: 'Get the most recent session activity with full content. Use for: "where did we leave off?", "what just happened?", "what are we working on?", or any question about recent/current work.',
            parameters: {
              type: 'OBJECT' as any,
              properties: {
                count: {
                  type: 'NUMBER' as any,
                  description: 'Number of recent entries. Default 20, max 50.',
                },
              },
            },
          },
          ...(agentControl ? [{
            name: 'emergency_stop',
            description: [
              'Kill and restart the main agent with new instructions.',
              'Call when the user clearly wants the agent to STOP what a  DESTRUCTIVE or ALTERING action:',
              '  - Destructive actions: write, edit, delete, install, deploy, push, modify files/data',
              '  - Wrong direction: agent is doing something the user didn\'t ask for or explicitly rejects',
              'User signals: "stop", "don\'t", "cancel", "wait no", "not that", "no no no", "I said stop".',
              'NEVER call for: research, reading, exploring, searching, fetching, or casual conversation, questions about what the agent is doing, or research the user initiated.',
              'When in doubt about whether to stop: check get_recent first to see what the agent is actually doing. ',
              'Priority: how destructive/unrecoverable the action is > how strongly the user signals.'
            ].join(' '),
            parameters: {
              type: 'OBJECT' as any,
              properties: {
                reason: {
                  type: 'STRING' as any,
                  description: 'What destructive action is being stopped and what the user wants instead. Use their exact words.',
                },
              },
              required: ['reason'],
            },
          }] : []),
        ],
      }
    },

    async callTool(functionCalls: FunctionCall[]): Promise<Part[]> {
      const results: Part[] = []

      for (const call of functionCalls) {
        if (call.name === 'search_session') {
          searchCount++
          const phrases = (call.args?.phrases as string[]) || []
          if (phrases.length === 0) {
            results.push({ functionResponse: { name: 'search_session', response: { result: 'No phrases provided' } } } as any)
            continue
          }
          console.log(`🧠⚡ [pipeline-fb] AFC search: [${phrases.join(', ')}]`)
          const searchResult = await executeSearch(phrases, sessionId, workingDir)
          results.push({ functionResponse: { name: 'search_session', response: { result: searchResult } } } as any)

        } else if (call.name === 'get_recent') {
          searchCount++
          const count = Math.min(Math.max((call.args?.count as number) || 20, 5), 50)
          console.log(`🧠⚡ [pipeline-fb] AFC get_recent: ${count}`)
          const recent = await getRecentEntries(sessionId, workingDir, undefined, count)
          results.push({ functionResponse: { name: 'get_recent', response: { result: recent } } } as any)

        } else if (call.name === 'emergency_stop' && agentControl) {
          const reason = (call.args?.reason as string) || 'user requested stop'
          console.log(`🧠⚡ [pipeline-fb] AFC emergency_stop: ${reason}`)

          // Gather context
          const recentUserMessages = agentControl.getRecentUserMessages(10)
          const recentActivity = await getRecentEntries(sessionId, workingDir, undefined, 10)

          // Kill the destructive process and restart with new instructions
          agentControl.abort()

          const restartPrompt = [
            `[EMERGENCY STOP] The user stopped your previous action.`,
            ``,
            `Reason: ${reason}`,
            ``,
            `Recent user messages:`,
            ...recentUserMessages.map((m, i) => `  ${i + 1}. ${m}`),
            ``,
            `What was happening before the stop:`,
            recentActivity.substring(0, 2000),
            ``,
            `RESPOND IMMEDIATELY with speech:`,
            `1. Acknowledge what you were doing and that you've stopped`,
            `2. If the user gave a new direction, confirm what you'll do instead`,
            `3. If unclear, ask what they'd like to do next`,
            `Do NOT silently do tool calls — speak first.`,
          ].join('\n')

          agentControl.sendPrompt(restartPrompt)

          results.push({ functionResponse: { name: 'emergency_stop', response: { result: `Agent stopped and restarted. Reason: ${reason}` } } } as any)
        }
      }

      return results
    },
  }

  return { tool: callableTool, searchCount, getSearchCount: () => searchCount }
}

/**
 * Execute a search: ripgrep the summary index, then read full content via byte offsets.
 */
async function executeSearch(
  phrases: string[],
  sessionId: string,
  workingDir: string,
  _sessionBaseDir?: string,  // deprecated — workingDir used for index path
): Promise<string> {
  const { ripgrepSearch } = await import('./jsonl-search.js')
  const { getIndexPath, readFullContent } = await import('./summary-index.js')

  const indexPath = getIndexPath(sessionId, workingDir)

  if (indexPath) {
    // ── Fast path: search summary index + targeted byte-offset reads ──
    const sections: string[] = []
    const matchedRefs: { lineNum: number; byteOffset: number; source: string }[] = []
    const seenLines = new Set<string>()
    let totalMatches = 0

    for (const phrase of phrases.slice(0, 6)) {
      const results = ripgrepSearch(indexPath, phrase, {
        maxResults: 8,
        fromEnd: true,
        contextLines: 0,
      })
      const newResults = results.filter((r: any) => {
        const key = `${r.lineNumber}`
        if (seenLines.has(key)) return false
        seenLines.add(key)
        return true
      })
      if (newResults.length > 0) {
        sections.push(`["${phrase}" — ${newResults.length} matches]`)
        for (const r of newResults) {
          const parts = (r.content as string).split('|')
          if (parts.length >= 6) {
            matchedRefs.push({
              lineNum: parseInt(parts[0], 10),
              byteOffset: parseInt(parts[1], 10),
              source: parts[3],
            })
            sections.push(r.content)
          }
        }
        totalMatches += newResults.length
      }
    }

    // Read full content for matched entries (byte-offset reads, ~0.5ms each)
    if (matchedRefs.length > 0) {
      try {
        const fullTexts = readFullContent(matchedRefs, sessionId, workingDir, undefined, 2000)
        if (fullTexts.length > 0) {
          sections.push('', `[FULL CONTENT — ${fullTexts.length} entries]`, ...fullTexts)
        }
      } catch {}
    }

    if (sections.length === 0) {
      return `No matches for: ${phrases.join(', ')}`
    }
    return sections.join('\n')
  }

  // ── Fallback: raw JSONL search ──
  const { getSessionPaths } = await import('./session-access.js')
  const paths = getSessionPaths(sessionId, workingDir)
  if (!paths.exists) return 'No session files found'

  const sections: string[] = []
  for (const phrase of phrases.slice(0, 4)) {
    const results = ripgrepSearch(paths.conversation, phrase, {
      maxResults: 5,
      fromEnd: true,
      contextLines: 0,
    })
    if (results.length > 0) {
      sections.push(`["${phrase}" — ${results.length} matches]`)
      sections.push(...results.map((r: any) => `L${r.lineNumber}: ${r.content}`))
    }
  }

  return sections.length > 0 ? sections.join('\n') : `No matches for: ${phrases.join(', ')}`
}

/**
 * Get the most recent N entries from the index + their full content.
 * Reads last N lines of search-index.txt, then byte-offset reads for full text.
 */
async function getRecentEntries(
  sessionId: string,
  workingDir: string,
  _sessionBaseDir: string | undefined,  // deprecated — workingDir used for index path
  count: number,
): Promise<string> {
  const { readFileSync } = await import('fs')
  const { getIndexPath, readFullContent } = await import('./summary-index.js')

  const indexPath = getIndexPath(sessionId, workingDir)
  if (!indexPath) return 'Index not built yet.'

  // Read last N lines
  const content = readFileSync(indexPath, 'utf-8')
  const allLines = content.split('\n').filter(Boolean)
  const recentLines = allLines.slice(-count)

  // Parse refs for full content reads
  const refs: { lineNum: number; byteOffset: number; source: string }[] = []
  const summaries: string[] = [`[RECENT — last ${recentLines.length} entries]`]

  for (const line of recentLines) {
    summaries.push(line)
    const parts = line.split('|')
    if (parts.length >= 6) {
      refs.push({
        lineNum: parseInt(parts[0], 10),
        byteOffset: parseInt(parts[1], 10),
        source: parts[3],
      })
    }
  }

  // Read full content for each entry
  if (refs.length > 0) {
    try {
      const fullTexts = readFullContent(refs, sessionId, workingDir, undefined, 1500)
      if (fullTexts.length > 0) {
        summaries.push('', `[FULL CONTENT — ${fullTexts.length} entries]`, ...fullTexts)
      }
    } catch {}
  }

  return summaries.join('\n')
}

// ============================================================
// SYSTEM PROMPT
// ============================================================

function buildSystemPrompt(
  chatHistory?: { role: string; content: string }[],
  researchContext?: string,
): string {
  const parts: string[] = []

  parts.push(
    // CONTEXT
    `You are a fast memory recall agent for a voice AI assistant called Osborn.`,
    `You search the user's conversation history — their questions, the assistant's answers,`,
    `tool calls, research findings, and decisions — stored as indexed session files.`,
    `Tools: search_session (keyword search) and get_recent (latest activity).`,
    ``,
    // OBJECTIVE
    `== OBJECTIVE ==`,
    `Answer from session history. Search first for any recall question.`,
    `Greetings/thanks/confirmations: respond directly, no search.`,
    `Tasks needing live code analysis or new research: respond with [RESEARCH_NEEDED]`,
    ``,
    // STYLE
    `== STYLE ==`,
    `1-3 sentences. Grounded in results. Never fabricate.`,
    `If not found after thorough searching: "I didn't find that in the session history."`,
    ``,
    // AUDIENCE
    `== AUDIENCE ==`,
    `A user having a conversation and asking questions based on past context and research/task intentions via voice. Questions may be casual, rambling,`,
    `or use vague references ("that thing", "the error"). Interpret intent, not just words.`,
    ``,
    // RESULTS FORMAT
    `== RESULTS FORMAT ==`,
    `Each line: lineNum|byteOffset|timestamp|source|msgType|summary`,
    `  source: "main" = conversation, "agent-XXXX" = sub-agent research`,
    `Full content sections have complete untruncated text.`,
    ``,
    // SEARCH STRATEGY
    `== HOW TO SEARCH ==`,
    `You are searching a CONVERSATION, not a database. Think about what words people`,
    `ACTUALLY USED when this topic came up — not how the user is phrasing it now.`,
    ``,
    `PHRASES: 1-4 words each, multiple phrases per call.`,
    `  Short precise terms beat long phrases. "error" finds more than "error we got".`,
    `  Single words work great: "BM25", "latency", "crash", "watcher".`,
    `  Longer user questions = more clues. Mine them for specific nouns and names.`,
    `  e.g. "can you check the file sizes and see if the watcher is running"`,
    `    → ["file size", "watcher", "indexer", "running"]`,
    ``,
    `RETRIES (4 rounds — use them before giving up):`,
    `  1: Specific terms from the question.`,
    `  2: Think about how the conversation would READ when this was discussed.`,
    `     What would the assistant have said? What would the user have asked?`,
    `  3: Related terms — names, tools, files that would appear near the topic.`,
    `  4: Broad single words — cast a wide net.`,
    `  Only say "didn't find" after 3+ failed rounds.`,
    ``,
    `FOLLOW-UPS: "why?", "what about that?", "the other one?" — check your recent`,
    `  conversation to find the topic, then search for THAT topic specifically.`,
    ``,
    `⚠ Your own prior answers may have errors. Trust search results over your memory.`,
  )

  if (chatHistory && chatHistory.length > 0) {
    parts.push(``, `== RECENT CONVERSATION ==`)
    for (const turn of chatHistory.slice(-6)) {
      parts.push(`${turn.role}: ${turn.content.substring(0, 200)}`)
    }
  }

  if (researchContext) {
    parts.push(``, `== ACTIVE RESEARCH ==`, researchContext)
  }

  return parts.join('\n')
}

// ============================================================
// MAIN FUNCTION
// ============================================================

export async function askPipelineFastBrain(
  workingDir: string,
  sessionId: string,
  question: string,
  opts?: PipelineFastBrainOptions,
): Promise<PipelineFastBrainResult> {
  // Skip when no real session yet
  if (!sessionId || sessionId === 'pending') {
    return { script: 'Session is still initializing.', type: 'acknowledgment', toolsUsed: [] }
  }

  const apiKey = process.env.GOOGLE_API_KEY
  if (!apiKey) {
    return { script: "Search system not available right now.", type: 'acknowledgment', toolsUsed: [] }
  }

  // Reset persistent state if session changed
  if (persistentSessionId !== sessionId) {
    persistentContents = []
    persistentSessionId = sessionId
    console.log(`🧠⚡ [pipeline-fb] New session: ${sessionId.substring(0, 8)}`)
  }

  // Prune persistent history (keep last 12)
  if (persistentContents.length > 12) {
    persistentContents = persistentContents.slice(-12)
  }

  try {
    const ai = new GoogleGenAI({ apiKey })
    const systemPrompt = buildSystemPrompt(opts?.chatHistory, opts?.researchContext)
    const sessionBaseDir = opts?.sessionBaseDir || workingDir

    // Create the search tool for this session
    const { tool: searchTool, getSearchCount } = createSearchTool(sessionId, workingDir, sessionBaseDir, opts?.agentControl)

    // Add question to persistent history
    persistentContents.push({ role: 'user', parts: [{ text: question }] })

    // Single generateContent call — AFC handles the tool loop automatically
    const apiCall = ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: persistentContents,
      config: {
        systemInstruction: systemPrompt,
        tools: [searchTool],
        automaticFunctionCalling: { maximumRemoteCalls: MAX_AFC_CALLS },
      },
    })

    // Real timeout via Promise.race
    const timeoutRace = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), TIMEOUT_MS)
    )
    const response = await Promise.race([apiCall, timeoutRace])

    if (!response) {
      persistentContents.pop()
      console.warn(`Pipeline fast brain: timed out after ${TIMEOUT_MS}ms`)
      return { script: 'Search took too long.', type: 'error', toolsUsed: [] }
    }

    const text = response.text
    if (text) {
      persistentContents.push({ role: 'model', parts: [{ text }] })
    }

    const toolsUsed = getSearchCount() > 0 ? ['search_session'] : []
    console.log(`🧠⚡ [pipeline-fb] AFC: ${getSearchCount()} searches, answer: "${(text || '').substring(0, 80)}"`)

    if (!text?.trim()) {
      return {
        script: "I didn't find that in the session history.",
        type: 'answer',
        toolsUsed,
      }
    }

    if (text.includes('[RESEARCH_NEEDED]')) {
      return {
        script: text.replace('[RESEARCH_NEEDED]', '').trim() || 'This needs deeper research.',
        type: 'research_needed',
        toolsUsed,
      }
    }

    return { script: text.trim(), type: 'answer', toolsUsed }

  } catch (err: any) {
    if (err?.status === 429 || err?.message?.includes('429') || err?.message?.includes('RESOURCE_EXHAUSTED')) {
      console.warn('Pipeline fast brain: 429 rate limited')
      return { script: 'Memory search is cooling down.', type: 'error', toolsUsed: [] }
    }
    console.error('Pipeline fast brain error:', err?.message)
    return { script: 'Search error occurred.', type: 'error', toolsUsed: [] }
  }
}
