/**
 * lens-db.ts — the content lens's SOURCE: the per-session recall store
 * (`session.db`, the same SQLite file `osborn-recall` queries), keyed by session ID.
 *
 *   <claudeDir>/projects/<slug>/osb/<sessionId>/session.db
 *     content(id INTEGER PK, source TEXT, line_num, byte_offset, ts TEXT,
 *             msg_type TEXT, model, git_branch, cwd, tool_name, blob BLOB)
 *   blob = brotli-compressed full text (session-store.ts compress()).
 *   id is append-only and chronological; source = 'main' | 'agent-<id8>'.
 *
 * CONVERSATION ONLY: msg_type IN ('user','assistant'); thinking / tool_use /
 * tool_result rows are never read. Default source is the main thread only
 * (sub-agent rows are the orchestrator's prompts + agent chatter, not the
 * conversation); OSBORN_LENS_INCLUDE_SUBAGENTS=1 widens it.
 *
 * Every pulled row goes through the same sanitizer as before (drops harness
 * wrappers like <session_tail>/[EMERGENCY STOP], unwraps [INTERRUPTED]/[CONTEXT]
 * to the user's actual words) and then a second redaction pass in assistant
 * mode ({assistant:true}, i.e. incl. the high-entropy fallback) for BOTH speakers,
 * then the optional client/customer redactor (names, IDs, emails, billing amounts).
 * Opened read-only; never writes to the store.
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { brotliDecompressSync } from 'node:zlib'
import Database from 'better-sqlite3'
import { redactSecrets, sanitizeRecord } from './transcript-sanitizer.js'
import { claudeDir, slugDir } from './lens-paths.js'
import { stripInjected } from './lens-strip.js'

export interface DbRecord {
  /** content.id in session.db — the row the quote is verified against. */
  id: number
  timestamp: string
  speaker: 'user' | 'assistant'
  text: string
}

export interface DbLoad {
  dbPath: string
  records: DbRecord[]
  /** Highest content.id scanned (incl. rows the sanitizer dropped) — the next high-water mark. */
  maxRowId: number
  stats: {
    rowsRead: number
    dropped: number
    unwrapped: number
    chars: number
    /** Rows touched per injected-context kind (lens-strip.ts) + sanitizer actions. */
    stripped: Record<string, number>
  }
}

const bump = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1)

const SID_RE = /^[A-Za-z0-9._-]{1,128}$/
export const CHARS_PER_TOKEN = 4
/** A single huge row (pasted logs etc.) is clipped in the VIEW only; verification uses full text. */
const MAX_RECORD_VIEW_CHARS = 20_000

/**
 * Resolve session.db for a session id: <projectDir>/osb/<sid>/session.db, then
 * the cwd slug, then a scan of every project's osb dir (same layout as
 * session-store.ts getStorePath / recall-cli listStores).
 */
