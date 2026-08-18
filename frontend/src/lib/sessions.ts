// ============================================================
// CLIENT-SAFE SESSION UTILITIES
// No Node.js imports (fs, os, path) — safe for 'use client' components
// ============================================================

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
}

// Filler words that are uninformative at the start of a session title
const TITLE_FILLER_RE = /^(i\s+(want|need|would like|can|could)|please|can you|could you|help me|how (do|can|to)|what (is|are|does)|let'?s|okay|ok|so\s+|um\s+|uh\s+|well\s+|just\s+)/i

/**
 * Derive a short 4-6 word title from a raw session message.
 * Strips leading filler phrases, capitalizes the first word, appends
 * ellipsis only when the original text had more content.
 */
export function deriveSessionTitle(text: string | undefined): string {
  if (!text || !text.trim()) return 'Untitled session'
  // Normalize whitespace
  let t = text.trim().replace(/\s+/g, ' ')
  // Strip leading filler (up to 2 passes to handle chained phrases)
  for (let i = 0; i < 2; i++) {
    const stripped = t.replace(TITLE_FILLER_RE, '').trim()
    if (stripped.length > 0) t = stripped
    else break
  }
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
 * Format timestamp for display (relative time)
 */
export function formatTime(timestamp: string): string {
  const date = new Date(timestamp)
  const now = new Date()
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
 * Group sessions by date category (Today, Yesterday, This Week, Older)
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

  for (const session of sessions) {
    const date = new Date(session.timestamp)
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
