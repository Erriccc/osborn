// ============================================================
// CLIENT-SAFE SESSION UTILITIES
// No Node.js imports (fs, os, path) — safe for 'use client' components
// ============================================================

export interface SessionInfo {
  sessionId: string
  timestamp: string // ISO string for JSON serialization
  lastMessage?: string
  messageCount: number
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
