/**
 * slot-manager.ts: bookkeeping for headless background session slots.
 *
 * The voice agent (index.ts) can run up to N extra Claude sessions in the
 * background ("slots"). This module owns the parts that don't need the room,
 * the voice session or a real Claude subprocess, so they can be tested:
 *   - buildSlotEnv: the environment a slot's subprocess gets (no platform secrets)
 *   - maxBgSlots / capError: the slot cap (default 2, OSBORN_MAX_BG_SLOTS overrides)
 *   - SlotRegistry: admit / add / remove / findKey / list / releaseAll
 *   - cleanUpSlotOnFailure: a slot whose consumer dies or whose resume fails is
 *     dropped from the registry (and aborted) so it stops holding a cap seat
 *
 * index.ts still builds the ClaudeLLM and wires its events; the LLM is injected
 * here as an opaque object with optional abort hooks.
 */

import type { EventEmitter } from 'node:events'

// ── Slot env ────────────────────────────────────────────────────────────────

/**
 * Platform credentials (from env-keys.ts AGENT_ENV_KEYS) that only the voice agent process uses,
 * so a background slot never needs them. Exact names; the patterns below catch more.
 * Not stripped: user secrets (USER_SECRET_KEYS, e.g. RECALL_API_KEY), model keys, and a GitHub
 * token (spokes keep one: design local-hub-spoke-reasoner, "Env allow-list").
 */
export const SLOT_ENV_DENY: ReadonlySet<string> = new Set([
  'OSBORN_SYNC_TOKEN',
  'LIVEKIT_API_SECRET',
  'LIVEKIT_API_KEY',
  'PUSHOVER_TOKEN',
  'PUSHOVER_USER_KEY',
  'NTFY_TOKEN',
  'SMITHERY_API_KEY',
])

/**
 * Name patterns stripped from a slot's env. The frontend's MACHINE_ENV_DENYLIST keeps the Fly and
 * Supabase admin keys off provisioned machines; these cover an agent run anywhere else (dotenv).
 * Supabase: everything except the public URL and anon key.
 */
export const SLOT_ENV_DENY_PATTERNS: readonly RegExp[] = [
  /^FLY_.*TOKEN/i,
  /^SUPABASE_(?!URL$|ANON_KEY$)/i,
  /SECRET|PRIVATE_KEY/i,
]

/** True if `key` must not reach a background slot's subprocess. */
export function isSlotEnvDenied(key: string): boolean {
  if (SLOT_ENV_DENY.has(key.toUpperCase())) return true
  return SLOT_ENV_DENY_PATTERNS.some((re) => re.test(key))
}

/**
 * The env for a background slot's Claude subprocess: a copy of `baseEnv` minus
 * platform secrets, plus the two flags every slot needs.
 * - CLAUDE_CODE_DISABLE_AUTO_MEMORY=1: concurrent subprocesses must not race the
 *   shared ~/.claude/CLAUDE.md memory file.
 * - IS_SANDBOX=1: Claude Code refuses bypassPermissions as root, and Fly machines
 *   run Osborn as root. Set on the child copy only; `baseEnv` is never mutated.
 */
export function buildSlotEnv(baseEnv: NodeJS.ProcessEnv | Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(baseEnv)) {
    if (v === undefined || isSlotEnvDenied(k)) continue
    env[k] = v
  }
  env['CLAUDE_CODE_DISABLE_AUTO_MEMORY'] = '1'
  env['IS_SANDBOX'] = '1'
  return env
}

// ── Cap ─────────────────────────────────────────────────────────────────────

/** Background slots allowed besides the focused session (focused + 2 = 3 Claude processes). */
export const DEFAULT_MAX_BG_SLOTS = 2

/** Hard ceiling on OSBORN_MAX_BG_SLOTS: an 8 GB machine has heap-OOM'd under many Claude processes. */
export const MAX_BG_SLOTS_CEILING = 8

/** The slot cap: OSBORN_MAX_BG_SLOTS when it is a whole number >= 0 (at most MAX_BG_SLOTS_CEILING), else DEFAULT_MAX_BG_SLOTS. */
export function maxBgSlots(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): number {
  const raw = (env.OSBORN_MAX_BG_SLOTS ?? '').trim()
  if (!/^\d+$/.test(raw)) return DEFAULT_MAX_BG_SLOTS
  return Math.min(Number(raw), MAX_BG_SLOTS_CEILING)
}

/** The cap-reached error, or null when another slot fits. Same text the agent has always sent. */
export function capError(inUse: number, max: number): string | null {
  if (inUse < max) return null
  return `Background session cap reached (${inUse}/${max} slots in use). Kill an existing background slot before spawning a new one.`
}

// ── Registry ────────────────────────────────────────────────────────────────

/** The parts of a ClaudeLLM the registry touches. */
export interface SlotLLM {
  abortQuery?: () => unknown
  abortAgent?: () => unknown
  hasSession?: () => boolean
}

export interface SessionSlot<L extends SlotLLM = SlotLLM> {
  id: string
  llm: L
  isFocused: boolean
  workingDir: string
  emitter?: EventEmitter
  sdkOptions?: any
  dispatchInFlight?: boolean
  kickoffDone?: boolean  // the [BACKGROUND_INIT] ack's assistant_result has been consumed
  reportPending?: boolean  // a dispatch is waiting to report back to the hub
  released?: boolean  // dropped on purpose (hang-up, teardown, a stop), not by a failure
}

