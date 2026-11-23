import { NextResponse } from 'next/server'
import { serviceClient } from '@/lib/sandbox-claims'
import { fileFollowUp, githubConfigured, repoAccess } from '@/lib/github-issue-mirror'
import { MAX_ITEMS, accountLimiter, cleanItem, mayFile, validRepo } from '@/lib/follow-through'
import { isAdminEmail } from '@/lib/admin'
import { accountEmail } from '@/lib/phone-code'
import { bearerToken, syncTokenUserId } from '@/lib/sync-token-auth'

/**
 * POST /api/follow-through — file a voice session's open items as GitHub issues (#378).
 *
 * Called by the agent's detached flush worker (agent/src/follow-through-client.ts):
 * `{ repo, items: [{ key, kind, text, source, origin, turn? }] }`,
 * `Authorization: Bearer <sync token>`. The token names the machine, so the account
 * (same check as /api/phone/code). Only an admin account (ADMIN_EMAILS, lib/admin.ts) may
 * file, and only into a repo the server's GitHub token can push to (403 otherwise); other
 * accounts' items stay on their machine until per-user GitHub (#463). An account sends
 * at most DAILY_ITEM_CAP items to GitHub per rolling 24h (429 once over). Into a public repo
 * (or one whose visibility is unknown) only the user's own explicit asks file, everything
 * else is `held`. Replies `{ results: [{ key, action: 'created'|'skipped'|'held'|'error', url? }] }`,
 * or 503 when GitHub or Supabase is unavailable. The GitHub token never leaves this server.
 */
const MAX_BODY = 32 * 1024
// Stop starting new GitHub work after this, so the reply lands inside the agent's 15s timeout;
// the rest come back as 'error' and stay open for the next flush.
const ROUTE_BUDGET_MS = 9_000

export async function POST(request: Request) {
  const token = bearerToken(request)
  if (token.length < 16) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const raw = await request.text()
  if (raw.length > MAX_BODY) return NextResponse.json({ error: 'body too large' }, { status: 413 })
  let body: { repo?: unknown; items?: unknown } = {}
  try { body = JSON.parse(raw) } catch {}
  const { repo, items } = body
  if (typeof repo !== 'string' || repo.length > 140 || !Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) {
    return NextResponse.json({ error: 'invalid request' }, { status: 400 })
  }
  const admin = serviceClient()
  if (!admin) return NextResponse.json({ error: 'not configured' }, { status: 503 })
  const userId = await syncTokenUserId(admin, token)
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  if (!isAdminEmail(await accountEmail(admin, userId))) return NextResponse.json({ error: 'not allowed' }, { status: 403 })
  if (!validRepo(repo)) return NextResponse.json({ error: 'repo not allowed' }, { status: 403 })
  if (!githubConfigured()) return NextResponse.json({ error: 'not configured' }, { status: 503 })

  const started = Date.now()
  // Fail closed: a repo we cannot read counts as no push access and public.
  const access = await repoAccess(repo)
  if (!access.canPush) return NextResponse.json({ error: 'repo not allowed' }, { status: 403 })
  const repoPrivate = access.isPrivate
  const results: Array<{ key: string; action: 'created' | 'skipped' | 'held' | 'error'; url?: string }> = []
  let sent = 0
  for (const rawItem of items) {
    const item = cleanItem(rawItem)
    if (!item) continue
    if (!mayFile(item, repoPrivate)) {
      results.push({ key: item.key, action: 'held' })
      continue
    }
    // Past the time budget, or over the daily cap mid-batch: this item stays open for a later flush.
    if (Date.now() - started > ROUTE_BUDGET_MS) {
      results.push({ key: item.key, action: 'error' })
      continue
    }
    // Daily cap per account, counted per issue actually created (a dedup skip costs nothing);
    // already over it → 429 before any write.
    if (accountLimiter.atLimit(userId)) {
      if (!sent) return NextResponse.json({ error: 'daily limit reached' }, { status: 429 })
      results.push({ key: item.key, action: 'error' })
      continue
    }
    sent++
    const r = await fileFollowUp(repo, item)
    if (r.ok && r.action === 'created') accountLimiter.limited(userId)
    results.push(r.ok ? { key: item.key, action: r.action, url: r.url } : { key: item.key, action: 'error' })
  }
  return NextResponse.json({ results })
}
