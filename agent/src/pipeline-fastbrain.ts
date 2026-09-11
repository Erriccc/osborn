/**
 * pipeline-fastbrain.ts — Pipeline Fast Brain (Agent with tool loop)
 *
 * Uses OpenRouter (OpenAI-compatible) instead of Google Gemini.
 * Manual tool loop replaces Gemini's Automatic Function Calling (AFC).
 *   - Model decides IF it needs to search (skips for greetings/follow-ups)
 *   - Model decides WHAT to search (smart phrase selection)
 *   - Model can multi-step: search → not enough → refine → search again
 *
 * Tools:
 *   search_session — ripgrep the summary index + read full content via byte offsets
 *   get_recent     — latest N index entries + full content
 *   emergency_stop — kill and restart the main agent
 */

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

export interface AgentControlCallbacks {
  interrupt: () => Promise<boolean>
  abort: () => void
  hasActiveAgent: () => boolean
  getRecentUserMessages: (count: number) => string[]
  sendPrompt: (prompt: string) => void
}

// ============================================================
// CONSTANTS
// ============================================================

const OPENROUTER_MODEL = 'deepseek/deepseek-chat-v3-5'
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const TIMEOUT_MS = 20_000
const MAX_TOOL_ROUNDS = 4

// ============================================================
// PERSISTENT STATE (OpenAI message format)
// ============================================================

let persistentMessages: { role: string; content: string; tool_call_id?: string; name?: string }[] = []
let persistentSessionId: string | null = null

export function clearPipelineFastBrainSession() {
  persistentMessages = []
  persistentSessionId = null
}

export async function prewarmBM25Index(_sessionId: string, _workingDir: string) {}

// ============================================================
// TOOL DEFINITIONS (OpenAI function calling format)
// ============================================================

function buildTools(hasAgentControl: boolean) {
  const tools: any[] = [
    {
      type: 'function',
      function: {
        name: 'search_session',
        description: 'Search session history by keywords. Returns summaries + full untruncated content. Use for questions about what was discussed, decided, researched, or built.',
        parameters: {
          type: 'object',
          properties: {
            phrases: {
              type: 'array',
              items: { type: 'string' },
              description: '2-3 word search phrases, lowercase. Include one phrase per topic.',
            },
          },
          required: ['phrases'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_recent',
        description: 'Get the most recent session activity with full content. Use for: "where did we leave off?", "what just happened?", "what are we working on?", or any question about recent/current work.',
        parameters: {
          type: 'object',
          properties: {
            count: {
              type: 'number',
              description: 'Number of recent entries. Default 20, max 50.',
            },
          },
        },
      },
    },
  ]

  if (hasAgentControl) {
    tools.push({
      type: 'function',
      function: {
        name: 'emergency_stop',
        description: [
          'Kill and restart the main agent with new instructions.',
          'Call when the user clearly wants the agent to STOP a DESTRUCTIVE or ALTERING action:',
          '  - Destructive actions: write, edit, delete, install, deploy, push, modify files/data',
          '  - Wrong direction: agent is doing something the user didn\'t ask for or explicitly rejects',
          'User signals: "stop", "don\'t", "cancel", "wait no", "not that", "no no no", "I said stop".',
          'NEVER call for: research, reading, exploring, searching, fetching, or casual conversation.',
          'When in doubt: check get_recent first to see what the agent is actually doing.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            reason: {
              type: 'string',
              description: 'What destructive action is being stopped and what the user wants instead.',
            },
          },
          required: ['reason'],
        },
      },
    })
  }

  return tools
}

// ============================================================
// TOOL EXECUTION
// ============================================================

async function executeTool(
  name: string,
  args: any,
  sessionId: string,
  workingDir: string,
  agentControl?: AgentControlCallbacks,
): Promise<string> {
  if (name === 'search_session') {
    const phrases = (args?.phrases as string[]) || []
    if (phrases.length === 0) return 'No phrases provided'
    console.log(`🧠⚡ [pipeline-fb] search: [${phrases.join(', ')}]`)
    return executeSearch(phrases, sessionId, workingDir)

  } else if (name === 'get_recent') {
    const count = Math.min(Math.max((args?.count as number) || 20, 5), 50)
    console.log(`🧠⚡ [pipeline-fb] get_recent: ${count}`)
    return getRecentEntries(sessionId, workingDir, undefined, count)

  } else if (name === 'emergency_stop' && agentControl) {
    const reason = (args?.reason as string) || 'user requested stop'
    console.log(`🧠⚡ [pipeline-fb] emergency_stop: ${reason}`)
    const recentUserMessages = agentControl.getRecentUserMessages(10)
    const recentActivity = await getRecentEntries(sessionId, workingDir, undefined, 10)
    agentControl.abort()
    agentControl.sendPrompt([
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
    ].join('\n'))
    return `Agent stopped and restarted. Reason: ${reason}`
  }

  return 'Unknown tool'
}