export function resolveSessionDb(sessionId: string, projectDir?: string | null, cwd?: string): string | null {
  if (!sessionId || !SID_RE.test(sessionId)) return null
  const candidates: string[] = []
  if (projectDir) candidates.push(join(projectDir, 'osb', sessionId, 'session.db'))
  if (cwd) candidates.push(join(slugDir(cwd), 'osb', sessionId, 'session.db'))
  for (const p of candidates) if (existsSync(p) && statSync(p).size > 0) return p
  const root = join(claudeDir(), 'projects')
  try {
    for (const ent of readdirSync(root, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue
      const p = join(root, ent.name, 'osb', sessionId, 'session.db')
      if (existsSync(p) && statSync(p).size > 0) return p
    }
  } catch {
    /* no projects dir */
  }
  return null
}

export function includeSubagents(): boolean {
  return ['1', 'true', 'yes', 'on'].includes((process.env.OSBORN_LENS_INCLUDE_SUBAGENTS ?? '').trim().toLowerCase())
}

/**
 * Read conversation rows with id > afterRowId, in id order, sanitized.
 * Throws if the DB can't be opened (caller logs + exits).
 */
export function loadConversationRows(dbPath: string, afterRowId = 0, clientRedact?: (s: string) => string, throughRowId?: number): DbLoad {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    db.pragma('busy_timeout = 5000')
    const where = includeSubagents() ? '' : `AND source = 'main'`
    const upper = Number.isFinite(throughRowId) ? `AND id <= ${Math.floor(throughRowId!)}` : ''
    const stmt = db.prepare(
      `SELECT id, ts, msg_type, blob FROM content
       WHERE id > ? ${upper} AND msg_type IN ('user', 'assistant') ${where}
       ORDER BY id`,
    )
    const out: DbLoad = { dbPath, records: [], maxRowId: afterRowId, stats: { rowsRead: 0, dropped: 0, unwrapped: 0, chars: 0, stripped: {} } }
    for (const row of stmt.iterate(afterRowId) as Iterable<{ id: number; ts: string | null; msg_type: string; blob: Buffer }>) {
      out.stats.rowsRead++
      if (row.id > out.maxRowId) out.maxRowId = row.id
      let raw: string
      try {
        raw = brotliDecompressSync(row.blob).toString('utf-8')
      } catch {
        out.stats.dropped++
        continue
      }
      const speaker = row.msg_type === 'assistant' ? 'assistant' : 'user'
      // Injected / summarised context (session tails, recall blocks, reminders,
      // compaction summaries, silent control rows…) goes first — lens-strip.ts.
      const st = stripInjected(raw, speaker)
      for (const k of st.kinds) bump(out.stats.stripped, k)
      if (st.text === null) {
        out.stats.dropped++
        continue
      }
      const lead = st.text.replace(/^\[time:[^\]]*\]\s*/, '').trimStart()
      const { record, action } = sanitizeRecord({ text: st.text, timestamp: row.ts ?? '', speaker })
      if (!record || !record.timestamp) {
        bump(out.stats.stripped, `harness-other:${(lead.match(/^(\[[A-Za-z][^\]\n]{0,40}\]|<[a-z-]+>)/)?.[1] ?? 'empty/other')}`)
        out.stats.dropped++
        continue
      }
      if (action === 'unwrap') {
        out.stats.unwrapped++
        bump(out.stats.stripped, lead.startsWith('[CONTEXT]') ? 'context-unwrapped' : 'interrupted-unwrapped')
      }
      // Second pass: assistant-mode redaction for every row, both speakers; then
      // client/customer redaction (lens-redact.ts) — all before any model sees it.
      let text = redactSecrets(record.text, { assistant: true })
      if (clientRedact) text = clientRedact(text)
      if (!text.trim()) {
        out.stats.dropped++
        continue
      }
      out.records.push({ id: row.id, timestamp: record.timestamp, speaker, text })
      out.stats.chars += text.length
    }
    return out
  } finally {
    db.close()
  }
}

/** Record as the model sees it: header with row id, exact timestamp, speaker. */
export function recordView(r: DbRecord): string {
  const t = r.text.length > MAX_RECORD_VIEW_CHARS ? r.text.slice(0, MAX_RECORD_VIEW_CHARS) + ' …[clipped]' : r.text
  return `[#${r.id} | ${r.timestamp} | ${r.speaker}]\n${t}`
}

export const estimateTokens = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN)

export interface Window {
  index: number
  text: string
  records: DbRecord[]
  firstRowId: number
  lastRowId: number
  chars: number
  estTokens: number
}

/** Pack records IN ORDER into windows of ≤ windowTokens (estimated at CHARS_PER_TOKEN). */
export function packWindows(records: DbRecord[], windowTokens: number): Window[] {
  const maxChars = Math.max(10_000, windowTokens * CHARS_PER_TOKEN)
  const windows: Window[] = []
  let cur: { views: string[]; recs: DbRecord[]; chars: number } = { views: [], recs: [], chars: 0 }
  const flush = () => {
    if (!cur.recs.length) return
    const text = cur.views.join('\n\n')
    windows.push({
      index: windows.length,
      text,
      records: cur.recs,
      firstRowId: cur.recs[0].id,
      lastRowId: cur.recs[cur.recs.length - 1].id,
      chars: text.length,
      estTokens: estimateTokens(text.length),
    })
    cur = { views: [], recs: [], chars: 0 }
  }
  for (const r of records) {
    const v = recordView(r)
    if (cur.chars + v.length + 2 > maxChars && cur.recs.length) flush()
    cur.views.push(v)
    cur.recs.push(r)
    cur.chars += v.length + 2
  }
  flush()
  return windows
}
