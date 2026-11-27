// Follow-through (#378): the pure rules behind POST /api/follow-through.
// Which repos may receive issues, what an item may say, and what may go public.
import { redactSecrets } from './redactSecrets'
import { FOLLOW_UP_ORIGINS, FOLLOW_UP_SOURCES, isUserExplicit, type FollowUpItem } from './github-issue-mirror'
import { createRateLimiter } from './demo-rate-limit'

export const MAX_ITEMS = 20
export const MAX_TEXT = 200
const KEY_RE = /^[0-9a-f]{12}$/
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const SOURCES = new Set<string>(FOLLOW_UP_SOURCES)
const ORIGINS = new Set<string>(FOLLOW_UP_ORIGINS)

/** `owner/repo` with GitHub's name characters only. */
export const validRepo = (repo: string): boolean => REPO_RE.test(repo)

/** Items a single account may send to GitHub per rolling 24h. */
export const DAILY_ITEM_CAP = 30
// In memory, per server process (slice 1: no rate-limit table exists in Supabase). A restart
// or a second instance resets it; the admin-only rule is what bounds who can file at all.
export const accountLimiter = createRateLimiter({ limit: DAILY_ITEM_CAP, windowMs: 24 * 60 * 60_000, maxKeys: 10_000 })

/** Absolute, home-relative, Windows and relative (`src/x/y.ts`) file paths → `<path>` (URLs are left alone). */
function scrubPaths(text: string): string {
  return (text ?? '')
    .replace(/(^|[^\w:/.~-])(?:~\/|\/)(?:[^\s/'"`<>()]+\/)+[^\s'"`<>()]*/g, '$1<path>')
    .replace(/\b[A-Za-z]:\\(?:[^\s\\'"`<>]+\\)*[^\s'"`<>]*/g, '<path>')
    .replace(/(^|[\s([{'"`])(?:\.{1,2}\/)?(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,8}\b/g, '$1<path>')
}

/** Validate and clean one posted item, or null. Text is path-scrubbed, secret- and email-redacted, and capped. */
export function cleanItem(raw: unknown): FollowUpItem | null {
  const o = raw as Record<string, unknown> | null
  if (!o || typeof o !== 'object') return null
  if (typeof o.key !== 'string' || !KEY_RE.test(o.key)) return null
  if (typeof o.kind !== 'string' || !/^[a-z_]{2,32}$/.test(o.kind)) return null
  if (typeof o.text !== 'string') return null
  if (typeof o.source !== 'string' || !SOURCES.has(o.source)) return null
  if (typeof o.origin !== 'string' || !ORIGINS.has(o.origin)) return null
  const text = redactSecrets(scrubPaths(o.text))
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    // Another item's dedup marker in this text would make that item look already filed.
    .replace(/osborn-fp-/gi, 'osborn-fp ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT)
  if (!text) return null
  return {
    key: o.key,
    kind: o.kind,
    text,
    source: o.source as FollowUpItem['source'],
    origin: o.origin as FollowUpItem['origin'],
    ...(typeof o.turn === 'number' && Number.isFinite(o.turn) ? { turn: o.turn } : {}),
  }
}

/**
 * Wording that may describe an undisclosed vulnerability. A deliberately blunt, fail-closed screen
 * (a false hit only keeps an item local): the app has no private-advisory path, so a security
 * item must never become a public issue.
 */
const SECURITY_RE = /\b(security|vulnerabilit\w*|exploit\w*|cves?(?:-\d+)?|xss|csrf|ssrf|sql injection|rce|privilege escalation|auth(?:entication|orization)? bypass|api[ _-]?keys?|(?:leak(?:ed|s)?|exposed?|hard-?coded|stolen|compromised|plaintext)\s+(?:the\s+|a\s+|an\s+|our\s+)?(?:\w+\s+)?(?:keys?|tokens?|secrets?|passwords?|credentials?)|(?:keys?|tokens?|secrets?|passwords?|credentials?)\s+(?:is |are |was |were )?(?:leak(?:ed|s|ing)|exposed|stolen|compromised|in plaintext)|\w+_(?:key|secret|token|password))\b/i
export const looksSecurityRelated = (text: string): boolean => SECURITY_RE.test(text)

/** Into a public (or unknown-visibility) repo only the user's own explicit asks from the mic file, and never a security one. */
export function mayFile(item: FollowUpItem, repoPrivate: boolean): boolean {
  return repoPrivate || (isUserExplicit(item) && !looksSecurityRelated(item.text))
}
