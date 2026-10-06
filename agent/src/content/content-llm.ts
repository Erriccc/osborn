/**
 * content-llm.ts — Stage A's flags, spend caps and its ONE model-call path.
 * OpenRouter ONLY (OPENROUTER_API_KEY) — never the Claude subscription / Anthropic SDK.
 *
 * Flags:
 *   OSBORN_CONTENT_PIPELINE  default ON; 0/off/false/no = off. OSBORN_CONTENT_LENS=0 also turns it off.
 * Caps (a hit = status "capped", never an error):
 *   OSBORN_CONTENT_PERIOD_USD  default 0.75 (cumulative per period, kept in the content manifest)
 *   OSBORN_CONTENT_DAILY_USD   default 2.00 (UTC day, ledger file in the project dir)
 *   OSBORN_CONTENT_MAX_PIECES  default 4 (1 highlight + up to 3 how-tos)
 * Every call reserves its WORST case (prompt + max output) against both caps up
 * front; a failed call is charged the worst case too, so the caps stay hard.
 * All outbound prompt text goes through the caller's scrub() first.
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isContentLensEnabled } from './lens-launch.js'

const OPENROUTER = 'https://openrouter.ai/api/v1'
const OFF = ['0', 'off', 'false', 'no']
export const LEDGER_FILE = '.content-spend-ledger.json'
export const DEFAULT_GEN_MODEL = 'minimax/minimax-m3'
/** Pinned judge (proven in videos-test-3/vt3-render.ts): model + provider endpoint, no fallbacks. */
export const CHECK_MODEL = 'deepseek/deepseek-chat'
export const CHECK_PROVIDER = 'deepinfra/fp4'
export const CHECK_PROVIDER_NAME = 'DeepInfra'
const CALL_TIMEOUT_MS = 4 * 60_000

/** USD per token. Unknown models get a deliberately high price so the cap still binds. */
const PRICES: Record<string, { p: number; c: number }> = {
  'minimax/minimax-m3': { p: 0.3e-6, c: 1.2e-6 },
  'deepseek/deepseek-chat': { p: 0.5e-6, c: 1.5e-6 },
}
const UNKNOWN_PRICE = { p: 3e-6, c: 15e-6 }
export const priceFor = (model: string) => PRICES[model] ?? UNKNOWN_PRICE

export function isContentPipelineEnabled(): boolean {
  if (!isContentLensEnabled()) return false
  return !OFF.includes((process.env.OSBORN_CONTENT_PIPELINE ?? '').trim().toLowerCase())
}

const envNum = (k: string, d: number): number => {
  const raw = (process.env[k] ?? '').trim()
  const n = Number(raw)
  return raw !== '' && Number.isFinite(n) && n >= 0 ? n : d
}

export interface ContentCaps {
  periodUsd: number
  dailyUsd: number
  maxPieces: number
}
export function contentCaps(): ContentCaps {
  return {
    periodUsd: envNum('OSBORN_CONTENT_PERIOD_USD', 0.75),
    dailyUsd: envNum('OSBORN_CONTENT_DAILY_USD', 2.0),
    maxPieces: Math.max(0, Math.floor(envNum('OSBORN_CONTENT_MAX_PIECES', 4))),
  }
}
export const genModel = (): string => (process.env.OSBORN_CONTENT_MODEL || '').trim() || DEFAULT_GEN_MODEL

const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10)

interface Ledger {
  days: Record<string, number>
}
export function readLedger(projectDir: string | null): Ledger {
  if (!projectDir) return { days: {} }
  try {
    const o = JSON.parse(readFileSync(join(projectDir, LEDGER_FILE), 'utf-8'))
    if (o && typeof o.days === 'object' && !Array.isArray(o.days)) return { days: o.days }
  } catch {
    /* missing → empty */
  }
  return { days: {} }
}
export function daySpent(projectDir: string | null, now = Date.now()): number {
  return Number(readLedger(projectDir).days[today(now)]) || 0
}

export class CapError extends Error {
  constructor(readonly cap: 'period' | 'day', readonly needUsd: number) {
    super(`content cap reached (${cap})`)
  }
}

