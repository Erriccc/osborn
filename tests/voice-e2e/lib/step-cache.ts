import type { Page } from '@playwright/test'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { redactJson } from './devtools'

/**
 * Self-healing action cache + per-site knowledge profiles.
 *
 * The lifecycle (industry-standard "NL source → compiled execution → LLM
 * repair" pattern):
 *   1. First run: `observe(instruction)` — the LLM resolves the intent into a
 *      concrete action (selector + method) WITHOUT executing; we act on it
 *      and CACHE it.
 *   2. Later runs: replay the cached action directly — zero LLM calls,
 *      faster, deterministic, free.
 *   3. When the UI changes and the cached action throws: fall back to the
 *      LLM, re-resolve, overwrite the cache. Self-healing.
 *
 * Cache lives in knowledge/<hostname>/actions.json — one folder per site,
 * so an agent accumulates a PROFILE of every site it works with. The folder
 * is portable: commit it, ship it with a skill, or mount it on a tester
 * machine's volume (OSBORN_KNOWLEDGE_DIR) so knowledge persists across runs.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const KNOWLEDGE_DIR = process.env.OSBORN_KNOWLEDGE_DIR || join(__dirname, '..', 'knowledge')

type CachedAction = {
  instruction: string
  path: string
  action: unknown
  // Fingerprint of the target element (aria-label|text) captured at resolve
  // time. Replay validates it: a selector that still MATCHES but now points
  // at a DIFFERENT element (UI redesign) must re-resolve, not false-ok —
  // 2026-08-01 a redesigned header made cached clicks "succeed" on nothing.
  target?: string | null
  resolvedAt: string
  lastUsedAt?: string
  hits: number
  heals: number
}

function siteFile(hostname: string): string {
  const dir = join(KNOWLEDGE_DIR, hostname)
  mkdirSync(dir, { recursive: true })
  const notes = join(dir, 'site.md')
  if (!existsSync(notes)) {
    writeFileSync(notes, `# ${hostname} — agent site profile\n\nCreated ${new Date().toISOString()}. Cached actions live in actions.json; append observations about this site (quirks, timing, auth flows) here.\n`)
  }
  return join(dir, 'actions.json')
}

function loadStore(hostname: string): Record<string, CachedAction> {
  const f = siteFile(hostname)
  if (!existsSync(f)) return {}
  try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return {} }
}

function saveStore(hostname: string, store: Record<string, CachedAction>) {
  writeFileSync(siteFile(hostname), JSON.stringify(store, null, 2))
}

type BrainLike = {
  observe: (i: string, o?: { page?: unknown }) => Promise<any>
  act: (a: any, o?: { page?: unknown }) => Promise<any>
  context?: { pages(): Array<{ targetId(): string }> }
}

// Stagehand's own page object for a Playwright page, found once per page. Handing
// Stagehand the Playwright page instead makes it open a CDP session on every call
// and never close it, which piles up over hundreds of /act on one tab.
const brainPages = new WeakMap<Page, { targetId(): string }>()
async function brainPageFor(stagehand: BrainLike, page: Page): Promise<{ targetId(): string } | undefined> {
  const pages = stagehand.context?.pages?.()
  if (!Array.isArray(pages)) return undefined
  const known = brainPages.get(page)
  if (known && pages.includes(known)) return known  // a re-initialized brain has new page objects
  let cdp: Awaited<ReturnType<ReturnType<Page['context']>['newCDPSession']>> | undefined
  try {
    cdp = await page.context().newCDPSession(page)
    const { targetInfo } = await cdp.send('Target.getTargetInfo')
    const found = pages.find((p) => p.targetId() === targetInfo.targetId)
    if (found) brainPages.set(page, found)
    return found
  } catch { return undefined } finally { await cdp?.detach().catch(() => {}) }
}

/**
 * Cached natural-language action. Drop-in for `stagehand.act(instruction)`.
 * `stagehand` needs `.observe(instruction)` and `.act(actionOrInstruction)`.
 * It acts on `page`; if Stagehand cannot find that page it acts on its own active page.
 * Once `signal` is aborted (the caller timed out) it never starts an action (#174),
 * and an action that finishes after that writes nothing to the cache (#421).
 */
