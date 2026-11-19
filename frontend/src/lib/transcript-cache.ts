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

import type { ChatMessage, CompactionMarker, StewardVerdict, StewardGateRecord } from '../components/voice/shared'
import { clearKeysByPrefix, LIVE_SESSION_KEY, type KeyedStorage } from './chat-url'

export const TRANSCRIPT_CACHE_PREFIX = 'vn-chat-transcript-u'

// The pre-namespacing key shape: one browser-global `vn-chat-transcript:<id>`
// per session, left readable by whoever signed in next. Only ever removed.
const LEGACY_TRANSCRIPT_PREFIX = 'vn-chat-transcript'

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
  steward?: StewardVerdict
  stewardGate?: StewardGateRecord
}

/** One session's cached tail. The user's entry list is oldest-touched first. */
interface CachedSession {
  id: string
  items: CachedMessage[]
}

/**
 * Per-account storage key. Transcript text is the most sensitive thing this app
 * keeps in localStorage, and a browser-global key hands it to the next account
 * that signs in here — the leak #57 fixed for pinned files. So it is namespaced
 * by user id like its siblings liveSessionKey()/favoritesStorageKey(); guests
 * share one key. ONE key per user holds every cached session, so eviction order
 * is explicit in the value rather than relying on `Storage.key(i)` being
 * insertion-ordered (the Web Storage spec leaves that implementation-defined).
 * The `u:` segment can never collide with a legacy `<prefix>:<sessionId>` key.
 */
export function transcriptCacheKey(userId: string | null | undefined): string {
  return `${TRANSCRIPT_CACHE_PREFIX}:${userId || 'anon'}`
}

const timeOf = (m: ChatMessage) => (m.timestamp instanceof Date ? m.timestamp.getTime() : NaN)

/** Reduce a live transcript to the cacheable tail: keep the last MAX_ITEMS of
 * what the agent would re-serve, cap each item's content. Exported for tests. */
export function serializeTranscript(messages: ChatMessage[]): CachedMessage[] {
  const out: CachedMessage[] = []
  for (const m of messages) {
    if (!m || !m.id || m.isStreaming) continue
    // A cache row must never be re-cached: that is what let a transcript cached
    // under the wrong key (a failed resume) survive every reload (#149 review).
    if (m.fromCache) continue
    // Skip the synthetic day / "── Today ──" dividers: they are time-relative,
    // so a cached "Today" would mislead on a later-day reload. buildPriorItems
    // regenerates them from the real timestamps on both paint paths.
    if (m.id.startsWith('prior-day-') || m.id.startsWith('prior-sep-')) continue
    // Only what the replay returns: user/assistant turns plus durable
    // compaction markers and steward cards. A local system notice has no counterpart there, so
    // caching it would paint a row nothing can reconcile.
    if (m.role === 'system' && !m.compaction && !m.steward && !m.stewardGate) continue
    // Research log rows live in the Logs drawer and are never replayed.
    if (m.category === 'log') continue
    const content = typeof m.content === 'string' ? m.content : ''
    // A normal bubble needs text; a compaction marker is kept even when empty.
    if (!content && !m.compaction) continue
    const ms = timeOf(m)
    out.push({
      id: m.id,
      role: m.role,
      content: content.length > MAX_CONTENT ? content.slice(0, MAX_CONTENT) : content,
      ts: Number.isNaN(ms) ? null : new Date(ms).toISOString(),
      ...(m.compaction ? { compaction: m.compaction } : {}),
      ...(m.steward ? { steward: m.steward } : {}),
      ...(m.stewardGate ? { stewardGate: m.stewardGate } : {}),
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

/** Every session this account has cached, oldest-touched first, or []. */
function readSessions(store: CacheStorage, userId: string | null | undefined): CachedSession[] {
  let raw: string | null
  try { raw = store.getItem(transcriptCacheKey(userId)) } catch { return [] }
  if (!raw) return []
  try {
    const all: unknown = JSON.parse(raw)
    if (!Array.isArray(all)) return []
    return all.filter((s): s is CachedSession =>
      !!s && typeof s.id === 'string' && Array.isArray(s.items))
  } catch { return [] }
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
  const live = serializeTranscript(messages)
  if (live.length === 0) return // never clobber a good cache with nothing
  const sessions = readSessions(store, userId)
  // While the optimistic paint is on screen, serializeTranscript has dropped it,
  // so the turns taken since are added to the stored history the paint came from,
  // never written in its place. Writing nothing instead froze the cache for good
  // whenever no replay ever came to clear the paint (#195).
  let items = live
  if (messages.some(m => m?.fromCache)) {
    const liveIds = new Set(live.map(i => i.id))
    const stored = sessions.find(s => s.id === sessionId)?.items ?? []
    items = [...stored.filter(i => !liveIds.has(i.id)), ...live].slice(-MAX_ITEMS)
  }
  // Re-appended at the end, so the session touched longest ago is evicted.
  const all = [...sessions.filter(s => s.id !== sessionId), { id: sessionId, items }]
  try {
    store.setItem(transcriptCacheKey(userId), JSON.stringify(all.slice(-MAX_SESSIONS)))
  } catch {
    // Quota / serialization failure — give up quietly; the replay still hydrates.
  }
}

const turnText = (m: ChatMessage) =>
  (typeof m.content === 'string' ? m.content : '').slice(0, MAX_CONTENT).trim()
const isTurn = (m: ChatMessage) => m.role === 'user' || m.role === 'assistant'
// How far the browser clock may lead the stored timestamp of the same user turn.
const CLOCK_SKEW_MS = 60_000

/**
 * Put the authoritative replay in place of the optimistic paint (#153). The
 * replay can lag the session by a turn or more, so the cached turns from the
 * first user turn the replay does not hold onward are kept after it. A user
 * turn is held when the replay has the same text, stored no earlier than the
 * skew allows. Rows the replay never stores (the spoken greeting) count only
 * after such a user turn, so they cannot pile up across reloads. Everything
 * else the paint showed is dropped. Live rows (not from the cache) follow.
 * Pass `current` without its cache rows when the replay is for another session.
 */
export function reconcileReplay(replay: ChatMessage[], current: ChatMessage[]): ChatMessage[] {
  const live = current.filter(m => !m.fromCache)
  const users = replay.filter(m => m.role === 'user')
  const newest = Math.max(0, ...replay.filter(isTurn).map(timeOf).filter(t => !Number.isNaN(t)))
  const held = (m: ChatMessage) =>
    users.some(r => turnText(r) === turnText(m) && timeOf(r) >= timeOf(m) - CLOCK_SKEW_MS)
  const cached = current.filter(m => m.fromCache && isTurn(m))
  const start = newest > 0 ? cached.findIndex(m => m.role === 'user' && timeOf(m) > newest && !held(m)) : -1
  const ahead = start < 0 ? [] : cached.slice(start)
    .map(m => ({ ...m, id: `prior-ahead-${m.id}`, fromCache: false }))
  return [...replay, ...ahead, ...live]
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
  const items = readSessions(store, userId).find(s => s.id === sessionId)?.items ?? []
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
  clearKeysByPrefix(store, LEGACY_TRANSCRIPT_PREFIX)
}