// ============================================================
// SEARCH HELPERS
// ============================================================

async function executeSearch(phrases: string[], sessionId: string, workingDir: string): Promise<string> {
  const { ripgrepSearch } = await import('./jsonl-search.js')
  const { getIndexPath, readFullContent } = await import('./summary-index.js')

  const indexPath = getIndexPath(sessionId, workingDir)

  if (indexPath) {
    const sections: string[] = []
    const matchedRefs: { lineNum: number; byteOffset: number; source: string }[] = []
    const seenLines = new Set<string>()

    for (const phrase of phrases.slice(0, 6)) {
      const results = ripgrepSearch(indexPath, phrase, { maxResults: 8, fromEnd: true, contextLines: 0 })
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
            matchedRefs.push({ lineNum: parseInt(parts[0], 10), byteOffset: parseInt(parts[1], 10), source: parts[3] })
            sections.push(r.content)
          }
        }
      }
    }

    if (matchedRefs.length > 0) {
      try {
        const fullTexts = readFullContent(matchedRefs, sessionId, workingDir, undefined, 2000)
        if (fullTexts.length > 0) sections.push('', `[FULL CONTENT — ${fullTexts.length} entries]`, ...fullTexts)
      } catch {}
    }

    return sections.length === 0 ? `No matches for: ${phrases.join(', ')}` : sections.join('\n')
  }

  const { getSessionPaths } = await import('./session-access.js')
  const paths = getSessionPaths(sessionId, workingDir)
  if (!paths.exists) return 'No session files found'

  const sections: string[] = []
  for (const phrase of phrases.slice(0, 4)) {
    const results = ripgrepSearch(paths.conversation, phrase, { maxResults: 5, fromEnd: true, contextLines: 0 })
    if (results.length > 0) {
      sections.push(`["${phrase}" — ${results.length} matches]`)
      sections.push(...results.map((r: any) => `L${r.lineNumber}: ${r.content}`))
    }
  }
  return sections.length > 0 ? sections.join('\n') : `No matches for: ${phrases.join(', ')}`
}

async function getRecentEntries(sessionId: string, workingDir: string, _: string | undefined, count: number): Promise<string> {
  const { readFileSync } = await import('fs')
  const { getIndexPath, readFullContent } = await import('./summary-index.js')

  const indexPath = getIndexPath(sessionId, workingDir)
  if (!indexPath) return 'Index not built yet.'

  const content = readFileSync(indexPath, 'utf-8')
  const recentLines = content.split('\n').filter(Boolean).slice(-count)
  const refs: { lineNum: number; byteOffset: number; source: string }[] = []
  const summaries: string[] = [`[RECENT — last ${recentLines.length} entries]`]

  for (const line of recentLines) {
    summaries.push(line)
    const parts = line.split('|')
    if (parts.length >= 6) {
      refs.push({ lineNum: parseInt(parts[0], 10), byteOffset: parseInt(parts[1], 10), source: parts[3] })
    }
  }

  if (refs.length > 0) {
    try {
      const fullTexts = readFullContent(refs, sessionId, workingDir, undefined, 1500)
      if (fullTexts.length > 0) summaries.push('', `[FULL CONTENT — ${fullTexts.length} entries]`, ...fullTexts)
    } catch {}
  }

  return summaries.join('\n')
}

// ============================================================
// SYSTEM PROMPT
// ============================================================

function buildSystemPrompt(chatHistory?: { role: string; content: string }[], researchContext?: string): string {
  const parts = [
    `You are a fast memory recall agent for a voice AI assistant called Osborn.`,
    `You search the user's conversation history — their questions, the assistant's answers,`,
    `tool calls, research findings, and decisions — stored as indexed session files.`,
    `Tools: search_session (keyword search) and get_recent (latest activity).`,
    ``,
    `== OBJECTIVE ==`,
    `Answer from session history. Search first for any recall question.`,
    `Greetings/thanks/confirmations: respond directly, no search.`,
    `Tasks needing live code analysis or new research: respond with [RESEARCH_NEEDED]`,
    ``,
    `== STYLE ==`,
    `1-3 sentences. Grounded in results. Never fabricate.`,
    `If not found after thorough searching: "I didn't find that in the session history."`,
    ``,
    `== AUDIENCE ==`,
    `A user having a conversation via voice. Questions may be casual, rambling,`,
    `or use vague references ("that thing", "the error"). Interpret intent, not just words.`,
    ``,
    `== RESULTS FORMAT ==`,
    `Each line: lineNum|byteOffset|timestamp|source|msgType|summary`,
    `  source: "main" = conversation, "agent-XXXX" = sub-agent research`,
    `Full content sections have complete untruncated text.`,
    ``,
    `== HOW TO SEARCH ==`,
    `Think about what words people ACTUALLY USED when this topic came up.`,
    `PHRASES: 1-4 words each, multiple phrases per call.`,
    `  Short precise terms beat long phrases. "error" finds more than "error we got".`,
    `RETRIES (4 rounds — use them before giving up):`,
    `  1: Specific terms from the question.`,
    `  2: Think about how the conversation would READ when this was discussed.`,
    `  3: Related terms — names, tools, files that would appear near the topic.`,
    `  4: Broad single words — cast a wide net.`,
    `  Only say "didn't find" after 3+ failed rounds.`,
    `⚠ Your own prior answers may have errors. Trust search results over your memory.`,
  ]

  if (chatHistory && chatHistory.length > 0) {
    parts.push(``, `== RECENT CONVERSATION ==`)
    for (const turn of chatHistory.slice(-6)) {
      parts.push(`${turn.role}: ${turn.content.substring(0, 200)}`)
    }
  }

  if (researchContext) parts.push(``, `== ACTIVE RESEARCH ==`, researchContext)

  return parts.join('\n')
}

