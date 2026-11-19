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
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { loadConversationRows } from './lens-db.js'
import { Budget, chat, getModelInfo } from './lens-model.js'
import { loadClientRedactor, type ClientRedactor } from './lens-redact.js'
import { redactSecrets } from './transcript-sanitizer.js'
import { parseJsonLoose } from './content-llm.js'
import { rebuildIndex } from './lens-library-index.js'
import { postContentIngest, type IngestOptions, type IngestState } from './lens-ingest.js'
import { libraryHomeDir } from './lens-paths.js'
import { isTransportError } from './lens-library.js'
import type { LibraryPeriod } from './lens-library-select.js'

export const DIGEST_MANIFEST_FILE = '.digest-manifest.json'
/** Hard cap for one day's call. */
export const DIGEST_CAP_USD = 0.25
/** A day that failed this many times in a row is retried only when it gains a chat. */
export const MAX_DIGEST_FAILURES = 3
const MAX_CHATS_PER_DAY = 60
const CHAT_HEAD = 2_500
const CHAT_TAIL = 1_500
const MAX_OUT = 6_000

export interface ShortChat {
  sessionId: string
  db: string
  projectDir: string
  period: LibraryPeriod
}

export interface DigestEntry {
  day: string
  file: string
  /** chatKey() of every chat the page holds. */
  chats: string[]
  status: 'ok' | 'error' | 'dry'
  failures?: number
  /** Chats of the last failed attempt. */
  tried?: string[]
  costUsd: number
  errors: string[]
  updatedAt: string
  ingest?: IngestState
  /** sha256 of the page body last sent, so an updated page is sent again. */
  ingestedHash?: string
}
export interface DigestManifest {
  version: 1
  days: Record<string, DigestEntry>
}

export type DigestStatus = 'written' | 'dry' | 'model-error' | 'failed'
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
export const digestFileName = (day: string): string => `${day}-digest.md`

export function readDigestManifest(dir: string): DigestManifest {
  try {
    const o = JSON.parse(readFileSync(join(dir, DIGEST_MANIFEST_FILE), 'utf-8'))
    if (o && typeof o.days === 'object' && !Array.isArray(o.days)) return { version: 1, days: o.days }
  } catch {
    /* missing / unreadable → empty */
  }
  return { version: 1, days: {} }
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text, 'utf-8')
  renameSync(tmp, path)
}

export function writeDigestManifest(dir: string, m: DigestManifest): void {
  writeAtomic(join(dir, DIGEST_MANIFEST_FILE), JSON.stringify(m, null, 2) + '\n')
}

/**
 * Which past days need a (re)write: never digested, or holding a chat the page does not.
 * Chats that touch today wait (they are returned as `today`). Each pending day comes with ALL
 * its chats, so an updated page is complete. Pure.
 */
export function pendingDigestDays(chats: ShortChat[], m: DigestManifest, now = Date.now()): { days: Map<string, ShortChat[]>; today: ShortChat[] } {
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
  for (const [day, cs] of [...byDay]) {
    const e = m.days[day]
    if (!e) continue
    const keys = cs.map(chatKey)
    const fresh = keys.some(k => !e.chats.includes(k))
    // Keeps failing on the same chats: stop until another chat turns up for that day.
    const stuck = (e.failures ?? 0) >= MAX_DIGEST_FAILURES && keys.every(k => e.chats.includes(k) || (e.tried ?? []).includes(k))
    if ((e.status === 'ok' && !fresh) || stuck) byDay.delete(day)
  }
  return { days: byDay, today: waiting }
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
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s)

export function digestPrompt(day: string, items: DigestItem[]): string {
  return [
    `DAILY DIGEST. Below are ${items.length} short chat(s) from ${day} between a person (user) and their AI assistant, ` +
      'each inside <chat n="…">. Read all of them; your task follows after them.',
    '<chats>',
    ...items.map(i => `<chat n="${i.n}">\n${i.text}\n</chat>`),
    '</chats>',
    'TASK: for EACH chat above give a short title (3-8 words) and a summary of one or two lines: what the person wanted and ' +
      'what came of it. Never invent facts. Client details are masked as tags like [client], [founder], [amount]: keep the tags, ' +
      'never guess real names. Never include secrets, keys, tokens, emails or private personal details.',
    'Output ONLY: {"chats": [{"n": 1, "title": "...", "summary": "..."}]}',
  ].join('\n\n')
}

