/**
 * lens-library-digest.ts — the DAILY DIGEST of short chats.
 *
 * A stretch of conversation that spans less than the period minimum (1h by default) never
 * becomes a period page. The catch-up sweep (lens-library-sweep.ts) gathers those short chats
 * from every session on the machine, groups them by LOCAL calendar day, and writes one page per
 * day that is over (never today, while chats can still be added):
 *   <claudeDir>/osb-library/digests/<YYYY-MM-DD>-digest.md   (+ INDEX.md, .digest-manifest.json)
 * Each chat gets a title and a one-to-two line summary from ONE model call per day, through the
 * period map's model path (lens-model: OpenRouter, reasoning off, hard $ cap per call). Input
 * rows go through the same strip + secret redaction as the period map (loadConversationRows)
 * plus each project's client redactor; the page is scrubbed again before it is written.
 *
 * Idempotent: .digest-manifest.json records which chats each day holds. A day is rewritten (in
 * place, same file and same cloud row) only when a chat it does not hold turns up for it.
 * Ingest goes through the shared content_ingest seam (postContentIngest) with a stable
 * per-day content hash, so an update replaces the day's draft instead of adding a second one.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConversationRows, type SessionStore } from './lens-db.js'
import { Budget, chat, getModelInfo, isTransportError, modelCallFailed } from './lens-model.js'
import { loadClientRedactor, type ClientRedactor } from './lens-redact.js'
import { redactSecrets } from './transcript-sanitizer.js'
import { parseJsonLoose } from './content-llm.js'
import { machineTimeZone, parseDigest, rebuildIndex } from './lens-library-index.js'
import { clip, needsIngest, postContentIngest, resolveIngestConfig, type IngestOptions, type IngestState } from './lens-ingest.js'
import { writeAtomic } from './content-manifest.js'
import { libraryHomeDir } from './lens-paths.js'
import type { LibraryPeriod } from './lens-library-select.js'

const DIGEST_MANIFEST_FILE = '.digest-manifest.json'
/** Hard cap for one day's call. */
export const DIGEST_CAP_USD = 0.25
/** A day that failed this many times in a row is retried only when it gains a chat. */
const MAX_DIGEST_FAILURES = 3
const MAX_CHATS_PER_DAY = 60
const CHAT_HEAD = 2_500
const CHAT_TAIL = 1_500
const MAX_OUT = 6_000

export type ShortChat = SessionStore & { period: LibraryPeriod }

export interface DigestEntry {
  day: string
  file: string
  /** chatKey() of every chat the page holds. */
  chats: string[]
  /** 'empty' = every chat that day was injected context only (nothing to summarise): no page, no call. */
  status: 'ok' | 'error' | 'dry' | 'empty'
  failures?: number
  /** Chats of the last failed attempt. */
  tried?: string[]
  costUsd: number
  errors: string[]
  updatedAt: string
  /** Its contentHash is the page body's sha256, so an updated page is sent again. */
  ingest?: IngestState
}
export interface DigestManifest {
  version: 1
  days: Record<string, DigestEntry>
}

export type DigestStatus = 'written' | 'dry' | 'empty' | 'model-error' | 'failed'
export interface DigestResult {
  status: DigestStatus
  page: string | null
  costUsd: number
  errors: string[]
}

const pad = (n: number) => String(n).padStart(2, '0')

