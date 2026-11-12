// ============================================================
// OPTIMISTIC TRANSCRIPT CACHE (#136 / #71) — pure, client-safe
// ============================================================
// On reload or re-entry the resumed session's history only replays AFTER the
// agent's reconnect completes, and that connect hits a cold (idle-stopped)
// machine that can take 60-90s to come up. Until then the main pane shows only
// the agent's "Welcome back!" greeting — the transcript is delayed, not lost
// (#136/#143). To stop the user staring at a greeting-only pane, we keep each
// session's rendered transcript in localStorage and repaint it INSTANTLY on
// reload (flagged `fromCache`), then the authoritative /session-messages fetch
// — or the data-channel `prior_messages` push — REPLACES it when it lands.
//
// The cache is a convenience, never a source of truth: it holds only what the
// agent would re-serve anyway, it is always reconciled against the live replay,
// and it is cleared on sign-out. All reads/writes are wrapped so a blocked or
// full localStorage degrades to "no cache" rather than throwing.

export const TRANSCRIPT_CACHE_PREFIX = 'vn-chat-transcript'

// Keep the footprint small: at most the last N sessions, the last N items of
// each, and a per-item content cap (a long paste should not blow the quota).
const MAX_SESSIONS = 8
const MAX_ITEMS = 60
const MAX_CONTENT = 4000

/** Minimal Storage surface — satisfied by window.localStorage and by test fakes. */
export interface CacheStorage {
  readonly length: number
  key(i: number): string | null
  getItem(k: string): string | null
  setItem(k: string, v: string): void
  removeItem(k: string): void
}

/** A message as cached (JSON-serializable). `compaction` is passed through
 * opaquely so a "Conversation compacted" marker survives a reload. */
export interface CachedMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  /** ISO timestamp, or null when unknown. */
  ts: string | null
  compaction?: unknown
}

/** The shape this cache reads off a live transcript message (structural — the
 * component's ChatMessage satisfies it without importing the UI type here). */
export interface TranscriptInput {
  id: string
  role: 'user' | 'assistant' | 'system'
  content?: string
  timestamp?: Date | string | number | null
  compaction?: unknown
  isStreaming?: boolean
  fromCache?: boolean
}

interface CacheEntry {
  /** When this entry was last written (ms) — drives LRU eviction. */
  at: number
  items: CachedMessage[]
}

function keyFor(sessionId: string): string {
  return `${TRANSCRIPT_CACHE_PREFIX}:${sessionId}`
}

function tsToIso(t: Date | string | number | null | undefined): string | null {
  if (t == null) return null
  const d = t instanceof Date ? t : new Date(t)
  const ms = d.getTime()
  return Number.isNaN(ms) ? null : d.toISOString()
}

/** Reduce a live transcript to the cacheable tail: drop still-streaming and
 * empty, keep the last MAX_ITEMS, cap each item's content. Exported for tests. */
export function serializeTranscript(messages: TranscriptInput[]): CachedMessage[] {
  const out: CachedMessage[] = []
  for (const m of messages) {
    if (!m || !m.id || m.isStreaming) continue
    const content = typeof m.content === 'string' ? m.content : ''
    // A normal bubble needs text; a compaction marker is kept even when empty.
    if (!content && !m.compaction) continue
    out.push({
      id: m.id,
      role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user',
      content: content.length > MAX_CONTENT ? content.slice(0, MAX_CONTENT) : content,
      ts: tsToIso(m.timestamp),
      ...(m.compaction ? { compaction: m.compaction } : {}),
    })
  }
  return out.slice(-MAX_ITEMS)
}

function resolveStorage(storage?: CacheStorage): CacheStorage | null {
  if (storage) return storage
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage
  } catch { /* access blocked */ }
  return null
}

/** Evict least-recently-written entries beyond MAX_SESSIONS (keeps newest). */
function evict(storage: CacheStorage): void {
  const entries: Array<{ k: string; at: number }> = []
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i)
    if (!k || !k.startsWith(`${TRANSCRIPT_CACHE_PREFIX}:`)) continue
    let at = 0
    try {
      const parsed = JSON.parse(storage.getItem(k) || '{}')
      at = typeof parsed?.at === 'number' ? parsed.at : 0
    } catch { /* unparseable — treat as oldest so it is dropped first */ }
    entries.push({ k, at })
  }
  if (entries.length <= MAX_SESSIONS) return
  entries.sort((a, b) => b.at - a.at) // newest first
  for (const { k } of entries.slice(MAX_SESSIONS)) {
    try { storage.removeItem(k) } catch { /* ignore */ }
  }
}

/** Persist a session's transcript tail. No-op on empty input or no storage. */
export function cacheTranscript(
  sessionId: string | null | undefined,
  messages: TranscriptInput[],
  now: number = Date.now(),
  storage?: CacheStorage,
): void {
  if (!sessionId) return
  const store = resolveStorage(storage)
  if (!store) return
  const items = serializeTranscript(messages)
  if (items.length === 0) return // never clobber a good cache with nothing
  const entry: CacheEntry = { at: now, items }
  try {
    store.setItem(keyFor(sessionId), JSON.stringify(entry))
    evict(store)
  } catch {
    // Quota or serialization failure — try trimming once, else give up quietly.
    try {
      const trimmed: CacheEntry = { at: now, items: items.slice(-20) }
      store.setItem(keyFor(sessionId), JSON.stringify(trimmed))
    } catch { /* give up — the live replay will still hydrate */ }
  }
}

/** The cached transcript for a session, or [] when none / unreadable. */
export function readCachedTranscript(
  sessionId: string | null | undefined,
  storage?: CacheStorage,
): CachedMessage[] {
  if (!sessionId) return []
  const store = resolveStorage(storage)
  if (!store) return []
  let raw: string | null
  try { raw = store.getItem(keyFor(sessionId)) } catch { return [] }
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    const items = parsed?.items
    if (!Array.isArray(items)) return []
    return items.filter(
      (m): m is CachedMessage =>
        !!m && typeof m.id === 'string' &&
        (m.role === 'user' || m.role === 'assistant' || m.role === 'system') &&
        typeof m.content === 'string',
    )
  } catch { return [] }
}

/** Remove every cached transcript (all sessions). Called on sign-out. */
export function clearCachedTranscripts(storage?: CacheStorage): void {
  const store = resolveStorage(storage)
  if (!store) return
  const keys: string[] = []
  try {
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i)
      if (k && k.startsWith(`${TRANSCRIPT_CACHE_PREFIX}:`)) keys.push(k)
    }
  } catch { return }
  for (const k of keys) {
    try { store.removeItem(k) } catch { /* ignore */ }
  }
}
