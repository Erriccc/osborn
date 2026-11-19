/**
 * content-llm.ts — Stage A's flags, spend caps and its ONE model-call path.
 * OpenRouter ONLY (OPENROUTER_API_KEY) — never the Claude subscription / Anthropic SDK.
 *
 * Flags:
 *   OSBORN_CONTENT_PIPELINE  default ON; 0/off/false/no = off. OSBORN_CONTENT_LENS=0 also turns it off.
 * Caps (a hit = status "capped", never an error):
 *   OSBORN_CONTENT_PERIOD_USD  default 0.75 (cumulative per period, kept in the content manifest)
 *   OSBORN_CONTENT_DAILY_USD   default 2.00 (UTC day, per MACHINE: $OSBORN_HOME or ~/.osborn/content-spend-ledger.json,
 *                              locked read-modify-write so concurrent workers across projects share one cap)
 *   OSBORN_CONTENT_MAX_PIECES  default 4 (1 highlight + up to 3 how-tos)
 *   OSBORN_LIBRARY_DAILY_USD   default 1.00 (UTC day, per MACHINE): the Library catch-up sweep's own cap
 *                              (period pages + daily digests), kept in the same ledger file under its
 *                              own key ("<day>:library"), so the sweep never uses the content step's cap
 * Every call reserves its WORST case (prompt + max output) against both caps up
 * front and writes it to the ledger before the fetch; it is reconciled to the
 * actual cost after. A failed call is charged the worst case, and a hard exit
 * mid-call leaves the worst case in the ledger, so the caps stay hard; such an
 * unsettled reservation expires with its UTC day (the ledger is keyed by day).
 * All outbound prompt text goes through the caller's scrub() first.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isContentLensEnabled } from './lens-launch.js'
import { withFileLock } from './lens-paths.js'

const OPENROUTER = 'https://openrouter.ai/api/v1'
const OFF = ['0', 'off', 'false', 'no']
export const LEDGER_FILE = 'content-spend-ledger.json'
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

/** OFF when OSBORN_CONTENT_PIPELINE, OSBORN_CONTENT_LENS or OSBORN_CONTENT_INGEST is 0/off/false/no: ingest off ⇒ no LLM spend at all. */
export function isContentPipelineEnabled(): boolean {
  if (!isContentLensEnabled()) return false
  const off = (k: string) => OFF.includes((process.env[k] ?? '').trim().toLowerCase())
  return !off('OSBORN_CONTENT_PIPELINE') && !off('OSBORN_CONTENT_INGEST')
}

/**
 * OSBORN_CONTENT_STRICT=1 restores hard blocks for the quality gates (structure,
 * over-length tolerance, missing stake, audience). Default: those are advisory —
 * the piece is still scripted and ingested as a draft with quality_flags attached.
 * Dev-voice, truth-check, redaction, the outbound-query gate and the caps are hard either way.
 */
export function isContentStrict(): boolean {
  return ['1', 'on', 'true', 'yes'].includes((process.env.OSBORN_CONTENT_STRICT ?? '').trim().toLowerCase())
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
  // Official names first; the plan's earlier names (…_PERIOD_CAP_USD / …_DAY_CAP_USD) are accepted as fallback aliases.
  return {
    periodUsd: envNum('OSBORN_CONTENT_PERIOD_USD', envNum('OSBORN_CONTENT_PERIOD_CAP_USD', 0.75)),
    dailyUsd: envNum('OSBORN_CONTENT_DAILY_USD', envNum('OSBORN_CONTENT_DAY_CAP_USD', 2.0)),
    maxPieces: Math.max(0, Math.floor(envNum('OSBORN_CONTENT_MAX_PIECES', 4))),
  }
}
export const genModel = (): string => (process.env.OSBORN_CONTENT_MODEL || '').trim() || DEFAULT_GEN_MODEL

const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10)

/** Machine-scoped ledger dir: $OSBORN_HOME, else ~/.osborn. The DAY cap is per machine, not per project. */
export function ledgerDir(): string {
  return (process.env.OSBORN_HOME || '').trim() || join(homedir(), '.osborn')
}
export const ledgerPath = (): string => join(ledgerDir(), LEDGER_FILE)

interface Ledger {
  days: Record<string, number>
}
function readLedgerAt(path: string): Ledger {
  try {
    const o = JSON.parse(readFileSync(path, 'utf-8'))
    if (o && typeof o.days === 'object' && !Array.isArray(o.days)) return { days: o.days }
  } catch {
    /* missing → empty */
  }
  return { days: {} }
}
/** The machine ledger (UTC day → USD). */
export function readLedger(): Ledger {
  return readLedgerAt(ledgerPath())
}
/** Spend recorded (incl. open reservations) on this machine today, across every project. */
export function daySpent(now = Date.now(), scope?: string): number {
  return Number(readLedger().days[ledgerKey(today(now), scope)]) || 0
}

/** The ledger key of a day: the content step's is the bare day; another spender's is "<day>:<scope>" (pruned with its day). */
const ledgerKey = (day: string, scope?: string): string => (scope ? `${day}:${scope}` : day)

/** The Library sweep's own daily cap (OSBORN_LIBRARY_DAILY_USD, default $1), on ledger scope LIBRARY_LEDGER_SCOPE. */
export const LIBRARY_LEDGER_SCOPE = 'library'
export const libraryDailyUsd = (): number => envNum('OSBORN_LIBRARY_DAILY_USD', 1.0)