/** YYYY-MM-DD of `ts` in the machine's local time zone (TZ). */
export function localDay(ts: string | number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const localTime = (ts: string) => {
  const d = new Date(ts)
  return Number.isFinite(d.getTime()) ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : '?'
}

export const chatKey = (c: Pick<ShortChat, 'sessionId' | 'period'>): string => `${c.sessionId}:${c.period.startRowId}-${c.period.endRowId}`
export const digestDir = (home = libraryHomeDir()): string => join(home, 'digests')
const digestFileName = (day: string): string => `${day}-digest.md`

export function readDigestManifest(dir: string): DigestManifest {
  try {
    const o = JSON.parse(readFileSync(join(dir, DIGEST_MANIFEST_FILE), 'utf-8'))
    if (o && typeof o.days === 'object' && !Array.isArray(o.days)) return { version: 1, days: o.days }
  } catch {
    /* missing / unreadable → empty */
  }
  return { version: 1, days: {} }
}

export function writeDigestManifest(dir: string, m: DigestManifest): void {
  writeAtomic(join(dir, DIGEST_MANIFEST_FILE), JSON.stringify(m, null, 2) + '\n')
}

/**
 * Which past days need a (re)write: never digested, holding a chat the page does not, or holding
 * a chat that is gone (`stale`: it grew into a written period page, or into a longer chat).
 * Chats that touch today wait (they are returned as `today`). Each pending day comes with ALL
 * its current chats, so an updated page is complete. `emptied` = digested days none of whose
 * chats is left: their page should go. Pure.
 */
export function pendingDigestDays(
  chats: ShortChat[], m: DigestManifest, now = Date.now(), stale: Set<string> = new Set(),
): { days: Map<string, ShortChat[]>; today: ShortChat[]; emptied: string[] } {
  const today = localDay(now)
  const byDay = new Map<string, ShortChat[]>()
  const waiting: ShortChat[] = []
  for (const c of chats) {
    if (c.period.rows < 2) continue // a lone message with no reply is not a chat
    const day = localDay(c.period.fromTs)
    const end = localDay(c.period.toTs)
    if (!/^\d{4}-/.test(day) || !/^\d{4}-/.test(end)) continue
    if (end >= today) {
      waiting.push(c) // the day is not over yet
      continue
    }
    byDay.set(day, [...(byDay.get(day) ?? []), c])
  }
  const emptied = Object.values(m.days)
    .filter(e => e.status === 'ok' && !byDay.has(e.day) && e.chats.length > 0 && e.chats.every(k => stale.has(k)))
    .map(e => e.day)
  for (const [day, cs] of [...byDay]) {
    const e = m.days[day]
    if (!e) continue
    const keys = cs.map(chatKey)
    const fresh = keys.some(k => !e.chats.includes(k))
    const gone = e.chats.some(k => stale.has(k))
    // Keeps failing on the same chats: stop until another chat turns up for that day.
    const stuck = (e.failures ?? 0) >= MAX_DIGEST_FAILURES && keys.every(k => e.chats.includes(k) || (e.tried ?? []).includes(k))
    if (((e.status === 'ok' || e.status === 'empty') && !fresh && !gone) || stuck) byDay.delete(day)
  }
  return { days: byDay, today: waiting, emptied }
}

interface DigestItem {
  n: number
  chat: ShortChat
  text: string
  fallbackTitle: string
  title?: string
  summary?: string
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

/** prompts/library-digest.md (src/prompts in dev, dist/prompts when built). */
const DIGEST_PROMPT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts', 'library-digest.md')

function digestPrompt(day: string, items: DigestItem[]): string {
  return readFileSync(DIGEST_PROMPT_PATH, 'utf-8')
    .trimEnd()
    .replaceAll('{{count}}', String(items.length))
    .replaceAll('{{day}}', day)
    .replace('{{chats}}', () => items.map(i => `<chat n="${i.n}">\n${i.text}\n</chat>`).join('\n\n'))
}

function renderDigestMd(day: string, items: DigestItem[], o: { costUsd: number; dry?: boolean; total: number }): string {
  const L: string[] = [`<!-- osborn-digest: day=${day} chats=${o.total}${o.dry ? ' dry' : ''} -->`, `# Daily digest — ${day}`, '']
  L.push(`Short chats from this day; the day and the times are in ${machineTimeZone()}. Each is under the period minimum, so none has a period page of its own.`, '')
  L.push(`- Chats: ${o.total}`)
  if (o.total > items.length) L.push(`- Listed: the first ${items.length}; ${o.total - items.length} more short chat(s) that day are not summarised`)
  L.push(o.dry ? '- Calls: none (dry run)' : `- Calls: 1, $${o.costUsd.toFixed(4)} (cap $${DIGEST_CAP_USD.toFixed(2)})`, '', '## Chats', '')
  for (const i of items) {
    const p = i.chat.period
    L.push(`### ${oneLine(i.title || i.fallbackTitle)}`, `- Session ${i.chat.sessionId.slice(0, 8)} · rows #${p.startRowId}–#${p.endRowId} · ${localTime(p.fromTs)}–${localTime(p.toTs)}`)
    L.push(i.summary ? oneLine(i.summary) : '(no summary)', '')
  }
  return L.join('\n')
}

/** Stable per machine + day, so a rewritten digest updates its draft in place. */
function digestContentHash(day: string): string {
  return createHash('sha256').update(`osborn-library-digest\n${hostname()}\n${day}`).digest('hex')
}

const bodyHash = (md: string) => createHash('sha256').update(md).digest('hex')

/** Send one digest page through the shared content_ingest seam. Never throws; updates `e`. */
async function ingestDigest(e: DigestEntry, markdown: string, o: IngestOptions): Promise<void> {
  const scrub = o.scrub ?? ((s: string) => s)
  const { titles } = parseDigest(e.file, markdown)
  const payload = {
    type: 'text_post',
    title: clip(scrub(`Daily digest ${e.day}: ${e.chats.length} short chat${e.chats.length === 1 ? '' : 's'}`), 200),
    hook: clip(scrub(titles.slice(0, 3).join(' · ')), 280) || null,
    body: scrub(markdown),
    source_session_id: null,
    source_anchors: { digest_day: e.day, chats: e.chats.length, file: e.file },
    source_kind: 'library_digest',
    content_hash: digestContentHash(e.day),
  }
  // The cloud row is keyed on the stable day hash; the state records the body hash (needsIngest).
  e.ingest = await postContentIngest(payload, bodyHash(markdown), `library: ingest digest ${e.day}`, o)
}

/** Retry pass for written digests whose ingest never landed (no model call). Returns true if the manifest changed. */
export async function ingestPendingDigests(dir: string, m: DigestManifest, o: IngestOptions = {}): Promise<boolean> {
  if (!resolveIngestConfig().ok) return false
  let changed = false
  for (const e of Object.values(m.days)) {
    if (e.status !== 'ok') continue
    try {
      const md = readFileSync(join(dir, e.file), 'utf-8')
      if (!needsIngest(e.ingest, bodyHash(md))) continue
      await ingestDigest(e, md, o)
      changed = true
    } catch {
      /* fail-open: next run */
    }
  }
  return changed
}

export interface DigestOptions {
  day: string
  chats: ShortChat[]
  dir?: string
  /** No model call: titles from each chat's first line, no summaries (manifest status "dry"). */
  dry?: boolean
  log?: (m: string) => void
}

/** Write (or rewrite) one day's digest. One model call at most. Never throws. */
export async function runDigestDay(o: DigestOptions): Promise<DigestResult> {
  const log = o.log ?? (() => {})
  const dir = o.dir ?? digestDir()
  const res: DigestResult = { status: 'failed', page: null, costUsd: 0, errors: [] }
  try {
    mkdirSync(dir, { recursive: true })
    const m = readDigestManifest(dir)
    const prev = m.days[o.day]
    const every = [...o.chats].sort((a, b) => a.period.fromTs.localeCompare(b.period.fromTs))
    const reds = new Map<string, ClientRedactor>()
    const redFor = (pd: string) => reds.get(pd) ?? reds.set(pd, loadClientRedactor(pd)).get(pd)!
    // Segmentation counts raw rows; only the sanitised rows count here. A chat with fewer than two
    // left (a replayed session tail, a lone message) is not a chat: it is left out before numbering.
    const kept = every
      .map(c => ({ c, recs: loadConversationRows(c.db, c.period.startRowId - 1, redFor(c.projectDir).redact, c.period.endRowId).records }))
      .filter(x => x.recs.length >= 2)
    const items: DigestItem[] = kept.slice(0, MAX_CHATS_PER_DAY).map(({ c, recs }, i) => {
      const all = recs.map(r => `${r.speaker}: ${r.text}`).join('\n')
      const text = all.length > CHAT_HEAD + CHAT_TAIL ? `${all.slice(0, CHAT_HEAD)}\n…\n${all.slice(-CHAT_TAIL)}` : all
      const first = recs.find(r => r.speaker === 'user')?.text ?? recs[0]?.text ?? ''
      return { n: i + 1, chat: c, text, fallbackTitle: clip(oneLine(first), 80) || 'Untitled chat' }
    })
    const scrub = (s: string) => redactSecrets([...reds.values()].reduce((t, r) => r.redact(t), s), { assistant: true })
    // Every chat of the day is recorded, listed, empty or not, so the day is not re-digested each run.
    const keys = every.map(chatKey)
    if (!items.length) {
      // Nothing to summarise: no call, no page, no ingest. An earlier page of that day goes (removeDigestDay).
      if (prev?.status === 'ok') await removeDigestDay(dir, o.day, { scrub, log })
      const m2 = readDigestManifest(dir)
      m2.days[o.day] = m2.days[o.day]
        ? { ...m2.days[o.day], chats: keys }
        : { day: o.day, file: digestFileName(o.day), chats: keys, status: 'empty', costUsd: 0, errors: [], updatedAt: new Date().toISOString() }
      writeDigestManifest(dir, m2)
      log(`digest ${o.day}: ${every.length} chat(s), none with anything to summarise — no page`)
      return { ...res, status: 'empty' }
    }
    const fail = (status: DigestStatus): DigestResult => {
      m.days[o.day] = {
        ...(prev ?? { day: o.day, file: digestFileName(o.day), chats: [] }),
        status: prev?.status === 'ok' ? 'ok' : 'error', // a good page stays; only its retry count moves
        failures: (prev?.failures ?? 0) + (isTransportError(res.errors) ? 0 : 1), tried: keys, costUsd: res.costUsd, errors: res.errors, updatedAt: new Date().toISOString(),
      }
      writeDigestManifest(dir, m)
      log(`digest ${o.day}: ${status} ${res.errors.join('; ')}`)
      return { ...res, status }
    }

    if (!o.dry) {
      const key = (process.env.OPENROUTER_API_KEY || '').trim()
      if (!key) throw new Error('OPENROUTER_API_KEY not set')
      const info = await getModelInfo(key)
      if (!info) throw new Error('model info unavailable (cannot enforce the cost cap)')
      const prompt = digestPrompt(o.day, items)
      const budget = new Budget(info, { maxCalls: 1, maxCostUsd: DIGEST_CAP_USD })
      try {
        const r = await chat(budget, prompt, key, MAX_OUT)
        if (!r) res.errors.push('refused by the cost cap')
        else {
          const parsed = parseJsonLoose(r.content)
          for (const c of Array.isArray(parsed?.chats) ? parsed.chats : []) {
            const it = items.find(i => i.n === Number(c?.n))
            if (!it) continue
            it.title = clip(oneLine(String(c?.title ?? '')), 120) || undefined
            it.summary = clip(oneLine(String(c?.summary ?? '')), 400) || undefined
          }
          if (!items.some(i => i.summary)) res.errors.push('no parseable digest reply')
        }
      } catch (e: any) {
        res.errors.push(modelCallFailed(e))
      }
      res.costUsd = +budget.spentUsd.toFixed(4)
      if (!items.some(i => i.summary)) return fail('model-error')
    }

    const markdown = scrub(renderDigestMd(o.day, items, { costUsd: res.costUsd, dry: o.dry, total: kept.length }))
    const file = digestFileName(o.day)
    res.page = join(dir, file)
    writeAtomic(res.page, markdown)
    rebuildIndex(dir, 'daily digests', scrub)
    const entry: DigestEntry = {
      day: o.day, file, chats: keys, status: o.dry ? 'dry' : 'ok', costUsd: res.costUsd, errors: res.errors,
      updatedAt: new Date().toISOString(), ingest: prev?.ingest,
    }
    if (!o.dry) await ingestDigest(entry, markdown, { scrub, log })
    m.days[o.day] = entry
    writeDigestManifest(dir, m)
    res.status = o.dry ? 'dry' : 'written'
    log(`digest ${o.day}: ${res.status} ${items.length} chat(s) $${res.costUsd.toFixed(4)}${prev?.status === 'ok' ? ' (updated)' : ''}`)
    return res
  } catch (e: any) {
    res.errors.push(e?.message ?? String(e))
    log(`digest ${o.day}: failed (fail-open): ${e?.message ?? e}`)
    return { ...res, status: 'failed' }
  }
}

/** Remove a digested day none of whose chats is left (they grew into period pages). No model call. */
export async function removeDigestDay(dir: string, day: string, o: IngestOptions = {}): Promise<void> {
  const log = o.log ?? (() => {})
  const m = readDigestManifest(dir)
  const e = m.days[day]
  if (!e) return
  if (e.ingest?.status === 'ok') {
    // Already a cloud draft: rewrite it in place (same day hash) rather than leave a stale copy there.
    const md = [`<!-- osborn-digest: day=${day} chats=0 -->`, `# Daily digest — ${day}`, '',
      'The short chats of this day have grown into period pages, so this digest no longer lists any.', '', '- Chats: 0', ''].join('\n')
    writeAtomic(join(dir, e.file), md)
    Object.assign(e, { chats: [], errors: [], updatedAt: new Date().toISOString() })
    await ingestDigest(e, md, o)
    log(`digest ${day}: emptied in place (its chats are now in period pages)`)
  } else {
    rmSync(join(dir, e.file), { force: true })
    delete m.days[day]
    log(`digest ${day}: removed (its chats are now in period pages)`)
  }
  writeDigestManifest(dir, m)
  rebuildIndex(dir, 'daily digests', o.scrub)
}