export async function actWithCache(
  stagehand: BrainLike,
  page: Page,
  instruction: string,
  signal?: AbortSignal,
): Promise<{ cached: boolean; healed: boolean; noop?: boolean; did?: string | null }> {
  const brainPage = await brainPageFor(stagehand, page)
  const on = brainPage ? { page: brainPage } : undefined
  const url = new URL(page.url())
  const key = `${url.pathname} :: ${instruction}`
  const store = loadStore(url.hostname)
  const hit = store[key]
  // A late finish is not a trusted recipe: its store snapshot is stale and its result unverified.
  const fenced = () => !!signal?.aborted

  const describeTarget = async (sel: string): Promise<string | null> => {
    try {
      const loc = page.locator(sel).first()
      if ((await loc.count()) === 0) return null
      const a = await loc.getAttribute('aria-label').catch(() => null)
      const t = await loc.textContent().catch(() => '')
      return `${(a ?? '').trim()}|${(t ?? '').trim().slice(0, 60)}`
    } catch { return null }
  }

  // An entry holding a secret (cached before this rule) is dropped, never replayed.
  if (hit && holdsSecret({ key, action: hit.action })) { delete store[key]; saveStore(url.hostname, store) }
  else if (hit?.action) {
    // Validate before replay: selector must still exist AND still point at
    // the same element (fingerprint match). Otherwise fall through to the
    // LLM — never trust a click on an unverified target.
    const sel = (hit.action as { selector?: string })?.selector
    let valid = true
    if (sel) {
      const now = await describeTarget(sel)
      if (now === null) { valid = false; console.log(`[step-cache] cached selector GONE (UI changed) — re-resolving: "${instruction.slice(0, 50)}"`) }
      else if (hit.target && now !== hit.target) { valid = false; console.log(`[step-cache] cached target CHANGED ("${hit.target}" → "${now}") — re-resolving`) }
    }
    if (valid) {
      signal?.throwIfAborted()
      try {
        await stagehand.act(hit.action, on)
        if (fenced()) return { cached: true, healed: false, did: describeAction(hit.action) }
        hit.hits += 1
        hit.lastUsedAt = new Date().toISOString()
        saveStore(url.hostname, store)
        console.log(`[step-cache] HIT (${url.hostname}) — 0 LLM calls: "${instruction.slice(0, 60)}"`)
        return { cached: true, healed: false, did: describeAction(hit.action) }
      } catch {
        console.log(`[step-cache] cached action broke — re-resolving via LLM (self-heal)`)
      }
    }
  }

  signal?.throwIfAborted()
  const observed = await stagehand.observe(instruction, on)
  const action = Array.isArray(observed) ? observed[0] : observed
  if (!action) {
    // Conditional instructions ("if X ... otherwise do nothing") legitimately
    // resolve to no action — that's a no-op, not a failure. If the action was
    // truly required, downstream assertions catch its absence.
    console.log(`[step-cache] NO-OP (${url.hostname}) — nothing to do for: "${instruction.slice(0, 60)}"`)
    return { cached: false, healed: false, noop: true, did: null }
  }
  signal?.throwIfAborted()
  await stagehand.act(action, on)
  if (fenced()) return { cached: false, healed: false, did: describeAction(action) }
  // A step carrying a secret is never written into the shareable cache.
  if (holdsSecret({ key, action })) {
    if (hit) { delete store[key]; saveStore(url.hostname, store) }
    return { cached: false, healed: false, did: describeAction(action) }
  }
  const newSel = (action as { selector?: string })?.selector
  store[key] = {
    instruction,
    path: url.pathname,
    action,
    target: newSel ? await describeTarget(newSel) : null,
    resolvedAt: new Date().toISOString(),
    hits: 0,
    heals: (hit?.heals ?? 0) + (hit ? 1 : 0),
  }
  saveStore(url.hostname, store)
  console.log(`[step-cache] ${hit ? 'HEALED' : 'MISS'} (${url.hostname}) — resolved + cached: "${instruction.slice(0, 60)}"`)
  return { cached: false, healed: !!hit, did: describeAction(action) }
}

/** Settles with `p`, or rejects with `why` after `ms` (the timer is always cleared). */
export const withTimeout = <T,>(p: Promise<T>, ms: number, why: string | Error): Promise<T> => {
  let t: ReturnType<typeof setTimeout> | undefined
  return Promise.race([p, new Promise<never>((_, rej) => { t = setTimeout(() => rej(typeof why === 'string' ? new Error(why) : why), ms) })]).finally(() => clearTimeout(t))
}

/** How a timed-out call ended: `stopped` (at a fence check before acting, or cut
 *  off by its brain closing), `late` (it settled after the deadline some other
 *  way and may have acted, whether it returned or threw), or still `running`
 *  when the settle wait ran out. */
export type FencedEnd = 'stopped' | 'late' | 'running'

/** An error a brain call throws when its brain or browser connection is gone. */
export const BRAIN_GONE = /uninitialized|detached|closed|Target/i

/**
 * Runs `run` with a deadline, and fences it when the deadline passes (#174, #421).
 * On timeout the signal aborts (no new observe or act starts) and `onTimeout`
 * runs (the engine closes that call's brain, which ends a call in flight). The
 * rejection then waits up to `settleMs` for the call AND `onTimeout`'s promise,
 * so the caller's action lock is held until the timed-out action has stopped.
 * `settled` says how it ended and whether `onTimeout` finished; `onLate` hears a
 * late result or error. A call still `running` is the next caller's to wait out
 * (`zombieGate`).
 */
