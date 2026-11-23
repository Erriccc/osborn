/**
 * Sliding-window per-key limiter for /api/demo-access. Bounded: past maxKeys the least recently
 * used keys go first, so rotating keys cannot
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
      // Insertion order is last use, so the first key is the least recently used (and any expired one).
      while (hits.size > maxKeys) hits.delete(hits.keys().next().value!)
      return false
    },
    /** True when key is at the limit; records nothing. */
    atLimit(key: string, now = Date.now()): boolean {
      return (hits.get(key) ?? []).filter((t) => now - t < windowMs).length >= limit
    },
    size: () => hits.size,
  }
}
