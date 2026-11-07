/**
 * Session row title + recency for the mobile session list. Pure, no RN imports.
 *
 * The agent (PR #18+) sends an already-cleaned `title` and the real
 * `lastActivityAt`; older agents send only `lastMessage` + `timestamp`. This is
 * a minimal mirror of frontend/src/lib/transcript-clean.ts (Metro can't import
 * the web package) covering the wrappers that leak into list previews: the
 * `[time: …]` tag, `<session_tail>`-style blocks, the `[INTERRUPTED]`/`[CONTEXT]`
 * templates and a trailing `[INTERRUPTED]`. Anything left that is empty or
 * starts with `[` or `<` shows as "Untitled session".
 */

export const UNTITLED_SESSION = 'Untitled session'

export type SessionTitleFields = {
  title?: string | null
  lastMessage?: string | null
  timestamp?: string | null
  lastActivityAt?: string | null
}

const TIME_PREFIX_RE = /^\[time:[^\]]*\]\s*/
const BLOCK_TAGS = ['session_tail', 'recalled_context', 'system-reminder', 'task-notification', 'user-prompt-submit-hook']

function displayable(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null
  const t = text.replace(/\s+/g, ' ').trim()
  if (!t || t.startsWith('[') || t.startsWith('<')) return null
  return t
}

function cleanPreview(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null
  let out = text
  for (let prev = ''; prev !== out; ) {
    prev = out
    for (const tag of BLOCK_TAGS) {
      out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'g'), '\n')
    }
    out = out.trimStart().replace(TIME_PREFIX_RE, '')
  }
  out = out.trim()
  if (/^\[(?:INTERRUPTED|CONTEXT)\]/.test(out)) {
    const m = out.match(/(?:User's message|What the user is saying now):\s*"([\s\S]*?)"\s*(?:\n|$)/)
    if (!m) return null
    out = m[1].trimStart().replace(TIME_PREFIX_RE, '').trim()
  }
  out = out.replace(/\s*\[INTERRUPTED\]\s*$/, '').trim()
  return out || null
}

/** Agent title when usable, else the cleaned preview, else "Untitled session". */
export function mobileSessionTitle(s: SessionTitleFields): string {
  return displayable(s.title) ?? displayable(cleanPreview(s.lastMessage)) ?? UNTITLED_SESSION
}

/** `lastActivityAt` when it parses, else `timestamp`. */
export function mobileSessionActivityTime(s: SessionTitleFields): string {
  const la = s.lastActivityAt
  if (typeof la === 'string' && la && !Number.isNaN(new Date(la).getTime())) return la
  return s.timestamp || ''
}

/** New array, most recently active first. */
export function sortMobileSessions<T extends SessionTitleFields>(sessions: T[]): T[] {
  const ms = (s: T) => { const n = new Date(mobileSessionActivityTime(s)).getTime(); return Number.isNaN(n) ? 0 : n }
  return [...sessions].sort((a, b) => ms(b) - ms(a))
}
