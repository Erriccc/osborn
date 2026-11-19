/**
 * Sliding-window per-key limiter for /api/demo-access. Bounded: a key whose hits have all
 * expired is dropped, and past maxKeys the oldest keys go first, so rotating keys cannot
 * grow the map without limit.
 */
export function createRateLimiter({ limit, windowMs, maxKeys }: { limit: number; windowMs: number; maxKeys: number }) {
  const hits = new Map<string, number[]>()
  return {
    /** Records a hit for key; true when key is already at the limit (that hit is not counted). */
    limited(key: string, now = Date.now()): boolean {
      const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs)
      hits.delete(key)  // re-inserted below, so insertion order tracks the latest use
      if (recent.length >= limit) { hits.set(key, recent); return true }
      recent.push(now)
      hits.set(key, recent)
      if (hits.size > maxKeys) {
        hits.forEach((ts, k) => { if (!ts.some((t) => now - t < windowMs)) hits.delete(k) })
        Array.from(hits.keys()).slice(0, Math.max(0, hits.size - maxKeys)).forEach((k) => hits.delete(k))
      }
      return false
    },
    size: () => hits.size,
  }
}
