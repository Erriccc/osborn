/**
 * lens-model.ts — OpenRouter model calls for the content lens (map-reduce).
 * OpenRouter ONLY — never the Claude subscription / Anthropic SDK.
 *
 * Model: big-window, env-overridable (OSBORN_CONTENT_LENS_MODEL). Default
 * minimax/minimax-m3 — verified 2026-10-05 via GET /api/v1/models:
 * context_length 1,048,576, $0.30/M prompt, $1.20/M completion (top provider
 * 524,288 ctx). Window = 25% of the model's context_length, looked up live so an
 * override is sized correctly; the constants below are only the fallback.
 *
 * Credit is limited, so every run has a HARD cap on calls AND dollars
 * (OSBORN_LENS_MAX_CALLS / OSBORN_LENS_MAX_COST_USD). A call is refused up front
 * if its worst-case cost would cross the cap; actual cost comes from OpenRouter's
 * usage accounting when present.
 */

const OPENROUTER = 'https://openrouter.ai/api/v1'
export const DEFAULT_MODEL = 'minimax/minimax-m3'
const DEFAULT_MODEL_INFO = { contextLength: 1_048_576, promptPerTok: 0.3e-6, completionPerTok: 1.2e-6 }
export const WINDOW_FRACTION = 0.25
const CALL_TIMEOUT_MS = 6 * 60_000
const META_TIMEOUT_MS = 15_000

const envNum = (k: string, d: number): number => {
  const n = Number(process.env[k])
  return Number.isFinite(n) && n > 0 ? n : d
}
export const lensModel = (): string => (process.env.OSBORN_CONTENT_LENS_MODEL || '').trim() || DEFAULT_MODEL

export interface ModelInfo {
  id: string
  contextLength: number
  promptPerTok: number
  completionPerTok: number
  /** true = read from the OpenRouter models API this run; false = built-in fallback. */
  verified: boolean
}

/** Live context length + price. Null for an unknown overridden model (can't enforce the cost cap). */
export async function getModelInfo(apiKey: string, id = lensModel()): Promise<ModelInfo | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), META_TIMEOUT_MS)
  try {
    const resp = await fetch(`${OPENROUTER}/models`, { signal: ctrl.signal, headers: { Authorization: `Bearer ${apiKey}` } })
    if (resp.ok) {
      const data: any = await resp.json()
      const m = (data?.data ?? []).find((x: any) => x?.id === id)
      const p = Number(m?.pricing?.prompt)
      const c = Number(m?.pricing?.completion)
      if (m && m.context_length > 0 && p >= 0 && c >= 0) {
        return { id, contextLength: m.context_length, promptPerTok: p, completionPerTok: c, verified: true }
      }
    }
  } catch {
    /* fall through */
  } finally {
    clearTimeout(timer)
  }
  return id === DEFAULT_MODEL ? { id, ...DEFAULT_MODEL_INFO, verified: false } : null
}

export const windowTokensFor = (info: ModelInfo): number => Math.floor(info.contextLength * WINDOW_FRACTION)

export class Budget {
  calls = 0
  failures = 0
  spentUsd = 0
  refused = 0
  readonly maxCalls: number
  readonly maxCostUsd: number
  /** caps override the env/default caps (e.g. the period map's own $0.50 hard cap). */
  constructor(readonly info: ModelInfo, caps: { maxCalls?: number; maxCostUsd?: number } = {}) {
    this.maxCalls = caps.maxCalls ?? envNum('OSBORN_LENS_MAX_CALLS', 14)
    this.maxCostUsd = caps.maxCostUsd ?? envNum('OSBORN_LENS_MAX_COST_USD', 1.25)
  }
  estimate(promptTokens: number, maxOut: number): number {
    return promptTokens * this.info.promptPerTok + maxOut * this.info.completionPerTok
  }
  /** Reserve one call if both caps allow its worst case. */
  take(promptTokens: number, maxOut: number): boolean {
    if (this.calls >= this.maxCalls || this.spentUsd + this.estimate(promptTokens, maxOut) > this.maxCostUsd) {
      this.refused++
      return false
    }
    this.calls++
    return true
  }
}

const SYSTEM =
  'You read engineering work transcripts between a person (user) and their AI coding assistant (assistant). ' +
  'You never invent facts. You quote ONLY verbatim text that appears in the transcript. Reply with one JSON object only.'

const QUOTE_RULES =
  'QUOTES: every item needs 1-3 quotes. Each quote = {"text": exact verbatim substring (12-300 chars) copied character-for-character ' +
  'from ONE record, "timestamp": that record\'s exact timestamp from its [#row | timestamp | speaker] header, "row": that record\'s row number ' +
  '(digits only), "speaker": "user"|"assistant"}. Do not paraphrase, merge, or fix typos inside quotes. ' +
  'ONE contiguous span: no ellipses ("..."/"…"), no skipped words, no joined sentences — if it is too long, quote a shorter span. ' +
  'Never quote secrets, keys, tokens, emails, or private personal details.'

