/**
 * follow-through-client.ts — files open items through the frontend (#378).
 *
 * Same shape as checkPhoneCode (phone-code.ts): POST to the frontend with the
 * machine's sync token, read the reply strictly, collapse every failure to
 * 'error'. The GitHub token never lives on this machine. Items stay open on
 * anything but a clean reply.
 */
import { redactSecrets } from './content/secret-rules.js'
import { MAX_ITEM_CHARS, type LoopOrigin, type LoopSource } from './loops-ledger.js'

export interface FollowThroughItem {
  /** loopKey: 12 hex, the dedup key in the issue body. */
  key: string
  kind: string
  text: string
  source: LoopSource
  origin: LoopOrigin
  turn?: number
}

export interface FollowThroughResult {
  key: string
  action: 'created' | 'skipped' | 'held' | 'error'
  url?: string
}

const KEY_RE = /^[0-9a-f]{12}$/
const ACTIONS = new Set(['created', 'skipped', 'held', 'error'])
const FOLLOW_THROUGH_TIMEOUT_MS = 15_000

/** Redacted, one line, short: what may leave the machine for an item. The frontend scrubs paths and emails again. */
export function outboundText(text: string): string {
  const t = redactSecrets(String(text || '')).replace(/\s+/g, ' ').trim()
  return t.length > MAX_ITEM_CHARS ? t.slice(0, MAX_ITEM_CHARS - 1) + '…' : t
}

/** The frontend's answer to POST /api/follow-through, read strictly: anything unexpected is an error. */
export function readFollowThroughReply(status: number, body: unknown): FollowThroughResult[] | 'error' {
  if (status !== 200) return 'error'
  const results = (body as { results?: unknown } | null)?.results
  if (!Array.isArray(results)) return 'error'
  const out: FollowThroughResult[] = []
  for (const r of results as any[]) {
    if (!r || typeof r.key !== 'string' || !KEY_RE.test(r.key) || !ACTIONS.has(r.action)) return 'error'
    if ((r.action === 'created' || r.action === 'skipped') && !(typeof r.url === 'string' && /^https:\/\/github\.com\//.test(r.url))) return 'error'
    out.push({ key: r.key, action: r.action, ...(typeof r.url === 'string' ? { url: r.url } : {}) })
  }
  return out
}

/** Asks the frontend to file `items` into `repo`. The machine's sync token proves which account is asking. */
export async function postFollowThrough(
  frontendUrl: string,
  syncToken: string | undefined,
  repo: string,
  items: FollowThroughItem[],
  fetchFn: typeof fetch = fetch,
  timeoutMs = FOLLOW_THROUGH_TIMEOUT_MS,
  onFailure?: (detail: string) => void,
): Promise<FollowThroughResult[] | 'error'> {
  // Every item leaves through here, so redaction cannot be bypassed by a caller.
  const sent = items.map((i) => ({ ...i, text: outboundText(i.text) })).filter((i) => i.text)
  if (!syncToken || !frontendUrl || !repo || !sent.length) return 'error'
  try {
    const r = await fetchFn(`${frontendUrl}/api/follow-through`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${syncToken}` },
      body: JSON.stringify({ repo, items: sent }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = await r.json().catch(() => null)
    const reply = readFollowThroughReply(r.status, body)
    if (reply === 'error') {
      // The route's own reason ("not allowed" = not an admin account, "repo not allowed" = bad name or no push access, ...).
      const why = (body as any)?.error
      onFailure?.(`http ${r.status}${typeof why === 'string' ? `: ${why.slice(0, 80)}` : ''}`)
    }
    return reply
  } catch (err) {
    onFailure?.(`request failed: ${err instanceof Error ? err.message.slice(0, 80) : 'unknown'}`)
    return 'error'
  }
}
