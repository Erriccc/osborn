// ============================================================
// CLIENT-SAFE SESSION UTILITIES
// No Node.js imports (fs, os, path) — safe for 'use client' components
// ============================================================

import { stripSessionWrappers } from './transcript-clean'

export interface SessionInfo {
  sessionId: string
  timestamp: string // ISO string for JSON serialization
  lastMessage?: string
  messageCount: number
  // Slug-derived cwd from the agent's `listAllClaudeSessions`. This is
  // where the session FILE lives on disk (~/.claude/projects/<slug>/),
  // NOT the cwd recorded inside the JSONL content. Claude Code's
  // `--resume` looks up by file location, so this is what the chat
  // page must forward as `workingDirectory` for resume to find the
  // session. Optional because older agent responses may omit it.
  cwd?: string
  // L2b (agent >= PR #18): already-cleaned topic (ai-title or first real user
  // turn), first record time, and the last real user/assistant turn time.
  // Optional: older agents omit them.
  title?: string | null
  firstTs?: string | null
  lastActivityAt?: string | null
}

/** The fields the title/recency helpers read. Every one is optional so older
 * agents (no title / lastActivityAt) and partial shapes stay compatible. */
export interface SessionListFields {
  title?: string | null
  lastMessage?: string | null
  timestamp?: string | null
  lastActivityAt?: string | null
}

export const UNTITLED_SESSION = 'Untitled session'

/** A title is displayable when non-empty and not starting with `[` or `<`
 * (a leaked wrapper/notice/tag). Returns the whitespace-normalized text or null. */
function displayable(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null
  const t = text.replace(/\s+/g, ' ').trim()
  if (!t || t.startsWith('[') || t.startsWith('<')) return null
  return t
}

/** The agent's title when usable, else the cleaned legacy preview, else null. */
function sessionTitleSource(s: SessionListFields): string | null {
  return displayable(s.title) ?? displayable(stripSessionWrappers(s.lastMessage))
}

/**
 * Full display title for a session row: the agent's `title` when present and
 * displayable, else the cleaned `lastMessage` preview, else "Untitled session".
 * Never empty and never starts with `[` or `<`.
 */
export function sessionDisplayTitle(s: SessionListFields): string {
  return sessionTitleSource(s) ?? UNTITLED_SESSION
}

function validIso(v: string | null | undefined): v is string {
  return typeof v === 'string' && v !== '' && !Number.isNaN(new Date(v).getTime())
}

/** Recency time: the agent's `lastActivityAt` (real last turn), falling back
 * to `timestamp` (file mtime) for older agents or an unparseable value. */
export function sessionActivityTime(s: SessionListFields): string {
  if (validIso(s.lastActivityAt)) return s.lastActivityAt
  return s.timestamp || ''
}

function activityMs(s: SessionListFields): number {
  const ms = new Date(sessionActivityTime(s)).getTime()
  return Number.isNaN(ms) ? 0 : ms
}

/** New array, most recently active first. Does not mutate the input. */
export function sortSessionsByActivity<T extends SessionListFields>(sessions: T[]): T[] {
  return [...sessions].sort((a, b) => activityMs(b) - activityMs(a))
}

/**
 * Classify a session for the dashboard list and give it a clean label + text.
 * Meeting / task detection runs on the raw preview (`[MEETING — <botId>]:`,
 * `[SYSTEM] … in a meeting`, `<task-notification>`); the display text prefers
 * the agent's `title`, else the cleaned preview, else "Untitled session".
 */
