/**
 * transcript-wiring.ts — pure helpers for the transcript paths in index.ts
 * (lane L2b, agent side). Kept out of index.ts so they are unit-testable
 * without booting the agent.
 *
 *  - sessionListEntry:    one mapping for `/sessions` and `sessions_list`
 *                         (carries title / firstTs / lastActivityAt).
 *  - cleanHistoryRows:    `/session-messages` + `prior_messages`: sanitize
 *                         with cleanTurnText BEFORE truncating, over-fetch so
 *                         rows dropped by the sanitizer do not shrink the page.
 *  - userEchoText:        the user_transcript echo text, sanitized.
 *  - TypedEchoTracker:    carries a typed message's clientMsgId onto its echo.
 *  - ClientNoteQueue:     out-of-band client notices (favorite_changed) that
 *                         ride the NEXT real user turn as hidden context
 *                         instead of becoming a user turn themselves.
 */
import { cleanTurnText } from './content/transcript-sanitizer.js'

// ── /sessions + sessions_list ──────────────────────────────────────────────

export interface SessionListSource {
  sessionId: string
  projectSlug: string
  projectPath: string
  cwd: string
  timestamp: Date
  lastMessage?: string
  title?: string
  messageCount: number
  firstTs?: string
  lastActivityAt?: string
  fileSize?: number
}

/** The preview fields the dashboard / session browser receive per session. */
export function sessionListEntry(s: SessionListSource) {
  return {
    sessionId: s.sessionId,
    projectSlug: s.projectSlug,
    projectPath: s.projectPath,
    cwd: s.cwd,
    timestamp: s.timestamp.toISOString(),
    lastMessage: s.lastMessage,
    title: s.title,
    messageCount: s.messageCount,
    firstTs: s.firstTs,
    lastActivityAt: s.lastActivityAt,
    fileSize: s.fileSize,
  }
}

// ── /session-messages + prior_messages ─────────────────────────────────────

export interface HistoryRow { msgType: string; text: string; ts?: string | null }
export interface HistoryMessage { role: 'user' | 'assistant'; content: string; ts: string | null }

/** Upper bound on rows read while topping up a page (sanitizer drops). */
export const HISTORY_MAX_FETCH = 2000

/**
 * Read up to `limit` clean messages, chronological. `fetchRows(n)` returns the
 * newest `n` rows NEWEST-FIRST (recentRows' contract). Each row is sanitized
 * with cleanTurnText first, then truncated to `maxChars`; dropped rows (pure
 * notices, injected blocks, [SYSTEM] lines) are replaced by fetching more,
 * starting at 3x and doubling, until the page is full, the store is exhausted
 * (fewer rows than asked), or HISTORY_MAX_FETCH is reached.
 */
export function cleanHistoryRows(
  fetchRows: (n: number) => HistoryRow[],
  limit: number,
  maxChars: number,
): HistoryMessage[] {
  const want = Math.max(1, Math.floor(limit) || 1)
  let n = Math.min(want * 3, HISTORY_MAX_FETCH)
  for (;;) {
    const rows = fetchRows(n)
    const kept: HistoryMessage[] = []
    for (const r of rows) {
      const role: 'user' | 'assistant' = r.msgType === 'assistant' ? 'assistant' : 'user'
      const clean = cleanTurnText(r.text || '', role)
      if (!clean) continue
      kept.push({ role, content: clean.slice(0, maxChars), ts: r.ts || null })
      if (kept.length >= want) break
    }
    const exhausted = rows.length < n || n >= HISTORY_MAX_FETCH
    if (kept.length >= want || exhausted) return kept.reverse() // newest-first → chronological
    n = Math.min(n * 2, HISTORY_MAX_FETCH)
  }
}

// ── user_transcript echo ───────────────────────────────────────────────────

/**
 * The text to echo as `user_transcript`, or null to send nothing. Runs the
 * shared sanitizer (drops [time:] tags, <session_tail>, [favorited] /
 * [welcome-back] / [SCRIPT] / [PROACTIVE] / [NOTIFICATION] / [SYSTEM] notices,
 * unwraps [INTERRUPTED]/[CONTEXT]), then the echo's own noise filters.
 */
export function userEchoText(raw: string, attachments = ''): string | null {
  if (!raw || typeof raw !== 'string') return null
  let clean = cleanTurnText(raw, 'user')
  if (clean) {
    const normalized = clean.replace(/\s+/g, ' ')
    if (clean.length < 3 || normalized === '<noise>' || normalized.toLowerCase() === 'thank you') clean = null
  }
  // A typed message keeps its attachment blocks (the chat renders them).
  const att = attachments.trim()
  if (att) return clean ? `${clean}\n\n${att}` : att
  return clean
}

export interface TypedEcho {
  /** The frontend's id for the optimistic bubble, when it sent one. */
  clientMsgId?: string
  /** Attachment blocks the agent appended to the typed text ('' = none). */
  attachments: string
}