export interface SlotListEntry { id: string; isFocused: boolean; workingDir: string; hasSession: boolean }

/** `ok` false carries why and the message the frontend gets. (A flat shape: the agent builds without strictNullChecks, so a union wouldn't narrow.) */
export interface AdmitResult {
  ok: boolean
  reason?: 'cap' | 'duplicate' | 'foreground'
  error?: string
}

export interface SlotRegistryOptions {
  /** Cap on background slots. A function is read on every admit. Default: maxBgSlots(). */
  max?: number | (() => number)
  /** The live foreground session id; it can never become a slot (two writers on one JSONL). */
  foregroundId?: () => string | null | undefined
}

/** Abort a slot's subprocess. Never throws. */
export function abortSlot(slot: SessionSlot<any>): void {
  try { slot.llm?.abortQuery?.(); slot.llm?.abortAgent?.() } catch {}
}

/**
 * Background slots, keyed by session id. A spawn asks admit(id) before it builds
 * the LLM and add()s the slot right after, with nothing awaited in between.
 */
export class SlotRegistry<S extends SessionSlot<any> = SessionSlot> {
  #slots = new Map<string, S>()
  #max: () => number
  #foregroundId: () => string | null | undefined

  constructor(opts: SlotRegistryOptions = {}) {
    const m = opts.max
    this.#max = typeof m === 'function' ? m : typeof m === 'number' ? () => m : () => maxBgSlots()
    this.#foregroundId = opts.foregroundId ?? (() => null)
  }

  get max(): number { return this.#max() }
  get size(): number { return this.#slots.size }

  has(id: string): boolean { return this.#slots.has(id) }
  get(id: string): S | undefined { return this.#slots.get(id) }
  values(): S[] { return [...this.#slots.values()] }

  /** Exact id, else a slot whose id is a prefix of `id` or has `id` as a prefix (8-char row ids). */
  findKey(id: string): string | undefined {
    if (this.#slots.has(id)) return id
    return [...this.#slots.keys()].find((k) => k.startsWith(id) || id.startsWith(k))
  }

  /** Whether `id` may become a slot now: not the foreground session, not already a slot, under the cap. */
  admit(id: string): AdmitResult {
    const fg = this.#foregroundId()
    if (fg && id === fg) {
      return { ok: false, reason: 'foreground', error: `Session ${id.substring(0, 8)} is the active foreground session — pick a different session to background` }
    }
    if (this.#slots.has(id)) {
      return { ok: false, reason: 'duplicate', error: `Session ${id.substring(0, 8)} is already running as a background slot` }
    }
    const err = capError(this.#slots.size, this.#max())
    if (err) return { ok: false, reason: 'cap', error: err }
    return { ok: true }
  }

  /** Store an admitted slot. */
  add(slot: S): S {
    this.#slots.set(slot.id, slot)
    return slot
  }

  /**
   * Abort and drop a slot. With `only`, removes it only if the registered slot
   * is that exact object (a late error from a stopped slot can't kill a newer
   * slot that reused the id). Returns the removed slot.
   */
  remove(id: string, only?: S): S | undefined {
    const slot = this.#slots.get(id)
    if (!slot || (only && slot !== only)) return undefined
    this.#slots.delete(id)
    if (!only) slot.released = true
    abortSlot(slot)
    return slot
  }

  /** Abort every slot and clear the registry (session end). */
  releaseAll(): void {
    for (const s of this.#slots.values()) { s.released = true; abortSlot(s) }
    this.#slots.clear()
  }

  /** Rows for the slots_list message. */
  list(): SlotListEntry[] {
    return [...this.#slots.values()].map((s) => ({
      id: s.id,
      isFocused: s.isFocused,
      workingDir: s.workingDir,
      hasSession: s.llm?.hasSession?.() ?? false,
    }))
  }
}

// ── Dead-slot cleanup ───────────────────────────────────────────────────────

export interface SlotFailure {
  kind: 'consumer_error' | 'session_resume_failed'
  /** What the frontend is told (background_session_error.error). */
  error: string
  data: any
}

/**
 * When the slot's subprocess dies (consumer_error) or resumes the wrong session
 * (session_resume_failed), abort it and drop it from the registry so it stops
 * holding a cap seat, then call `onDead` (which sends background_session_error).
 * `onDead` runs even if the slot was already gone, so the frontend still hears.
 */
export function cleanUpSlotOnFailure<S extends SessionSlot<any>>(
  emitter: EventEmitter,
  registry: SlotRegistry<S>,
  slot: S,
  onDead: (f: SlotFailure) => void,
): void {
  emitter.on('consumer_error', (data: any) => {
    registry.remove(slot.id, slot)
    onDead({ kind: 'consumer_error', error: String(data?.message || 'Background session failed to start'), data })
  })
  emitter.on('session_resume_failed', (data: any) => {
    registry.remove(slot.id, slot)
    onDead({ kind: 'session_resume_failed', error: 'Session resume failed', data })
  })
}
