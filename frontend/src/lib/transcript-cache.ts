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
// and it is cleared on sign-out. Every read/write is wrapped, so a blocked or
// full localStorage degrades to "no cache" rather than throwing.

import type { ChatMessage, CompactionMarker } from '../components/voice/shared'
import { clearKeysByPrefix, LIVE_SESSION_KEY, type KeyedStorage } from './chat-url'

export const TRANSCRIPT_CACHE_PREFIX = 'vn-chat-transcript'

// The cache can never usefully hold more than the replay that supersedes it, and
// anything beyond that just eats the shared localStorage quota: the agent's
// /session-messages answers at most `limit` rows (the frontend asks 50, the
// agent caps at 200) truncated to 1200 chars each.
const MAX_SESSIONS = 8
const MAX_ITEMS = 50
const MAX_CONTENT = 1200

/** Read/write storage surface — window.localStorage and test fakes satisfy it. */
export interface CacheStorage extends KeyedStorage {
  getItem(k: string): string | null
  setItem(k: string, v: string): void
}

/** A message as cached (JSON-serializable). */
export interface CachedMessage {
  id: string
  role: ChatMessage['role']
  content: string
  /** ISO timestamp, or null when unknown. */
  ts: string | null
  compaction?: CompactionMarker
}

/**
 * Per-account, per-session storage key. Transcript text is the most sensitive
 * thing this app keeps in localStorage, and a key scoped to the session alone
 * hands it to the next account that signs in here — the leak #57 fixed for
 * pinned files. So it carries the user id, like its siblings liveSessionKey()
 * and favoritesStorageKey(); guests share the 'anon' namespace. The `u:`
 * segment keeps it from ever colliding with a pre-fix `<prefix>:<sessionId>`
 * key (a session id is 6+ characters), and those stale keys are only ever
 * removed — by capSessions below and by sign-out — never read back.
 */
function keyFor(userId: string | null | undefined, sessionId: string): string {
  return `${TRANSCRIPT_CACHE_PREFIX}:u:${userId || 'anon'}:${sessionId}`
}

/** Reduce a live transcript to the cacheable tail: keep the last MAX_ITEMS of
 * what the agent would re-serve, cap each item's content. Exported for tests. */
export function serializeTranscript(messages: ChatMessage[]): CachedMessage[] {
  const out: CachedMessage[] = []
  for (const m of messages) {
    if (!m || !m.id || m.isStreaming) continue
    // NOTE: fromCache rows are deliberately re-serialized. They are the history
    // on screen until the replay lands, and on the 60-90s cold boot this cache
    // exists for the user can speak first — skipping them would overwrite the
    // key with those one or two live turns and destroy the history.
    // Skip the synthetic day / "── Today ──" dividers: they are time-relative,
    // so a cached "Today" would mislead on a later-day reload. buildPriorItems
    // regenerates them from the real timestamps on both paint paths.
    if (m.id.startsWith('prior-day-') || m.id.startsWith('prior-sep-')) continue
    // Only what the replay returns: user/assistant turns plus durable
    // compaction markers. A local system notice has no counterpart there, so
    // caching it would paint a row nothing can reconcile.
    if (m.role === 'system' && !m.compaction) continue
    const content = typeof m.content === 'string' ? m.content : ''
    // A normal bubble needs text; a compaction marker is kept even when empty.
    if (!content && !m.compaction) continue
    const ms = m.timestamp instanceof Date ? m.timestamp.getTime() : NaN
    out.push({
      id: m.id,
      role: m.role,
      content: content.length > MAX_CONTENT ? content.slice(0, MAX_CONTENT) : content,
      ts: Number.isNaN(ms) ? null : new Date(ms).toISOString(),
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

/** Drop the oldest transcript keys beyond MAX_SESSIONS (and any pre-fix key it
 * sweeps past) so the cache can't grow without bound and starve other features
 * of the quota. `key(i)` order is the browser's insertion order in practice;
 * the spec leaves it implementation-defined, and the only cost of a wrong guess
 * here is evicting a cache entry early — one missed optimistic paint. */
function capSessions(store: CacheStorage): void {
  const keys: string[] = []
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i)
    if (k && k.startsWith(`${TRANSCRIPT_CACHE_PREFIX}:`)) keys.push(k)
  }
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SESSIONS))) {
    try { store.removeItem(k) } catch { /* ignore */ }
  }
}

/** Persist a session's transcript tail. No-op on empty input or no storage. */
export function cacheTranscript(
  userId: string | null | undefined,
  sessionId: string | null | undefined,
  messages: ChatMessage[],
  storage?: CacheStorage,
): void {
  if (!sessionId) return
  const store = resolveStorage(storage)
  if (!store) return
  const items = serializeTranscript(messages)
  if (items.length === 0) return // never clobber a good cache with nothing
  try {
    store.setItem(keyFor(userId, sessionId), JSON.stringify(items))
    capSessions(store)
  } catch {
    // Quota / serialization failure — give up quietly; the replay still hydrates.
  }
}

/** This account's cached transcript for a session, or [] when none/unreadable. */
export function readCachedTranscript(
  userId: string | null | undefined,
  sessionId: string | null | undefined,
  storage?: CacheStorage,
): CachedMessage[] {
  if (!sessionId) return []
  const store = resolveStorage(storage)
  if (!store) return []
  let raw: string | null
  try { raw = store.getItem(keyFor(userId, sessionId)) } catch { return [] }
  if (!raw) return []
  let items: unknown
  try { items = JSON.parse(raw) } catch { return [] }
  if (!Array.isArray(items)) return []
  return items.filter(
    (m): m is CachedMessage =>
      !!m && typeof m.id === 'string' &&
      (m.role === 'user' || m.role === 'assistant' || m.role === 'system') &&
      typeof m.content === 'string',
  )
}

/** Wipe every account-scoped record in localStorage: the live-session take-over
 * records and every cached transcript (including pre-namespacing residue). One
 * call, so a sign-out site can't clear one and forget the other — and the next
 * per-account cache is added here, not at three pages. */
export function clearSignOutLocalState(storage?: CacheStorage): void {
  const store = resolveStorage(storage)
  if (!store) return
  clearKeysByPrefix(store, LIVE_SESSION_KEY)
  clearKeysByPrefix(store, TRANSCRIPT_CACHE_PREFIX)
}
