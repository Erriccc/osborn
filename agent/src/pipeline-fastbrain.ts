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
 *   emergency_stop — interrupt the main agent's turn and redirect it (background tasks survive)
 */

import { getPipelineFastBrainPrompt } from './prompts.js'
import { ZAI_CODING_BASE, zaiApiKey } from './env-key.js'

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

// Provider: Fireworks (OpenAI-compatible) when FIREWORKS_API_KEY is set, else OpenRouter.
// Override the model with OSBORN_FAST_BRAIN_MODEL (the noise gate falls back to it too unless OSBORN_GATE_MODEL is set).
const FIREWORKS = !!process.env.FIREWORKS_API_KEY
const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions'
const OPENROUTER_DEFAULT_MODEL = 'deepseek/deepseek-chat'
const OPENROUTER_MODEL = process.env.OSBORN_FAST_BRAIN_MODEL ||
  (FIREWORKS ? 'accounts/fireworks/models/glm-5p3-flash' : OPENROUTER_DEFAULT_MODEL)
const OPENROUTER_URL = FIREWORKS ? 'https://api.fireworks.ai/inference/v1/chat/completions' : OPENROUTER_API
const TIMEOUT_MS = 20_000
const MAX_TOOL_ROUNDS = 4

/**
 * Per-call provider resolution for the HOUSE DEMO PASS. When the user has no
 * Claude auth, applyAuthFallback() sets OSBORN_DEMO_PASS='zai' - the whole
 * model layer (main agent AND this fast brain) then rides the shared z.ai GLM
 * subscription instead of pay-per-use Fireworks/OpenRouter. Checked per call
 * (not module-load) because applyAuthFallback runs after this module loads, and
 * because a mid-session real-Claude login clears the flag via clearAuthFallback.
 * Returns null on the normal (user pays their own providers) path.
 */
export function resolveFastBrainProvider(): { url: string; model: string; name: string } | null {
  if (process.env.OSBORN_DEMO_PASS !== 'zai') return null
  if (!zaiApiKey()) return null
  return {
    url: `${ZAI_CODING_BASE}/chat/completions`,
    model: process.env.OSBORN_DEMO_FAST_MODEL || 'glm-5.3-flash', // fast/cheap tier of the pass
    name: 'z.ai (demo pass)',
  }
}

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
          'Stop the main agent\'s current turn and redirect it (background sub-agents keep running).',
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
    // Interrupt, not abort: abort() kills the whole subprocess — including the
    // background sub-agents perTaskStopAffordance deliberately spares. A voice
    // "stop" should end the current turn only; a true hard kill stays an
    // explicit UI action (abortQuery).
    await agentControl.interrupt()
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
    return `Agent turn interrupted and redirected (background sub-agents unaffected). Reason: ${reason}`
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
      const hits = await recall(db, query, { mode: embed ? 'hybrid' : 'keyword', topK: 12, embed, scopeCwd: workingDir })
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

