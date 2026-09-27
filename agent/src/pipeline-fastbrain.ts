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

// Model reads from env var (set by main process from getInferenceConfig) or DEFAULT_CONFIG default.
// To switch model: update DEFAULT_CONFIG.inference.fastBrainModel in config.ts, or set OSBORN_FAST_BRAIN_MODEL env var.
const OPENROUTER_MODEL = process.env.OSBORN_FAST_BRAIN_MODEL || 'deepseek/deepseek-chat'
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
  // DB-FIRST: query the recall store (full untruncated text + hybrid keyword+vector).
  // Vector/hybrid is PREFERRED; recall() degrades to keyword INSIDE when the vec table is
  // empty or no embedder is available. This replaces the old ripgrep-over-search-index.txt
  // two-step (grep summary → read JSONL by offset) with one call that already returns full text.
  const { storeExists, openStore, recall } = await import('./session-store.js')
  const dbPath = storeExists(sessionId, workingDir)
  if (dbPath) {
    let embed: any = undefined
    try {
      if (process.env.OSBORN_EMBED !== '0') {
        const { getEmbedder } = await import('./embedder.js')
        // Tight timeout so a slow/cold embed never blows the fast-brain deadline → keyword.
        embed = (await getEmbedder(2500)) ?? undefined
      }
    } catch {}
    // Best-effort: a recall/decompress throw must degrade to the ripgrep fallback below,
    // never collapse the whole fast-brain turn (mirrors buildRecallInjection's swallow).
    let dbResult: string | null = null
    const db = openStore(dbPath, { readonly: true })
    try {
      const query = phrases.slice(0, 6).join(' ')
      const hits = await recall(db, query, { mode: embed ? 'hybrid' : 'keyword', topK: 12, embed })
      if (!hits.length) {
        dbResult = `No matches for: ${phrases.join(', ')}`
      } else {
        const sections: string[] = []
        for (const h of hits) {
          const src = `${h.source} L${h.lineNum} · ${h.msgType}${h.toolName ? `:${h.toolName}` : ''} · ${h.matchedBy}`
          let body = h.text.replace(/\n{3,}/g, '\n\n').trim()
          if (body.length > 2000) body = body.slice(0, 2000) + ' …'
          sections.push(`[${src}]${h.ts ? ' ' + h.ts : ''}\n${body}`)
        }
        dbResult = sections.join('\n\n')
      }
    } catch (err: any) {
      console.warn('[fast-brain] recall DB search failed, falling back to raw JSONL:', err?.message || err)
      // dbResult stays null → fall through to the ripgrep fallback below
    } finally {
      db.close()
    }
    if (dbResult !== null) return dbResult
  }

  // FALLBACK: store not built yet (brand-new session before the first sweep) → raw-JSONL ripgrep.
  const { ripgrepSearch } = await import('./jsonl-search.js')
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
  // Newest content rows straight from the recall DB (append-only, so highest id = latest).
  const { storeExists, openStore, recentRows } = await import('./session-store.js')
  const dbPath = storeExists(sessionId, workingDir)
  if (!dbPath) return 'Index not built yet.'
  const db = openStore(dbPath, { readonly: true })
  try {
    const rows = recentRows(db, count) // newest first
    if (!rows.length) return 'No entries yet.'
    const out: string[] = [`[RECENT — last ${rows.length} entries, newest first]`]
    for (const h of rows) {
      const src = `${h.source} L${h.lineNum} · ${h.msgType}${h.toolName ? `:${h.toolName}` : ''}`
      let body = h.text.replace(/\n{3,}/g, '\n\n').trim()
      if (body.length > 1500) body = body.slice(0, 1500) + ' …'
      out.push(`[${src}]${h.ts ? ' ' + h.ts : ''}\n${body}`)
    }
    return out.join('\n\n')
  } catch (err: any) {
    console.warn('[fast-brain] recent-entries read failed:', err?.message || err)
    return 'Could not read recent entries.'
  } finally {
    db.close()
  }
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
    `== DECISIONS: DEFER, DON'T ASSERT ==`,
    `The grounded main agent answers the SAME question in parallel with full context — it owns`,
    `decisions. For questions asking what was DECIDED / CHOSEN / SCOPED / AGREED / "what were the`,
    `options" / "what did we settle on" / "remind me what we decided": do NOT state a definitive`,
    `answer from one keyword hit. A single matched line is often a passing mention, not the`,
    `decision (e.g. a file that "covers WhatsApp and LinkedIn" is NOT the scoping decision).`,
    `Only assert a decision if MULTIPLE recent hits corroborate it AND one is clearly the decision`,
    `itself. Otherwise hedge briefly and defer — e.g. "I think it involved X, but let the main`,
    `agent confirm the exact decision" — or emit [RESEARCH_NEEDED]. Never contradict-with-confidence.`,
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
    `Each hit is a header line then its FULL untruncated text:`,
    `  [<source> L<lineNum> · <msgType>[:<tool>] · <matchedBy>] <timestamp>`,
    `  <full text of that message/tool result>`,
    `  source: "main" = conversation, "agent-XXXX" = sub-agent research.`,
    `  matchedBy: keyword | vector | both (how recall found it — vector/hybrid is preferred).`,
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
    // Overall wall-clock cap. The per-request fetch timeout doesn't bound the whole
    // tool loop; if the event loop is briefly busy (large ingest sweep) a search could
    // otherwise stretch to 40–130s. Bail with whatever we have past this deadline.
    const FASTBRAIN_DEADLINE_MS = 8000
    const startTime = Date.now()

    while (rounds < MAX_TOOL_ROUNDS) {
      if (Date.now() - startTime > FASTBRAIN_DEADLINE_MS) {
        console.warn(`🧠⚡ [pipeline-fb] deadline hit after ${rounds} rounds`)
        break
      }
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