/** Valid clientMsgId or undefined (string, 1..200 chars). */
export function validClientMsgId(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : undefined
}

/**
 * Remembers typed messages (user_text) by their raw content so the session's
 * echo of the same item (conversation_item_added → user_transcript) can carry
 * the frontend's clientMsgId and keep its attachment blocks (the sanitizer
 * strips trailing [File:]/[Image:] blocks, which the chat renders). Matches on
 * the exact raw text first, then on the sanitized text. Entries expire after
 * `ttlMs`; at most `max` are kept.
 */
export class TypedEchoTracker {
  #items: { raw: string; clean: string | null; echo: TypedEcho; at: number }[] = []
  constructor(private ttlMs = 60_000, private max = 20) {}

  register(rawContent: string, clientMsgId: unknown, attachments = '', now = Date.now()): void {
    const id = validClientMsgId(clientMsgId)
    if (!id && !attachments.trim()) return
    this.#prune(now)
    this.#items.push({
      raw: rawContent,
      clean: cleanTurnText(rawContent, 'user'),
      echo: { ...(id ? { clientMsgId: id } : {}), attachments: attachments.trim() },
      at: now,
    })
    if (this.#items.length > this.max) this.#items.splice(0, this.#items.length - this.max)
  }

  /** Consume and return the typed-message info for this echoed text, if any. */
  take(rawEcho: string, now = Date.now()): TypedEcho | undefined {
    this.#prune(now)
    let i = this.#items.findIndex((e) => e.raw === rawEcho)
    if (i < 0) {
      const clean = cleanTurnText(rawEcho, 'user')
      if (clean) i = this.#items.findIndex((e) => e.clean === clean)
    }
    if (i < 0) return undefined
    const [hit] = this.#items.splice(i, 1)
    return hit.echo
  }

  clear(): void { this.#items = [] }
  get size(): number { return this.#items.length }

  #prune(now: number) {
    this.#items = this.#items.filter((e) => now - e.at <= this.ttlMs)
  }
}

// ── favorite_changed (client notices off the user_text channel) ───────────

export interface FavoriteChange { filePath: string; fileName: string; favorited: boolean }

/** Validate a favorite_changed payload; null when unusable. */
export function parseFavoriteChanged(data: any): FavoriteChange | null {
  if (!data || typeof data !== 'object') return null
  const fileName = typeof data.fileName === 'string' ? data.fileName.trim().slice(0, 300) : ''
  const filePath = typeof data.filePath === 'string' ? data.filePath.trim().slice(0, 1000) : ''
  if (!fileName && !filePath) return null
  if (typeof data.favorited !== 'boolean') return null
  return { filePath: filePath || fileName, fileName: fileName || filePath.split('/').pop() || filePath, favorited: data.favorited }
}

/**
 * Backward compatibility: an older frontend sends the favorite as
 * `user_text` "[time: …] [favorited] The user favorited the file NAME."
 * Returns the change when `content` is exactly that notice, else null.
 */
export function parseLegacyFavoriteNotice(content: string): FavoriteChange | null {
  if (typeof content !== 'string') return null
  const body = content.replace(/^\s*\[time:[^\]]*\]\s*/, '')
  const m = body.match(/^\[favorited\]\s*The user favorited the file (.+?)\.?\s*$/s)
  if (!m) return null
  const name = m[1].trim()
  if (!name || name.includes('\n')) return null
  return { filePath: name, fileName: name, favorited: true }
}

/**
 * Pending client notices for the agent, delivered as hidden context on the next
 * real user turn (never as a user turn). Keyed by file path so a favorite then
 * an unfavorite of the same file cancels out. The drained block is a
 * <system-reminder>, which the shared sanitizer (lens-strip) removes from
 * history, titles and echoes while keeping the user's own words.
 */
export class ClientNoteQueue {
  #favorites = new Map<string, FavoriteChange>()
  constructor(private max = 20) {}

  favoriteChanged(change: FavoriteChange): void {
    this.#favorites.delete(change.filePath)
    // Un-favoriting stays silent (as before): it only cancels a pending note.
    if (!change.favorited) return
    this.#favorites.set(change.filePath, change)
    while (this.#favorites.size > this.max) {
      const oldest = this.#favorites.keys().next().value
      if (oldest === undefined) break
      this.#favorites.delete(oldest)
    }
  }

  get size(): number { return this.#favorites.size }
  clear(): void { this.#favorites.clear() }

  /** Return the pending notes as one hidden-context block and clear them; '' when none. */
  drain(): string {
    if (this.#favorites.size === 0) return ''
    const lines = [...this.#favorites.values()].map((f) =>
      `[favorited] The user favorited the file ${f.fileName}${f.filePath !== f.fileName ? ` (${f.filePath})` : ''}.`)
    this.#favorites.clear()
    return [
      '<system-reminder>',
      'Client notices since the last turn (UI actions, not something the user said; no reply needed unless relevant):',
      ...lines,
      '</system-reminder>',
    ].join('\n')
  }
}