/** Per-run spend guard over the per-period cap (cumulative) and the per-day ledger. */
export class SpendGuard {
  runUsd = 0
  calls = 0
  capHit: 'period' | 'day' | null = null
  constructor(
    readonly projectDir: string | null,
    readonly caps: ContentCaps,
    /** Spend already recorded for this period by earlier runs. */
    public periodUsd = 0,
  ) {}
  /** Throws CapError if a worst-case spend of `usd` would cross either cap. */
  reserve(usd: number): void {
    if (this.periodUsd + usd > this.caps.periodUsd) throw this.hit('period', usd)
    if (daySpent(this.projectDir) + usd > this.caps.dailyUsd) throw this.hit('day', usd)
  }
  private hit(cap: 'period' | 'day', usd: number): CapError {
    this.capHit = cap
    return new CapError(cap, usd)
  }
  record(usd: number): void {
    if (!(usd > 0)) return
    this.runUsd += usd
    this.periodUsd += usd
    if (!this.projectDir) return
    try {
      const l = readLedger(this.projectDir)
      const d = today()
      l.days[d] = Number(((Number(l.days[d]) || 0) + usd).toFixed(6))
      for (const k of Object.keys(l.days)) if (k < today(Date.now() - 14 * 86_400_000)) delete l.days[k]
      const path = join(this.projectDir, LEDGER_FILE)
      const tmp = `${path}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(l, null, 2) + '\n', 'utf-8')
      renameSync(tmp, path)
    } catch {
      /* ledger write failure never blocks; the in-memory guard still holds */
    }
  }
}

export interface LlmCall {
  /** Short tag for logs ("research", "script", "truth-check"...). Never the prompt. */
  what: string
  system: string
  user: string
  maxOut: number
  model?: string
  temperature?: number
  /** Pin provider: order=[endpoint], allow_fallbacks:false; the served provider must equal `name`. */
  pin?: { endpoint: string; name: string }
}
export interface LlmResult {
  content: string
  json: any
  costUsd: number
  provider: string
  model: string
  finish: string
}

/** Lenient JSON extraction: strips fences, takes the outermost {...} or [...]. Null when unparseable. */
export function parseJsonLoose(s: string): any {
  const t = String(s ?? '').replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  for (const [o, c] of [['{', '}'], ['[', ']']] as const) {
    const a = t.indexOf(o)
    const b = t.lastIndexOf(c)
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(t.slice(a, b + 1))
      } catch {
        /* try the other shape */
      }
    }
  }
  return null
}

export interface ContentLlmOptions {
  apiKey: string
  guard: SpendGuard
  scrub: (s: string) => string
  fetchImpl?: typeof fetch
  log?: (m: string) => void
}

/** One chat call → JSON. Throws CapError on a cap, Error on HTTP/timeout/provider mismatch. */
export async function llmJson(o: ContentLlmOptions, call: LlmCall): Promise<LlmResult> {
  const model = call.model ?? genModel()
  const system = o.scrub(call.system)
  const user = o.scrub(call.user)
  const price = priceFor(model)
  const estPrompt = Math.ceil((system.length + user.length) / 3.5)
  const worst = estPrompt * price.p + call.maxOut * price.c
  o.guard.reserve(worst)
  o.guard.calls++
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS)
  try {
    const body: Record<string, unknown> = {
      model,
      temperature: call.temperature ?? 0.2,
      max_tokens: call.maxOut,
      usage: { include: true },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      provider: call.pin ? { order: [call.pin.endpoint], allow_fallbacks: false } : { sort: 'price' },
    }
    if (!call.pin) body.reasoning = { enabled: false }
    const resp = await (o.fetchImpl ?? fetch)(`${OPENROUTER}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${o.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!resp.ok) throw new Error(`OpenRouter HTTP ${resp.status}`)
    const data: any = await resp.json()
    const pt = Number(data?.usage?.prompt_tokens) || estPrompt
    const ct = Number(data?.usage?.completion_tokens) || 0
    const reported = Number(data?.usage?.cost)
    const cost = Number.isFinite(reported) && reported > 0 ? reported : pt * price.p + ct * price.c
    o.guard.record(cost)
    const provider = String(data?.provider ?? '')
    if (call.pin && provider !== call.pin.name) throw new Error(`${call.what}: served by ${provider || '?'}, expected pinned ${call.pin.name}`)
    const content = String(data?.choices?.[0]?.message?.content ?? '')
    return { content, json: parseJsonLoose(content), costUsd: cost, provider, model, finish: String(data?.choices?.[0]?.finish_reason ?? '') }
  } catch (e: any) {
    if (e instanceof CapError) throw e
    if (!/served by/.test(String(e?.message))) o.guard.record(worst)
    throw e?.name === 'AbortError' ? new Error(`${call.what}: timeout`) : e
  } finally {
    clearTimeout(timer)
  }
}