function itemRules(maxA: number, maxC: number): string {
  return (
    `ANGLES (0-${maxA}): things a builder could post publicly — {"title", "why" (one line: why postable), "quotes", ` +
    '"queries": 1-2 short Hacker News search queries (2-5 words) to check if this is already covered}. ' +
    'NEVER produce items about personal invoicing, retainers, refunds owed, overdue payments, contract/rate negotiation, or money ' +
    'owed to or by the person — not content material. Billing as ENGINEERING is fine (Stripe/payment webhooks or API integrations, ' +
    'billing APIs, payment gateways, ads-API spend/budgets/spend caps/pricing, token pricing, rate limits, wallet holds).\n' +
    'Client/customer details are already masked as tags like [client], [founder], [brand], [ad account], [amount]: keep the tags, ' +
    'never guess or reintroduce real names, client companies, IDs or amounts. Refer to client companies as "[client]" or ' +
    '"a marketing-platform client". Frame client work as the technical lesson.\n' +
    `CAPABILITIES (0-${maxC}): what this person DEMONSTRABLY did. Two kinds count, tag each with "evidence":\n` +
    '  - "shipped": built / deployed / merged / verified working — the quotes show it was DONE (tests passed, deployed, confirmed working).\n' +
    '  - "root-caused": debugging where the root cause was actually FOUND or PROVEN (e.g. "found the missing x-forwarded-host header ' +
    'causing WS 1006"), even if no fix shipped yet.\n' +
    '  EXCLUDE: plans, proposals, TODOs, "we could/should/will", ideas, unresolved speculation, things only discussed. ' +
    'If the quotes only show intent or a hypothesis, leave it out.\n' +
    '  Each = {"name": SPECIFIC capability (what + where + the non-obvious detail), e.g. "debugged Meta IG ad-authorization failing ' +
    'silently unless page is business-owned" — NOT generic labels like "debugging", "api-integration", "node-development"; ' +
    '"evidence": "shipped"|"root-caused", "did": one line on what was done/found, "proof": one line naming which quote shows it was ' +
    'done/found, "quotes"}.\nReturn empty arrays if nothing qualifies.'
  )
}

/**
 * Transcript FIRST, instructions AFTER: measured on minimax-m3 with a ~257k-token
 * window, instructions-before-transcript returned {"angles":[],"capabilities":[]}
 * (the task gets lost in a long context); the query belongs at the end.
 */
export function mapPrompt(window: string, part: number, total: number, maxA: number, maxC: number): string {
  return [
    `Below is transcript window ${part}/${total} of one long engineering work session (chronological, conversation only). ` +
      'Read all of it; your task follows after the transcript.',
    '<transcript>',
    window,
    '</transcript>',
    `TASK: extract candidate angles and capabilities from the transcript window above (${part}/${total}). ` +
      'A window this long normally contains several real accomplishments and root-caused bugs — scan the whole window, ' +
      'beginning to end, before answering. Return empty arrays only if there truly is nothing done/proven.',
    itemRules(maxA, maxC),
    QUOTE_RULES,
    'Output ONLY: {"angles": [...], "capabilities": [...]}',
  ].join('\n\n')
}

export function reducePrompt(candidatesJson: string, maxA: number, maxC: number): string {
  return [
    'Below are candidate angles and capabilities extracted window-by-window from ONE work session (quotes already verified). ' +
      `Merge duplicates (same work = one item, keep the most specific name), keep the strongest: at most ${maxA} angles and ${maxC} ` +
      'capabilities. Re-check every capability: drop it unless its quotes show it was shipped/verified or a root cause was proven.',
    itemRules(maxA, maxC),
    'Keep each item\'s quotes EXACTLY as given (copy text, timestamp and row unchanged); you may drop quotes, never edit them.',
    'Output: {"angles": [...], "capabilities": [...]}',
    '<candidates>',
    candidatesJson,
    '</candidates>',
  ].join('\n\n')
}

export interface ChatResult {
  content: string
  /** 'stop' normally; 'length' = output cap hit (JSON likely truncated). */
  finish: string
  provider: string
  promptTokens: number
  completionTokens: number
  costUsd: number
}

/** One chat call. Returns null when the budget refuses; throws on HTTP/timeout errors. */
export async function chat(budget: Budget, user: string, apiKey: string, maxOut = 16_000): Promise<ChatResult | null> {
  const estPrompt = Math.ceil((SYSTEM.length + user.length) / 4)
  if (!budget.take(estPrompt, maxOut)) return null
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS)
  try {
    const resp = await fetch(`${OPENROUTER}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: budget.info.id,
        temperature: 0.1,
        max_tokens: maxOut,
        // Reasoning OFF: measured on minimax-m3, effort:'low' still burned ~5k hidden
        // tokens of a 6k cap (finish=length, truncated JSON); enabled:false → 0, finish=stop.
        reasoning: { enabled: false },
        usage: { include: true },
        // Cheapest provider that fits the prompt (OpenRouter skips too-small contexts).
        provider: { sort: 'price' },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: user },
        ],
      }),
    })
    if (!resp.ok) throw new Error(`OpenRouter HTTP ${resp.status}`)
    const data: any = await resp.json()
    const pt = Number(data?.usage?.prompt_tokens) || estPrompt
    const ct = Number(data?.usage?.completion_tokens) || 0
    const reported = Number(data?.usage?.cost)
    const cost = Number.isFinite(reported) && reported > 0 ? reported : pt * budget.info.promptPerTok + ct * budget.info.completionPerTok
    budget.spentUsd += cost
    return {
      content: String(data?.choices?.[0]?.message?.content ?? ''),
      finish: String(data?.choices?.[0]?.finish_reason ?? ''),
      provider: String(data?.provider ?? ''),
      promptTokens: pt,
      completionTokens: ct,
      costUsd: cost,
    }
  } catch (err) {
    budget.failures++
    // A failed/timed-out call may still bill: charge the worst case so the cap stays hard.
    budget.spentUsd += budget.estimate(estPrompt, maxOut)
    throw err
  } finally {
    clearTimeout(timer)
  }
}