export type SessionKind = 'meeting' | 'task' | 'chat'
export function prettySessionPreview(s: SessionListFields): { kind: SessionKind; label: string; text: string } {
  const raw = (s.lastMessage || '').trim()
  const title = displayable(s.title)
  const mt = raw.match(/^\[MEETING[^\]]*\]:?\s*([\s\S]*)$/i)
  if (mt) {
    const body = mt[1].replace(/^\s*[\w .'-]+:\s*/, '')
    return { kind: 'meeting', label: 'Meeting', text: title ?? displayable(body) ?? 'Meeting notes' }
  }
  const sys = raw.match(/^\[SYSTEM\]\s*([\s\S]*)$/i)
  if (sys && /in a meeting/i.test(sys[1])) {
    return { kind: 'meeting', label: 'Meeting', text: title ?? 'Meeting started' }
  }
  if (/^<task-notification>/i.test(raw) || /<task-id>/i.test(raw)) {
    return { kind: 'task', label: 'Task', text: title ?? 'Background task run' }
  }
  return { kind: 'chat', label: 'Chat', text: sessionDisplayTitle(s) }
}

// Filler words that are uninformative at the start of a session title
const TITLE_FILLER_RE = /^(i\s+(want|need|would like|can|could)|please|can you|could you|help me|how (do|can|to)|what (is|are|does)|let'?s|okay|ok|so\s+|um\s+|uh\s+|well\s+|just\s+)/i

/**
 * Derive a short 4-6 word title from a raw session message.
 * Strips leading filler phrases, capitalizes the first word, appends
 * ellipsis only when the original text had more content.
 */
export function deriveSessionTitle(input: string | null | undefined | SessionListFields): string {
  if (input && typeof input === 'object') {
    // Agent-supplied title (already cleaned): keep its wording, only cap length.
    const title = displayable(input.title)
    if (title) return capWords(title)
    return deriveSessionTitle(input.lastMessage)
  }
  const text = input
  if (!text || !text.trim()) return UNTITLED_SESSION
  // Compaction/continuation boilerplate → a friendly label (checked before the
  // cleaner, which drops it as a notice).
  if (/^this session is being continued from a previous conversation/i.test(text.trim())) return 'Continued session'
  // Strip pipeline wrappers ([time:], <session_tail>, [INTERRUPTED] templates,
  // notices) first; nothing real left → untitled.
  const cleaned = stripSessionWrappers(text)
  if (!cleaned || !displayable(cleaned)) return UNTITLED_SESSION
  // Normalize whitespace
  let t = cleaned.trim().replace(/\s+/g, ' ')
  // Strip internal protocol markup that leaks into the first message — tool/task
  // envelopes, their ids and command-output tags — none of it is user-meaningful
  // (e.g. "<task-notification> <task-id>a599aaee…</task-id>").
  t = t
    .replace(/<(task-id|tool-use-id|command-name|command-args|command-message|session-id|local-command-stdout|local-command-stderr)>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/?[a-z][a-z0-9-]{0,40}[^>]*>/gi, ' ')
    .replace(/\b[0-9a-f]{12,}\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // Compaction/continuation boilerplate → a friendly label instead of the blurb.
  if (/^this session is being continued from a previous conversation/i.test(t)) return 'Continued session'
  if (t.length < 2 || !displayable(t)) return UNTITLED_SESSION
  // Strip leading filler (up to 2 passes to handle chained phrases)
  for (let i = 0; i < 2; i++) {
    const stripped = t.replace(TITLE_FILLER_RE, '').trim()
    if (stripped.length > 0) t = stripped
    else break
  }
  return capWords(t)
}

export const APP_TITLE = 'Voice Native'

/**
 * Browser tab title for a chat page (bug ab31e017 / #60): "<session title> ·
 * Voice Native" once the session has a real, listed title, otherwise a STABLE
 * "Chat · Voice Native".
 *
 * The raw first user message is deliberately NOT used as the title. It used to
 * stand in before the session was listed, but that made the browser tab show
 * the truncated first message as soon as one was sent (#60) — it changed on
 * every chat and leaked message content into the tab. The route keeps a stable
 * "Chat · Voice Native" (matching useDocumentTitle('Chat') and the other
 * routes) and only upgrades to the clean session title once one exists.
 */
export function chatDocumentTitle(input: {
  session?: SessionListFields | null
}): string {
  const fromSession = input.session ? deriveSessionTitle(input.session) : UNTITLED_SESSION
  const title = fromSession !== UNTITLED_SESSION ? fromSession : 'Chat'
  return `${title} · ${APP_TITLE}`
}

/** Cap a normalized title at 6 words: capitalize the first, add an ellipsis
 * only when words were dropped. */
function capWords(t: string): string {
  // Take up to 6 words
  const words = t.split(' ')
  const MAX_WORDS = 6
  const truncated = words.length > MAX_WORDS
  const titleWords = words.slice(0, MAX_WORDS)
  // Capitalize first word
  if (titleWords.length > 0) {
    titleWords[0] = titleWords[0].charAt(0).toUpperCase() + titleWords[0].slice(1)
  }
  // Remove trailing punctuation from last word before adding ellipsis
  if (truncated) {
    titleWords[titleWords.length - 1] = titleWords[titleWords.length - 1].replace(/[,;:]$/, '')
    return titleWords.join(' ') + '…'
  }
  return titleWords.join(' ')
}

/**
 * Format timestamp for display (relative time). `nowMs` defaults to the
 * current time; pass it for deterministic rendering/tests.
 */
export function formatTime(timestamp: string, nowMs: number = Date.now()): string {
  const date = new Date(timestamp)
  const now = new Date(nowMs)
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  return date.toLocaleDateString()
}

/**
 * Group sessions by date category (Today, Yesterday, This Week, Older), using
 * the last-activity time; each group is most-recently-active first.
 */
export function groupSessionsByDate(sessions: SessionInfo[]): { label: string; sessions: SessionInfo[] }[] {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today.getTime() - 86400000)
  const weekAgo = new Date(today.getTime() - 7 * 86400000)

  const groups: Record<string, SessionInfo[]> = {
    'Today': [],
    'Yesterday': [],
    'This Week': [],
    'Older': [],
  }

  for (const session of sortSessionsByActivity(sessions)) {
    const date = new Date(sessionActivityTime(session))
    if (date >= today) {
      groups['Today'].push(session)
    } else if (date >= yesterday) {
      groups['Yesterday'].push(session)
    } else if (date >= weekAgo) {
      groups['This Week'].push(session)
    } else {
      groups['Older'].push(session)
    }
  }

  return Object.entries(groups)
    .filter(([, sessions]) => sessions.length > 0)
    .map(([label, sessions]) => ({ label, sessions }))
}
