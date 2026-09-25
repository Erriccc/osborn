/**
 * session-store.ts — Embedded per-session store that replaces the flat search-index.txt.
 *
 * WHY: search-index.txt kept only TRUNCATED one-line summaries (≈13% of the real
 * message text) in a grep-only flat file. This stores the FULL untruncated text of
 * every message — compressed — plus a hybrid (keyword + semantic) search index, in a
 * single SQLite file per session.
 *
 * ARCHITECTURE (one file: {osbDir}/session.db):
 *   • content  — full untruncated text + metadata (model, git_branch, cwd, tool_name,
 *                byte_offset for resume-UI targeted reads). Text is brotli-compressed
 *                (Node built-in zlib — no native compression extension needed).
 *   • fts      — FTS5 contentless index (BM25 keyword search). rowid == content.id.
 *                Contentless is safe because sessions are APPEND-ONLY (no row ever
 *                changes), so FTS never needs the original text to delete/update.
 *   • vec      — sqlite-vec int8[384] (semantic search). Populated only when an
 *                embedder is supplied; otherwise stays empty and queries degrade
 *                gracefully to keyword-only.
 *   • sources  — per-source byte offsets for incremental write-through (resume).
 *   • meta     — key/value: version, sessionId, embed model/dim, timestamps.
 *
 * Native deps: better-sqlite3 + sqlite-vec only (both ship prebuilt binaries).
 * Compression is Node's built-in brotli — nothing to build.
 *
 * Incremental: mirrors summary-index.ts's proven byte-offset resume — each poll reads
 * only the new bytes appended to the JSONL since the last stored offset.
 *
 * Store lives at: ~/.claude/projects/{slug}/osb/{sessionId}/session.db
 */