export function renderDigestMd(day: string, items: DigestItem[], o: { costUsd: number; dry?: boolean }): string {
  const L: string[] = [`<!-- osborn-digest: day=${day} chats=${items.length}${o.dry ? ' dry' : ''} -->`, `# Daily digest — ${day}`, '']
  L.push('Short chats from this day (local time). Each is under the period minimum, so none has a period page of its own.', '')
  L.push(`- Chats: ${items.length}`, o.dry ? '- Calls: none (dry run)' : `- Calls: 1, $${o.costUsd.toFixed(4)} (cap $${DIGEST_CAP_USD.toFixed(2)})`, '', '## Chats', '')
  for (const i of items) {
    const p = i.chat.period
    L.push(`### ${oneLine(i.title || i.fallbackTitle)}`, `- Session ${i.chat.sessionId.slice(0, 8)} · rows #${p.startRowId}–#${p.endRowId} · ${localTime(p.fromTs)}–${localTime(p.toTs)}`)
    L.push(i.summary ? oneLine(i.summary) : '(no summary)', '')
  }
  return L.join('\n')
}

/** Stable per machine + day, so a rewritten digest updates its draft in place. */
export function digestContentHash(day: string): string {
  return createHash('sha256').update(`osborn-library-digest\n${hostname()}\n${day}`).digest('hex')
}

const bodyHash = (md: string) => createHash('sha256').update(md).digest('hex')

/** Send one digest page through the shared content_ingest seam. Never throws; updates `e`. */
async function ingestDigest(e: DigestEntry, markdown: string, o: IngestOptions): Promise<void> {
  const scrub = o.scrub ?? ((s: string) => s)
  const titles = [...markdown.matchAll(/^### (.+)$/gm)].map(m => m[1].trim())
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
  e.ingest = await postContentIngest(payload, payload.content_hash, `library: ingest digest ${e.day}`, o)
  e.ingestedHash = bodyHash(markdown)
}

const ingestDone = (e: DigestEntry, md: string) =>
  e.ingestedHash === bodyHash(md) && (e.ingest?.status === 'ok' || e.ingest?.status === 'oversize')

/** Retry pass for written digests whose ingest never landed (no model call). Returns true if the manifest changed. */
export async function ingestPendingDigests(dir: string, m: DigestManifest, o: IngestOptions = {}): Promise<boolean> {
  let changed = false
  for (const e of Object.values(m.days)) {
    if (e.status !== 'ok') continue
    try {
      const md = readFileSync(join(dir, e.file), 'utf-8')
      if (ingestDone(e, md)) continue
      const before = JSON.stringify(e.ingest)
      await ingestDigest(e, md, o)
      if (JSON.stringify(e.ingest) !== before) changed = true
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
    const chats = [...o.chats].sort((a, b) => a.period.fromTs.localeCompare(b.period.fromTs)).slice(0, MAX_CHATS_PER_DAY)
    const reds = new Map<string, ClientRedactor>()
    const redFor = (pd: string) => reds.get(pd) ?? reds.set(pd, loadClientRedactor(pd)).get(pd)!
    const items: DigestItem[] = chats.map((c, i) => {
      const red = redFor(c.projectDir)
      const recs = loadConversationRows(c.db, c.period.startRowId - 1, red.redact, c.period.endRowId).records
      const all = recs.map(r => `${r.speaker}: ${r.text}`).join('\n')
      const text = all.length > CHAT_HEAD + CHAT_TAIL ? `${all.slice(0, CHAT_HEAD)}\n…\n${all.slice(-CHAT_TAIL)}` : all
      const first = recs.find(r => r.speaker === 'user')?.text ?? recs[0]?.text ?? ''
      return { n: i + 1, chat: c, text, fallbackTitle: clip(oneLine(first), 80) || 'Untitled chat' }
    })
    const scrub = (s: string) => redactSecrets([...reds.values()].reduce((t, r) => r.redact(t), s), { assistant: true })
    const keys = chats.map(chatKey)
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
      const budget = new Budget(info, { maxCalls: 1, maxCostUsd: DIGEST_CAP_USD })
      try {
        const r = await chat(budget, digestPrompt(o.day, items), key, MAX_OUT)
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
        res.errors.push(`model call failed: ${e?.message ?? e}`)
      }
      res.costUsd = +budget.spentUsd.toFixed(4)
      if (!items.some(i => i.summary)) return fail('model-error')
    }

    const markdown = scrub(renderDigestMd(o.day, items, { costUsd: res.costUsd, dry: o.dry }))
    const file = digestFileName(o.day)
    res.page = join(dir, file)
    writeAtomic(res.page, markdown)
    rebuildIndex(dir, 'daily digests', scrub)
    const entry: DigestEntry = {
      day: o.day, file, chats: keys, status: o.dry ? 'dry' : 'ok', costUsd: res.costUsd, errors: res.errors,
      updatedAt: new Date().toISOString(), ingest: prev?.ingest, ingestedHash: prev?.ingestedHash,
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