const LOCK_TRIES = 40

/**
 * Atomic read-modify-write of the machine ledger under its lock file (withFileLock in
 * lens-paths.ts). `fn` returns the new ledger, or null to leave it unchanged.
 * Returns false when the lock could not be taken (callers decide fail-closed vs best-effort).
 */
function withLedger(fn: (l: Ledger) => Ledger | null, tries = LOCK_TRIES): boolean {
  const dir = ledgerDir()
  mkdirSync(dir, { recursive: true })
  const path = join(dir, LEDGER_FILE)
  return withFileLock(`${path}.lock`, () => {
    const next = fn(readLedgerAt(path))
    if (next) {
      const cutoff = today(Date.now() - 14 * 86_400_000)
      for (const k of Object.keys(next.days)) if (k < cutoff) delete next.days[k]
      const tmp = `${path}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf-8')
      renameSync(tmp, path)
    }
  }, tries)
}

export type CapKind = 'period' | 'day' | 'time'
export class CapError extends Error {
  constructor(readonly cap: CapKind, readonly needUsd: number) {
    super(`content cap reached (${cap})`)
  }
}

/** A worst-case amount already written to the machine ledger; settle() reconciles it to the actual cost. */
export interface Reservation {
  day: string
  usd: number
  inLedger: boolean
  settled: boolean
}

/**
 * Per-run spend guard: the per-period cap (cumulative, per project, in memory +
 * content manifest), the per-day cap (per MACHINE, in the locked ledger) and an
 * optional wall-clock deadline after which no new call starts.
 */
export class SpendGuard {
  runUsd = 0
  calls = 0
  capHit: CapKind | null = null
  constructor(
    /** Kept for callers/logs; the day ledger is machine-scoped, not under this dir. */
    readonly projectDir: string | null,
    readonly caps: ContentCaps,
    /** Spend already recorded for this period by earlier runs. */
    public periodUsd = 0,
    /** Epoch ms after which reserve() refuses new calls (CapError 'time'). */
    readonly deadline: number | null = null,
    /** Ledger key scope: none = the content step's daily cap; e.g. LIBRARY_LEDGER_SCOPE for the sweep. */
    readonly scope?: string,
  ) {}
  /**
   * Reserve a worst-case spend of `usd`: throws CapError if it would cross a cap
   * (or the deadline passed); otherwise writes it to the machine ledger BEFORE the
   * call, so a hard exit mid-call still counts it. Fails closed if the ledger lock
   * cannot be taken.
   */
  reserve(usd: number): Reservation {
    if (this.deadline !== null && Date.now() >= this.deadline) throw this.hit('time', usd)
    if (this.periodUsd + usd > this.caps.periodUsd) throw this.hit('period', usd)
    const day = ledgerKey(today(), this.scope)
    let over = false
    let locked: boolean
    try {
      locked = withLedger(l => {
        const cur = Number(l.days[day]) || 0
        if (cur + usd > this.caps.dailyUsd) {
          over = true
          return null
        }
        l.days[day] = Number((cur + usd).toFixed(6))
        return l
      })
    } catch {
      locked = false
    }
    if (over || !locked) throw this.hit('day', usd)
    return { day, usd, inLedger: true, settled: false }
  }
  private hit(cap: CapKind, usd: number): CapError {
    this.capHit = cap
    return new CapError(cap, usd)
  }
  /** Reconcile a reservation to the actual cost (once). The in-memory totals always move; the ledger is best-effort. */
  settle(r: Reservation, actualUsd: number): void {
    if (r.settled) return
    r.settled = true
    const usd = actualUsd > 0 ? actualUsd : 0
    this.runUsd += usd
    this.periodUsd += usd
    if (!r.inLedger) return
    const delta = usd - r.usd
    if (delta === 0) return
    try {
      // Long wait for the lock; if still held, write anyway — losing a reconcile would under-count (actual > worst).
      const apply = (l: Ledger) => {
        l.days[r.day] = Math.max(0, Number(((Number(l.days[r.day]) || 0) + delta).toFixed(6)))
        return l
      }
      if (!withLedger(apply, LOCK_TRIES * 4) && delta > 0) {
        const path = ledgerPath()
        const tmp = `${path}.${process.pid}.tmp`
        writeFileSync(tmp, JSON.stringify(apply(readLedgerAt(path)), null, 2) + '\n', 'utf-8')
        renameSync(tmp, path)
      }
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
  const res = o.guard.reserve(worst)
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
    o.guard.settle(res, cost)
    const provider = String(data?.provider ?? '')
    if (call.pin && provider !== call.pin.name) throw new Error(`${call.what}: served by ${provider || '?'}, expected pinned ${call.pin.name}`)
    const content = String(data?.choices?.[0]?.message?.content ?? '')
    return { content, json: parseJsonLoose(content), costUsd: cost, provider, model, finish: String(data?.choices?.[0]?.finish_reason ?? '') }
  } catch (e: any) {
    if (e instanceof CapError) throw e
    o.guard.settle(res, worst)
    throw e?.name === 'AbortError' ? new Error(`${call.what}: timeout`) : e
  } finally {
    clearTimeout(timer)
  }
}
