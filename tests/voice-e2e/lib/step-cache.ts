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
 * Once `signal` is aborted (the caller timed out) it never starts an action (#174).
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

/**
 * Runs `run` with a deadline, and fences it when the deadline passes (#174).
 * On timeout the signal aborts (no new observe or act starts) and `onTimeout`
 * runs (the engine closes that call's brain, which ends a call in flight). The
 * rejection then waits up to `settleMs` for the call to stop, so the caller's
 * action lock is held until the timed-out action has stopped, not just its
 * deadline. `stopped(false)` means it was still running when the wait ran out;
 * `onLate` hears what a timed-out call returned if it finished anyway.
 */
export async function fencedCall<T>(
  run: (signal: AbortSignal) => Promise<T>,
  o: { timeoutMs: number; settleMs: number; why: string; onTimeout?: () => void; stopped?: (stopped: boolean) => void; onLate?: (r: T) => void },
): Promise<T> {
  const fence = new AbortController()
  const call = run(fence.signal)
  const after = <V,>(ms: number, v: () => V) => { let t: ReturnType<typeof setTimeout> | undefined; return { p: new Promise<V>((r) => { t = setTimeout(() => r(v()), ms) }), clear: () => clearTimeout(t) } }
  const TIMEOUT = Symbol('timeout')
  const deadline = after(o.timeoutMs, () => TIMEOUT)
  const timedOut = new Error(o.why)
  try {
    const first = await Promise.race([call, deadline.p])
    if (first !== TIMEOUT) return first as T
  } finally { deadline.clear() }
  fence.abort(timedOut)
  call.then((r) => o.onLate?.(r), () => {})
  try { o.onTimeout?.() } catch { /* closing the brain must not mask the timeout */ }
  const grace = after(o.settleMs, () => false)
  const stopped = await Promise.race([call.then(() => true, () => true), grace.p])
  grace.clear()
  o.stopped?.(stopped)
  throw timedOut
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