// ============================================================
// OPENROUTER CALL
// ============================================================

async function callOpenRouter(messages: any[], tools: any[], apiKey: string): Promise<any> {
  const resp = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-OpenRouter-Title': 'Osborn Fast Brain',
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages,
      tools,
      tool_choice: 'auto',
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`OpenRouter ${resp.status}: ${body.substring(0, 200)}`)
  }

  return resp.json()
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
  if (!sessionId || sessionId === 'pending') {
    return { script: 'Session is still initializing.', type: 'acknowledgment', toolsUsed: [] }
  }

  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    return { script: 'Search system not available right now.', type: 'acknowledgment', toolsUsed: [] }
  }

  // Reset on session change
  if (persistentSessionId !== sessionId) {
    persistentMessages = []
    persistentSessionId = sessionId
    console.log(`🧠⚡ [pipeline-fb] New session: ${sessionId.substring(0, 8)}`)
  }

  // Prune history (keep last 12 turns)
  if (persistentMessages.length > 24) {
    persistentMessages = persistentMessages.slice(-24)
  }

  const systemPrompt = buildSystemPrompt(opts?.chatHistory, opts?.researchContext)
  const sessionBaseDir = opts?.sessionBaseDir || workingDir
  const tools = buildTools(!!opts?.agentControl)
  const toolsUsed: string[] = []

  // Build messages: system + persistent history + new user message
  const messages: any[] = [
    { role: 'system', content: systemPrompt },
    ...persistentMessages,
    { role: 'user', content: question },
  ]

  try {
    let rounds = 0

    while (rounds < MAX_TOOL_ROUNDS) {
      rounds++
      const data = await callOpenRouter(messages, tools, apiKey)
      const choice = data.choices?.[0]
      const msg = choice?.message

      if (!msg) break

      // Add assistant message to context
      messages.push(msg)

      const calls = msg.tool_calls
      if (!calls || calls.length === 0) {
        // Final text response
        const text = (msg.content || '').trim()

        // Update persistent history with this exchange
        persistentMessages.push({ role: 'user', content: question })
        if (text) persistentMessages.push({ role: 'assistant', content: text })

        console.log(`🧠⚡ [pipeline-fb] ${toolsUsed.length} searches, answer: "${text.substring(0, 80)}"`)

        if (!text) return { script: "I didn't find that in the session history.", type: 'answer', toolsUsed }
        if (text.includes('[RESEARCH_NEEDED]')) {
          return { script: text.replace('[RESEARCH_NEEDED]', '').trim() || 'This needs deeper research.', type: 'research_needed', toolsUsed }
        }
        return { script: text, type: 'answer', toolsUsed }
      }

      // Execute tool calls
      for (const call of calls) {
        const name = call.function?.name
        let args: any = {}
        try { args = JSON.parse(call.function?.arguments || '{}') } catch {}

        const result = await executeTool(name, args, sessionId, workingDir, opts?.agentControl)
        if (name === 'search_session' || name === 'get_recent') toolsUsed.push(name)

        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: result,
        })
      }
    }

    // Max rounds hit — extract whatever text we have
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant' && m.content)
    const fallback = lastAssistant?.content?.trim() || "I didn't find that in the session history."
    persistentMessages.push({ role: 'user', content: question })
    if (fallback) persistentMessages.push({ role: 'assistant', content: fallback })
    return { script: fallback, type: 'answer', toolsUsed }

  } catch (err: any) {
    if (err?.name === 'TimeoutError' || err?.message?.includes('timeout')) {
      console.warn('Pipeline fast brain: timed out')
      return { script: 'Search took too long.', type: 'error', toolsUsed: [] }
    }
    if (err?.message?.includes('429')) {
      console.warn('Pipeline fast brain: rate limited')
      return { script: 'Memory search is cooling down.', type: 'error', toolsUsed: [] }
    }
    console.error('Pipeline fast brain error:', err?.message)
    return { script: 'Search error occurred.', type: 'error', toolsUsed: [] }
  }
}