export async function getRecentEntries(sessionId: string, workingDir: string, _: string | undefined, count: number): Promise<string> {
  // Newest content rows straight from the recall DB (append-only, so highest id = latest).
  const { storeExists, openStore, recentRows, recallScope, rowInScope } = await import('./session-store.js')
  const dbPath = storeExists(sessionId, workingDir)
  if (!dbPath) return 'Index not built yet.'
  const db = openStore(dbPath, { readonly: true })
  try {
    const scope = recallScope(workingDir)
    const rows = recentRows(db, Math.max(count * 10, 200)).filter(r => rowInScope(r.cwd, scope)).slice(0, count) // newest first; over-fetch (bounded) so out-of-scope rows do not eat the count
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

// ============================================================
// SYSTEM PROMPT
// ============================================================
//
// PROMPT-CACHING NOTE (Fireworks/z.ai auto-cache long prefixes): the system
// message is the START of the OpenAI prompt and those providers cache by
// prefix. The system prompt (prompts/pipeline-fast-brain.md) is therefore fully STATIC — the volatile
// per-call inputs (chatHistory, researchContext) live in buildTurnContext()
// and are prepended to the CURRENT user message instead, so the system +
// persistent-messages prefix stays byte-identical across a session and every
// turn after the first is a cache hit.

/**
 * Volatile per-turn context (recent conversation, active research) that USED to be
 * interpolated into the system prompt. Moved into the first user message so the
 * system + persistent-messages PREFIX stays byte-stable across a session and the
 * Fireworks/z.ai prefix cache hits on every turn after the first. Rendered LAST
 * (just before the question) so the stable head hits cache. '' when empty.
 */
function buildTurnContext(chatHistory?: { role: string; content: string }[], researchContext?: string): string {
  const parts: string[] = []
  if (chatHistory && chatHistory.length > 0) {
    parts.push(`== RECENT CONVERSATION ==`)
    for (const turn of chatHistory.slice(-6)) {
      parts.push(`${turn.role}: ${turn.content.substring(0, 200)}`)
    }
  }
  if (researchContext) parts.push(`== ACTIVE RESEARCH ==`, researchContext)
  return parts.length ? parts.join('\n') + '\n\n' : ''
}

// ============================================================
// OPENROUTER CALL
// ============================================================

interface FastBrainCandidate { url: string; key: string; model: string; name: string }

/** A retired or unknown model, by what the provider says: a bare 404 (a gateway's "No endpoints found")
 *  is not retirement. */
export function isModelNotFound(status: number, body: string): boolean {
  return [400, 403, 404].includes(status) &&
    /model[_ ]not[_ ]found|model\b.{0,80}(does not exist|not found|decommissioned|retired)|unknown model/i.test(body)
}

const candidateId = (c: FastBrainCandidate): string => `${c.url}|${c.model}`

/** Models in the order to try. The demo pass is one model on the house key; otherwise the configured
 *  provider, then (with both keys set) OpenRouter's default model: a turn falls back to that provider. */
function fastBrainCandidates(): FastBrainCandidate[] {
  const demo = resolveFastBrainProvider()
  if (demo) return [{ ...demo, key: zaiApiKey() }]
  const fw = process.env.FIREWORKS_API_KEY
  const or = process.env.OPENROUTER_API_KEY
  const list: FastBrainCandidate[] = []
  if (FIREWORKS && fw) list.push({ url: OPENROUTER_URL, key: fw, model: OPENROUTER_MODEL, name: 'Fireworks' })
  else if (or) list.push({ url: OPENROUTER_URL, key: or, model: OPENROUTER_MODEL, name: 'OpenRouter' })
  if (fw && or) list.push({ url: OPENROUTER_API, key: or, model: OPENROUTER_DEFAULT_MODEL, name: 'OpenRouter' })
  return list.filter((c) => c.key)
}

// A model that answered "model not found" is skipped for DEAD_TTL_MS, and only while another model exists.
const DEAD_TTL_MS = 10 * 60_000
const deadUntil = new Map<string, number>()
let fallbackFrom: string | null = null
let modelInUse: string | null = null
let probed = false

const isDead = (c: FastBrainCandidate): boolean => (deadUntil.get(candidateId(c)) ?? 0) > Date.now()
const firstLive = (all: FastBrainCandidate[]): FastBrainCandidate | undefined => all.find((c) => !isDead(c)) ?? all[0]

/** For /health: the model that last answered and the retired one it replaced. */
export const fastBrainModelStatus = () => ({ model: modelInUse, fallbackFrom })

/** Tests only. */
export function resetFastBrainFallback() { deadUntil.clear(); fallbackFrom = null; modelInUse = null; probed = false }

/** One request; on a model-not-found answer with another model available, mark that one dead and retry once on it. */
export async function requestWithFallback(body: Record<string, unknown>): Promise<any> {
  const all = fastBrainCandidates()
  let c = firstLive(all)
  for (let attempt = 0; c; attempt++) {
    const resp = await fetch(c.url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${c.key}`, 'Content-Type': 'application/json', 'X-OpenRouter-Title': 'Osborn Fast Brain' },
      body: JSON.stringify({ model: c.model, ...body }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (resp.ok) { modelInUse = c.model; if (c === all[0]) fallbackFrom = null; return resp.json() }
    const text = await resp.text().catch(() => '')
    const tried = c
    const next = attempt === 0 && isModelNotFound(resp.status, text) ? all.find((x) => x !== tried && !isDead(x)) : undefined
    if (!next) throw new Error(`${tried.name} ${resp.status}: ${text.substring(0, 200)}`)
    deadUntil.set(candidateId(tried), Date.now() + DEAD_TTL_MS)
    if (modelInUse === tried.model) modelInUse = null
    fallbackFrom ??= tried.model
    console.warn(`🧠⚡ [pipeline-fb] ${tried.name} model ${tried.model} not found; falling back to ${next.model}`)
    c = next
  }
  throw new Error('no fast-brain model available')
}

async function callOpenRouter(messages: any[], tools: any[]): Promise<any> {
  return requestWithFallback({ messages, tools, tool_choice: 'auto' })
}

/** One tiny request, once per process, so a retired model is replaced before the first turn. */
export async function probeFastBrain(): Promise<void> {
  if (probed || !fastBrainCandidates().length) return
  probed = true
  try { await requestWithFallback({ messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }) }
  catch (err: any) { console.warn('🧠⚡ [pipeline-fb] startup probe failed:', err?.message) }
}

// ============================================================
// MAIN FUNCTION
// ============================================================

// The fast brain stating its own limits is a hand-off (the main agent has those tools);
// recall that mentions a tool or an inability stays an answer (see the guard test).
const CAPABILITY_DENIAL = new RegExp([
  /(?:\bI(?:'m| am)?|\bsorry,?)\s+(?:not able to|unable to|can't|cannot|can not|(?:don't|do not) have (?:the ability|a way|any way) to)\s+(?:actually\s+|directly\s+)?/.source +
    /(?:browse|record (?:a |the )?(?:video|audio|screen|clip|page)|take (?:a )?screenshots?|edit|build|run|execute|open|visit|fetch|download|access)\b(?!\s+(?:through|over|down)\b)/.source,
  /\bI(?:'m| am)?\s+(?:not able to|unable to|don't|do not|can't|cannot|can not|have no|lack)\b(?!\s+(?:find|see|locate|recall|spot|remember|know|tell|wait|record|details)\b)/.source +
    /[^.!?\n]{0,60}?\b(?:browser|bash|shell|terminal|internet)\b(?!\s+(?:output|logs?|command|script|session|history)\b)/.source,
].join('|'), 'i')

export const isHandOff = (text: string): boolean =>
  text.includes('[RESEARCH_NEEDED]') || CAPABILITY_DENIAL.test(text.replace(/[\u2018\u2019]/g, "'"))

/** Every exit that carries model text: sanitise, then answer or hand off. A hand-off
 *  carries no text (nothing for a consumer to post) and is not kept in the fast
 *  brain's own history, so a suppressed denial cannot prime the next turn. */
function finish(question: string, raw: string | undefined, toolsUsed: string[]): PipelineFastBrainResult {
  const text = sanitizeFastBrainAnswer((raw || '').trim())
  persistentMessages.push({ role: 'user', content: question })
  console.log(`🧠⚡ [pipeline-fb] ${toolsUsed.length} searches, answer: "${text.substring(0, 80)}"`)
  if (!text || isHandOff(text)) return { script: '', type: 'research_needed', toolsUsed }
  persistentMessages.push({ role: 'assistant', content: text })
  return { script: text, type: 'answer', toolsUsed }
}

/**
 * Strip internal recall provenance the fast brain may echo into its answer so
 * the user never sees it: citation headers like
 *   [main L550 · tool_result · both] 2026-08-09T19:29:01.229Z
 * bare "L123: ..." line prefixes, and standalone ISO timestamps.
 */
function sanitizeFastBrainAnswer(text: string): string {
  if (!text) return text
  return text
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      if (!t) return true
      if (/^\[[^\]]*\bL\d+\b[^\]]*·[^\]]*\]/.test(t)) return false // citation header
      if (/^L\d+\s*:/.test(t)) return false                        // "L123: ..." prefix
      if (/^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/.test(t)) return false     // bare timestamp
      return true
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export async function askPipelineFastBrain(
  workingDir: string,
  sessionId: string,
  question: string,
  opts?: PipelineFastBrainOptions,
): Promise<PipelineFastBrainResult> {
  if (!sessionId || sessionId === 'pending') {
    return { script: 'Session is still initializing.', type: 'acknowledgment', toolsUsed: [] }
  }

  // Demo pass (house z.ai key) takes precedence when active; else the user's own
  // pay-per-use providers (Fireworks preferred, OpenRouter fallback).
  if (!fastBrainCandidates().length) {
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

  const systemPrompt = getPipelineFastBrainPrompt()
  const turnContext = buildTurnContext(opts?.chatHistory, opts?.researchContext)
  const sessionBaseDir = opts?.sessionBaseDir || workingDir
  const tools = buildTools(!!opts?.agentControl)
  const toolsUsed: string[] = []

  // Build messages: STATIC system + persistent history + new user message.
  // The volatile per-turn context rides INSIDE the current user message (last)
  // so the system+history prefix is a cache-stable head (see buildTurnContext).
  const messages: any[] = [
    { role: 'system', content: systemPrompt },
    ...persistentMessages,
    { role: 'user', content: turnContext ? `${turnContext}${question}` : question },
  ]
  const turnStart = messages.length  // this turn's replies only: never an earlier answer

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
      const data = await callOpenRouter(messages, tools)
      // Cache observability: OpenAI-compatible providers report cached prefix
      // tokens on usage.prompt_tokens_details.cached_tokens (Fireworks/z.ai both
      // populate it when the prefix cache hits).
      const cachedTokens = (data as any)?.usage?.prompt_tokens_details?.cached_tokens
      if (typeof cachedTokens === 'number' && cachedTokens > 0) {
        const promptTokens = (data as any)?.usage?.prompt_tokens || 0
        console.log(`[cache] fast-brain cached=${cachedTokens} prompt=${promptTokens} (hit${promptTokens > 0 ? Math.round((cachedTokens / promptTokens) * 100) : 0}%)`)
      }
      const choice = data.choices?.[0]
      const msg = choice?.message

      if (!msg) break

      // Add assistant message to context
      messages.push(msg)

      const calls = msg.tool_calls
      if (!calls || calls.length === 0) {
        return finish(question, msg.content, toolsUsed)
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

    // Max rounds or deadline hit — whatever text we have, classified the same way.
    const lastAssistant = messages.slice(turnStart).reverse().find(m => m.role === 'assistant' && m.content)
    return finish(question, lastAssistant?.content, toolsUsed)

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
