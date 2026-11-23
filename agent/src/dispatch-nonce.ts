/**
 * Single-use approval nonces for POST /dispatch. The skill's command carries DISPATCH_PLACEHOLDER (agent-store.ts); the
 * PreToolUse hook asks, and only once canUseTool has approved that command is the placeholder swapped
 * for a fresh nonce. /dispatch accepts a nonce once and only while it is live, so a command that never
 * went through approval (any evasion, or a background spoke, which has no approval path) is refused.
 */
import { newCanvasKey, secretMatches } from './canvas-key.js'

export function createNonceStore(opts: { ttlMs?: number; cap?: number; now?: () => number } = {}) {
  const ttl = opts.ttlMs ?? 120_000, cap = opts.cap ?? 20, now = opts.now ?? Date.now
  const live = new Map<string, number>()
  const prune = () => { for (const [k, exp] of live) if (exp <= now()) live.delete(k) }
  return {
    mint(): string {
      prune()
      while (live.size >= cap) live.delete(live.keys().next().value as string)
      const k = newCanvasKey()
      live.set(k, now() + ttl)
      return k
    },
    /** True once for a live nonce; constant-time compare against every live one. */
    consume(got: string | null | undefined): boolean {
      prune()
      let hit: string | null = null
      for (const k of live.keys()) if (secretMatches(k, got)) hit = k
      if (hit) live.delete(hit)
      return !!hit
    },
  }
}
export const dispatchNonces = createNonceStore()
