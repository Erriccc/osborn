/**
 * POST /dispatch access: single-use approval nonces bound to the approved body, who may call the route,
 * and the own-API Bash allowance that must never cover a dispatch. The command shape is dispatch-command.ts.
 * The skill's command carries a placeholder; the PreToolUse hook asks, and only once canUseTool has approved
 * that exact command is the placeholder swapped for a nonce for that body. /dispatch accepts a nonce once,
 * while live, for the same body. A command that skipped approval, or a background spoke (no approval path), has none.
 */
import { newCanvasKey, secretMatches } from './canvas-key.js'
import { jsonRefusal, localNoBrowser } from './agent-store.js'
import { hasDispatchPlaceholder } from './dispatch-command.js'

export function createNonceStore(opts: { ttlMs?: number; cap?: number; now?: () => number } = {}) {
  const ttl = opts.ttlMs ?? 120_000, cap = opts.cap ?? 20, now = opts.now ?? Date.now
  const live = new Map<string, { exp: number; hash: string }>()
  const prune = () => { for (const [k, v] of live) if (v.exp <= now()) live.delete(k) }
  return {
    mint(bodyHash: string): string {
      prune()
      while (live.size >= cap) live.delete(live.keys().next().value as string)
      const k = newCanvasKey()
      live.set(k, { exp: now() + ttl, hash: bodyHash })
      return k
    },
    /** True once for a live nonce minted for this body (constant-time compare). A wrong body is refused and does not burn it. */
    consume(got: string | null | undefined, bodyHash: string): boolean {
      prune()
      let hit: string | null = null
      for (const [k, v] of live) if (secretMatches(k, got) && v.hash === bodyHash) hit = k
      if (hit) live.delete(hit)
      return !!hit
    },
  }
}
export const dispatchNonces = createNonceStore()

/** Refusal for POST /dispatch before its key is checked, or null: a loopback request, not forwarded, from no
 *  browser page, sending JSON. (The token gate, unauthorized(), has already run.) */
export function dispatchRefusal(r: { forwarded: boolean; host?: string; remote?: string; origin?: string; contentType?: string }): { status: number; error: string } | null {
  if (!localNoBrowser(r)) return { status: 403, error: 'dispatch only takes a request from this machine, not from a browser page' }
  return jsonRefusal(r.contentType)
}

export const DISPATCH_KEY_REFUSAL = { status: 403, error: 'dispatch needs the one-time key of a command the user approved, for this exact request' }

/** The agent's own localhost API a spoken reply may curl without a dialog (canvas/tts/noise-cancel),
 *  never a command carrying the dispatch placeholder (that always goes to the approval dialog). */
export function isOwnApiCurl(cmd: string): boolean {
  return /^\s*curl\b[^;&|]*https?:\/\/(localhost|127\.0\.0\.1):\d+\/(canvas|tts|noise-cancel)\b/.test(cmd) && !/[;&|]/.test(cmd) && !hasDispatchPlaceholder(cmd)
}
