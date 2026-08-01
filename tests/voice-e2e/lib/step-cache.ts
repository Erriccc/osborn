import type { Page } from '@playwright/test'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

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

/**
 * Cached natural-language action. Drop-in for `stagehand.act(instruction)`.
 * `stagehand` needs `.observe(instruction)` and `.act(actionOrInstruction)`.
 */
export async function actWithCache(
  stagehand: { observe: (i: string) => Promise<any>; act: (a: any) => Promise<any> },
  page: Page,
  instruction: string,
): Promise<{ cached: boolean; healed: boolean }> {
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

  if (hit?.action) {
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
      try {
        await stagehand.act(hit.action)
        hit.hits += 1
        hit.lastUsedAt = new Date().toISOString()
        saveStore(url.hostname, store)
        console.log(`[step-cache] HIT (${url.hostname}) — 0 LLM calls: "${instruction.slice(0, 60)}"`)
        return { cached: true, healed: false }
      } catch {
        console.log(`[step-cache] cached action broke — re-resolving via LLM (self-heal)`)
      }
    }
  }

  const observed = await stagehand.observe(instruction)
  const action = Array.isArray(observed) ? observed[0] : observed
  if (!action) {
    // Conditional instructions ("if X ... otherwise do nothing") legitimately
    // resolve to no action — that's a no-op, not a failure. If the action was
    // truly required, downstream assertions catch its absence.
    console.log(`[step-cache] NO-OP (${url.hostname}) — nothing to do for: "${instruction.slice(0, 60)}"`)
    return { cached: false, healed: false }
  }
  await stagehand.act(action)
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
  return { cached: false, healed: !!hit }
}