import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'zlib'
import { existsSync, statSync, openSync, readSync, closeSync, mkdirSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'
import { getSessionPaths, getSessionSubAgents, projectPathToSlug } from './session-access.js'

// ============================================================
// CONFIG / TYPES
// ============================================================

export const STORE_VERSION = 1
export const EMBED_DIM = 384

/** An embedder turns text into int8[EMBED_DIM] vectors (quantized, normalized). */
export type Embedder = (texts: string[]) => Promise<Int8Array[] | null>

export interface RecallHit {
  id: number
  source: string
  lineNum: number
  byteOffset: number
  ts: string
  msgType: string
  model: string | null
  gitBranch: string | null
  cwd: string | null
  toolName: string | null
  text: string
  score: number
  matchedBy: 'keyword' | 'vector' | 'both'
}

export interface StoreStats {
  totalRows: number
  newRows: number
  embeddedRows: number
  bytes: number
}

interface ExtractedRecord {
  msgType: string
  model: string | null
  toolName: string | null
  text: string
}

// ============================================================
// PATHS
// ============================================================

/** osb index dir for a session: ~/.claude/projects/{slug}/osb/{sessionId}/ */
function getOsbDir(sessionId: string, workingDir: string): string {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  const slug = projectPathToSlug(workingDir)
  return join(claudeDir, 'projects', slug, 'osb', sessionId)
}

export function getStorePath(sessionId: string, workingDir: string): string {
  return join(getOsbDir(sessionId, workingDir), 'session.db')
}

/** Returns the store path if it exists and is non-empty, else null. */
export function storeExists(sessionId: string, workingDir: string): string | null {
  const p = getStorePath(sessionId, workingDir)
  return existsSync(p) && statSync(p).size > 0 ? p : null
}

// ============================================================
// DB OPEN / SCHEMA
// ============================================================

export function openStore(dbPath: string): Database.Database {
  const db = new Database(dbPath)
  sqliteVec.load(db)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS content (
      id          INTEGER PRIMARY KEY,
      source      TEXT NOT NULL,
      line_num    INTEGER NOT NULL,
      byte_offset INTEGER NOT NULL,
      ts          TEXT,
      msg_type    TEXT NOT NULL,
      model       TEXT,
      git_branch  TEXT,
      cwd         TEXT,
      tool_name   TEXT,
      blob        BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_content_source ON content(source);
    CREATE INDEX IF NOT EXISTS idx_content_type   ON content(msg_type);

    CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(text, content='');

    CREATE VIRTUAL TABLE IF NOT EXISTS vec USING vec0(rowid INTEGER PRIMARY KEY, embedding int8[${EMBED_DIM}]);

    CREATE TABLE IF NOT EXISTS sources (
      source      TEXT PRIMARY KEY,
      jsonl_path  TEXT,
      byte_offset INTEGER NOT NULL DEFAULT 0,
      line_count  INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `)

  const setMeta = db.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)')
  setMeta.run('version', String(STORE_VERSION))
  setMeta.run('embed_dim', String(EMBED_DIM))
  return db
}

// ============================================================
// COMPRESSION
// ============================================================

const BROTLI_OPTS = { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } }

function compress(text: string): Buffer {
  return brotliCompressSync(Buffer.from(text, 'utf-8'), BROTLI_OPTS)
}
function decompress(blob: Buffer): string {
  return brotliDecompressSync(blob).toString('utf-8')
}

// ============================================================
// EXTRACTION (FULL text — no truncation)
// ============================================================

/** Extract all indexable records from one parsed JSONL object, with FULL text. */
function extractRecords(raw: any): ExtractedRecord[] {
  if (raw?.isMeta) return []
  const type = raw?.type as string
  if (!type || type === 'queue-operation' || type === 'file-history-snapshot' ||
      type === 'system' || type === 'progress') return []

  // ── user (regular text OR tool_result wrapper) ──
  if (type === 'user') {
    const content = raw.message?.content
    if (!Array.isArray(content)) return []

    if (content[0]?.type === 'tool_result') {
      const tr = content[0]
      const resultText = typeof tr.content === 'string'
        ? tr.content
        : Array.isArray(tr.content)
          ? tr.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n')
          : ''
      if (!resultText.trim()) return []
      const toolName = raw.toolUseResult?.name || null
      return [{ msgType: 'tool_result', model: null, toolName, text: resultText }]
    }

    const texts: string[] = []
    for (const block of content) {
      if (block?.type === 'text' && block.text) texts.push(block.text)
    }
    if (!texts.length) return []
    return [{ msgType: 'user', model: null, toolName: null, text: texts.join('\n') }]
  }

  // ── assistant (text + thinking + tool_use blocks) ──
  if (type === 'assistant') {
    const content = raw.message?.content
    if (!Array.isArray(content)) return []
    const model = raw.message?.model || null
    const out: ExtractedRecord[] = []
    for (const block of content) {
      if (block?.type === 'text' && block.text?.trim()) {
        out.push({ msgType: 'assistant', model, toolName: null, text: block.text })
      }
      if (block?.type === 'thinking' && block.thinking?.trim()) {
        out.push({ msgType: 'thinking', model, toolName: null, text: block.thinking })
      }
      if (block?.type === 'tool_use') {
        out.push({ msgType: 'tool_use', model, toolName: block.name || null, text: formatToolUse(block.name, block.input) })
      }
    }
    return out
  }

  return []
}

/** Render a tool_use into searchable text (full params, not truncated). */
function formatToolUse(name: string, input: any): string {
  if (!input) return name
  try {
    switch (name) {
      case 'Read':  return `Read ${input.file_path || ''}${input.offset ? ` offset=${input.offset}` : ''}`
      case 'Write': return `Write ${input.file_path || ''}\n${input.content || ''}`
      case 'Edit':  return `Edit ${input.file_path || ''}\nOLD:\n${input.old_string || ''}\nNEW:\n${input.new_string || ''}`
      case 'Grep':  return `Grep pattern="${input.pattern || ''}" path="${input.path || ''}"`
      case 'Glob':  return `Glob pattern="${input.pattern || ''}"${input.path ? ` path="${input.path}"` : ''}`
      case 'Bash':  return `Bash ${input.command || ''}${input.description ? `  # ${input.description}` : ''}`
      case 'WebSearch': return `WebSearch ${input.query || ''}`
      case 'WebFetch':  return `WebFetch ${input.url || ''} ${input.prompt || ''}`
      case 'Task':  return `Task ${input.description || ''}\n${input.prompt || ''}`
      case 'TodoWrite': return `TodoWrite ${JSON.stringify(input.todos || [])}`
      default: return `${name} ${JSON.stringify(input)}`
    }
  } catch {
    return name
  }
}

// ============================================================
// INCREMENTAL WRITE-THROUGH
// ============================================================

/** Count '\n' bytes up to an offset — for line-number continuity on resume. */
function countLines(filePath: string, upToBytes: number): number {
  if (upToBytes <= 0) return 0
  const cap = Math.min(upToBytes, 4 * 1024 * 1024)
  const buf = Buffer.alloc(cap)
  const fd = openSync(filePath, 'r')
  const n = readSync(fd, buf, 0, cap, Math.max(0, upToBytes - cap))
  closeSync(fd)
  let c = 0
  for (let i = 0; i < n; i++) if (buf[i] === 10) c++
  return c
}

/**
 * Ingest new bytes from a single JSONL file into the store.
 * Reads only from `fromOffset` forward. Returns rows inserted + new offset.
 */
function ingestFile(
  db: Database.Database,
  filePath: string,
  source: string,
  fromOffset: number,
): { inserted: { id: number; text: string }[]; newOffset: number; linesProcessed: number } {
  const inserted: { id: number; text: string }[] = []
  if (!existsSync(filePath)) return { inserted, newOffset: fromOffset, linesProcessed: 0 }

  const fileSize = statSync(filePath).size
  if (fromOffset >= fileSize) return { inserted, newOffset: fromOffset, linesProcessed: 0 }

  const buf = Buffer.alloc(fileSize - fromOffset)
  const fd = openSync(filePath, 'r')
  readSync(fd, buf, 0, buf.length, fromOffset)
  closeSync(fd)

  const rawLines = buf.toString('utf-8').split('\n')
  let lineNum = fromOffset === 0 ? 1 : countLines(filePath, fromOffset) + 1
  let cursor = fromOffset
  let linesProcessed = 0

  const insContent = db.prepare(
    `INSERT INTO content (source, line_num, byte_offset, ts, msg_type, model, git_branch, cwd, tool_name, blob)
     VALUES (@source, @line_num, @byte_offset, @ts, @msg_type, @model, @git_branch, @cwd, @tool_name, @blob)`
  )
  const insFts = db.prepare('INSERT INTO fts (rowid, text) VALUES (?, ?)')

  for (const rawLine of rawLines) {
    const lineByteOffset = cursor
    cursor += Buffer.byteLength(rawLine, 'utf-8') + 1
    if (!rawLine.trim()) { lineNum++; continue }
    linesProcessed++
    try {
      const obj = JSON.parse(rawLine)
      const ts = obj.timestamp ? new Date(obj.timestamp).toISOString() : null
      const gitBranch = obj.gitBranch || null
      const cwd = obj.cwd || null
      for (const rec of extractRecords(obj)) {
        const info = insContent.run({
          source,
          line_num: lineNum,
          byte_offset: lineByteOffset,
          ts,
          msg_type: rec.msgType,
          model: rec.model,
          git_branch: gitBranch,
          cwd,
          tool_name: rec.toolName,
          blob: compress(rec.text),
        })
        const id = Number(info.lastInsertRowid)
        insFts.run(id, rec.text)
        inserted.push({ id, text: rec.text })
      }
    } catch {
      // skip unparseable line
    }
    lineNum++
  }

  return { inserted, newOffset: fileSize, linesProcessed }
}

/**
 * Build or update the session store incrementally.
 * Ingests the main JSONL + all sub-agent JSONLs from their last stored offsets.
 * If `embed` is supplied, newly-inserted rows are embedded into the vec table
 * (best-effort — embedding failure never blocks the keyword write).
 */
export async function updateSessionStore(
  sessionId: string,
  workingDir: string,
  opts?: { embed?: Embedder; onProgress?: (msg: string) => void },
): Promise<StoreStats> {
  const paths = getSessionPaths(sessionId, workingDir)
  const osbDir = getOsbDir(sessionId, workingDir)
  mkdirSync(osbDir, { recursive: true })
  const dbPath = getStorePath(sessionId, workingDir)
  const db = openStore(dbPath)

  try {
    db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)').run('sessionId', sessionId)

    // Resolve every source file: main + sub-agents (both discovery paths).
    const sources: { source: string; path: string }[] = []
    if (existsSync(paths.conversation)) sources.push({ source: 'main', path: paths.conversation })

    for (const f of paths.subagents) {
      const key = basename(f, '.jsonl').replace('agent-', '').substring(0, 8)
      sources.push({ source: `agent-${key}`, path: f })
    }
    for (const a of getSessionSubAgents(sessionId, workingDir)) {
      if (!a.agentFileExists) continue
      const src = `agent-${a.agentId.substring(0, 8)}`
      if (!sources.some(s => s.source === src)) sources.push({ source: src, path: a.agentFile })
    }

    const getSrc = db.prepare('SELECT byte_offset, line_count FROM sources WHERE source = ?')
    const upSrc = db.prepare(
      `INSERT INTO sources(source, jsonl_path, byte_offset, line_count) VALUES (@source,@path,@off,@lines)
       ON CONFLICT(source) DO UPDATE SET jsonl_path=@path, byte_offset=@off, line_count=@lines`
    )

    const freshRows: { id: number; text: string }[] = []
    const txn = db.transaction(() => {
      for (const s of sources) {
        const prev = getSrc.get(s.source) as { byte_offset: number; line_count: number } | undefined
        const fromOffset = prev?.byte_offset ?? 0
        const res = ingestFile(db, s.path, s.source, fromOffset)
        if (res.inserted.length || res.newOffset !== fromOffset) {
          upSrc.run({
            source: s.source, path: s.path, off: res.newOffset,
            lines: (prev?.line_count ?? 0) + res.linesProcessed,
          })
        }
        freshRows.push(...res.inserted)
      }
    })
    txn()

    opts?.onProgress?.(`content: +${freshRows.length} rows across ${sources.length} sources`)

    // ── Embeddings (best-effort, never blocks the keyword layer) ──
    let embeddedRows = 0
    if (opts?.embed && freshRows.length) {
      try {
        embeddedRows = await embedRows(db, freshRows, opts.embed, opts.onProgress)
      } catch (err: any) {
        opts?.onProgress?.(`embed skipped: ${err?.message || err}`)
      }
    }

    db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)').run('updatedAt', new Date().toISOString())

    const totalRows = (db.prepare('SELECT COUNT(*) c FROM content').get() as { c: number }).c
    return {
      totalRows,
      newRows: freshRows.length,
      embeddedRows,
      bytes: statSync(dbPath).size,
    }
  } finally {
    db.close()
  }
}

/** Embed fresh rows in batches and write int8 vectors into the vec table. */
async function embedRows(
  db: Database.Database,
  rows: { id: number; text: string }[],
  embed: Embedder,
  onProgress?: (msg: string) => void,
): Promise<number> {
  // sqlite-vec needs int8 vectors wrapped in vec_int8(), and better-sqlite3 must bind
  // the rowid as a BigInt (a plain JS number binds as REAL, which vec0 rejects as a PK).
  const insVec = db.prepare('INSERT OR REPLACE INTO vec(rowid, embedding) VALUES (?, vec_int8(?))')
  const BATCH = 64
  let done = 0
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH)
    // Cap embedding input length — long tool outputs blow up the model with no recall gain.
    const vectors = await embed(batch.map(r => r.text.slice(0, 8000)))
    if (!vectors) break // embedder unavailable — leave vec empty (keyword-only)
    const writeBatch = db.transaction(() => {
      for (let j = 0; j < batch.length; j++) {
        const v = vectors[j]
        if (v) insVec.run(BigInt(batch[j].id), Buffer.from(v.buffer, v.byteOffset, v.byteLength))
      }
    })
    writeBatch()
    done += batch.length
  }
  if (done) {
    db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)').run('embedded', 'true')
    onProgress?.(`vec: +${done} embeddings`)
  }
  return done
}

// ============================================================
// RECALL (hybrid keyword + vector, RRF fusion)
// ============================================================

/** Escape a free-text query into a safe FTS5 MATCH expression (OR of quoted terms). */
function toFtsMatch(query: string): string {
  const terms = query.match(/[\p{L}\p{N}_]+/gu) || []
  if (!terms.length) return '""'
  return terms.map(t => `"${t}"`).join(' OR ')
}

export interface RecallOpts {
  mode?: 'hybrid' | 'keyword' | 'vector'
  topK?: number
  embed?: Embedder
}

/**
 * Recall the most relevant messages for a query.
 * hybrid  → FTS (BM25) + vec (cosine), fused with Reciprocal Rank Fusion.
 * keyword → FTS only. vector → vec only (needs an embedder).
 * Falls back to keyword automatically when no embeddings/embedder are available.
 */
export async function recall(
  db: Database.Database,
  query: string,
  opts?: RecallOpts,
): Promise<RecallHit[]> {
  const mode = opts?.mode ?? 'hybrid'
  const topK = opts?.topK ?? 8
  const pool = Math.max(topK * 4, 24)

  const hasVec = (db.prepare('SELECT COUNT(*) c FROM vec').get() as { c: number }).c > 0
  const wantVec = (mode === 'hybrid' || mode === 'vector') && hasVec && !!opts?.embed

  // ── keyword ranks ──
  const kw = new Map<number, number>() // id → rank position (0-based)
  if (mode !== 'vector') {
    try {
      const match = toFtsMatch(query)
      const rows = db.prepare(
        'SELECT rowid AS id FROM fts WHERE fts MATCH ? ORDER BY rank LIMIT ?'
      ).all(match, pool) as { id: number }[]
      rows.forEach((r, i) => kw.set(r.id, i))
    } catch {
      // malformed match — ignore keyword leg
    }
  }

  // ── vector ranks ──
  const vec = new Map<number, number>()
  if (wantVec) {
    const qvecs = await opts!.embed!([query])
    const qv = qvecs?.[0]
    if (qv) {
      const rows = db.prepare(
        'SELECT rowid AS id FROM vec WHERE embedding MATCH vec_int8(?) ORDER BY distance LIMIT ?'
      ).all(Buffer.from(qv.buffer, qv.byteOffset, qv.byteLength), pool) as { id: number }[]
      rows.forEach((r, i) => vec.set(r.id, i))
    }
  }

  // ── Reciprocal Rank Fusion ──
  const K = 60
  const fused = new Map<number, { score: number; kw: boolean; vec: boolean }>()
  for (const [id, rankPos] of kw) {
    const cur = fused.get(id) || { score: 0, kw: false, vec: false }
    cur.score += 1 / (K + rankPos); cur.kw = true
    fused.set(id, cur)
  }
  for (const [id, rankPos] of vec) {
    const cur = fused.get(id) || { score: 0, kw: false, vec: false }
    cur.score += 1 / (K + rankPos); cur.vec = true
    fused.set(id, cur)
  }

  const ranked = [...fused.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, topK)
  if (!ranked.length) return []

  const getRow = db.prepare(
    'SELECT id, source, line_num, byte_offset, ts, msg_type, model, git_branch, cwd, tool_name, blob FROM content WHERE id = ?'
  )
  const hits: RecallHit[] = []
  for (const [id, meta] of ranked) {
    const row = getRow.get(id) as any
    if (!row) continue
    hits.push({
      id: row.id,
      source: row.source,
      lineNum: row.line_num,
      byteOffset: row.byte_offset,
      ts: row.ts,
      msgType: row.msg_type,
      model: row.model,
      gitBranch: row.git_branch,
      cwd: row.cwd,
      toolName: row.tool_name,
      text: decompress(row.blob),
      score: meta.score,
      matchedBy: meta.kw && meta.vec ? 'both' : meta.vec ? 'vector' : 'keyword',
    })
  }
  return hits
}