export async function fencedCall<T>(
  run: (signal: AbortSignal) => Promise<T>,
  o: {
    timeoutMs: number; settleMs: number; why: string
    onTimeout?: (call: Promise<T>) => unknown
    settled?: (end: FencedEnd, closed: boolean) => void
    onLate?: (late: { ok: true; value: T } | { ok: false; error: unknown }) => void
  },
): Promise<T> {
  const fence = new AbortController()
  const call = run(fence.signal)
  const timedOut = new Error(o.why)
  try { return await withTimeout(call, o.timeoutMs, timedOut) }
  catch (e) { if (e !== timedOut) throw e }
  fence.abort(timedOut)
  let end: FencedEnd = 'running'
  let closed = false
  let cutOff = false  // onTimeout's close finished: the call can no longer act
  const callDone = call.then(
    (value) => { end = 'late'; o.onLate?.({ ok: true, value }) },
    (error) => {
      // The fence's own abort, or the brain close cutting the call off.
      if (error === timedOut || cutOff || BRAIN_GONE.test(String((error as Error)?.message ?? error))) end = 'stopped'
      else { end = 'late'; o.onLate?.({ ok: false, error }) }
    },
  )
  let ran: unknown
  try { ran = o.onTimeout?.(call) } catch (e) { ran = Promise.reject(e) }  // must not mask the timeout
  const closes = typeof (ran as Promise<unknown>)?.then === 'function'  // only a returned close can cut the call off
  const closing = Promise.resolve(ran).then(() => { closed = true; cutOff = closes }, () => { closed = true })
  await withTimeout(Promise.all([callDone, closing]), o.settleMs, 'still running').catch(() => {})
  o.settled?.(end, closed)
  throw timedOut
}

/**
 * Timed-out calls still running past their settle wait (#421). The next brain
 * call, or a brain re-init, `wait`s for them before touching the page, and is
 * refused with a clear error if they have not settled within its budget, so it
 * never runs alongside one. A zombie is gone once its call settles or its brain
 * has closed (`closed` resolves: its CDP connection is gone, it cannot act), and
 * one older than `maxAgeMs` is dropped (`onDrop`), so a call that never settles
 * cannot block the brain for good.
 */
export function zombieGate(o: { maxAgeMs?: number; onDrop?: (ageMs: number) => void } = {}) {
  const zombies = new Set<{ gone: Promise<void>; since: number }>()
  return {
    track(call: Promise<unknown>, closed?: Promise<unknown>): void {
      const closeDone = closed?.then(() => {}, () => new Promise<void>(() => {}))  // a failed close leaves it able to act
      const z = { gone: (closeDone ? Promise.race([call, closeDone]) : call).then(() => {}, () => {}), since: Date.now() }
      zombies.add(z)
      void z.gone.then(() => zombies.delete(z))
    },
    get pending(): boolean { return zombies.size > 0 },
    async wait(budgetMs: number, what: string): Promise<void> {
      for (const z of zombies) {
        const age = Date.now() - z.since
        if (o.maxAgeMs && age > o.maxAgeMs) { zombies.delete(z); o.onDrop?.(age) }
      }
      if (!zombies.size) return
      const ms = Math.max(0, budgetMs)
      if (!(await withTimeout(Promise.all([...zombies].map((z) => z.gone)).then(() => true), ms, 'zombie').catch(() => false)))
        throw new Error(`${what} refused: a timed-out brain call was still running after another ${Math.round(ms / 1000)}s and could still act on the page — retry shortly`)
    },
  }
}

/** True when redaction would change it, or it types into a password field:
 *  such a step stays out of actions.json. */
export const holdsSecret = (v: { key?: string; action?: any }): boolean =>
  redactJson(v) !== JSON.stringify(v) ||
  (/^(fill|type)$/.test(v.action?.method ?? '') && /passw/i.test(`${v.action?.description ?? ''} ${v.key ?? ''}`))

/** What the brain decided to do, in one line — returned to the director. */
function describeAction(action: any): string | null {
  if (!action || typeof action !== 'object') return null
  const parts = [action.method, action.description, Array.isArray(action.arguments) && action.arguments.length ? `(${action.arguments.join(', ').slice(0, 60)})` : null].filter(Boolean)
  return parts.length ? parts.join(' ').slice(0, 200) : null
}

/** Drop a cached recipe (called when replaying or resolving it had no visible effect). */
export function forgetCached(pageUrl: string, instruction: string): void {
  try {
    const url = new URL(pageUrl)
    const store = loadStore(url.hostname)
    const key = `${url.pathname} :: ${instruction}`
    if (store[key]) { delete store[key]; saveStore(url.hostname, store); console.log(`[step-cache] FORGOT (no visible effect): "${instruction.slice(0, 60)}"`) }
  } catch { /* ignore */ }
}
