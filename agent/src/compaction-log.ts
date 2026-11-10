/**
 * compaction-log.ts — durable, append-only record of every context compaction.
 *
 * WHY: the frontend's "Conversation compacted · N memories saved" transcript
 * marker (PR #35) was driven by LIVE `compaction_*` data-channel events only, so
 * on resume/reload every past marker vanished — compaction became invisible again.
 * This persists each completed compaction as one JSON line in a SIDECAR next to
 * the session's recall store, so resume/export read the markers back and the UI
 * reconstructs them at their real transcript position.
 *
 * WHERE: `{osbDir}/compactions.jsonl`, i.e. the SAME directory as session.db
 * (~/.claude/projects/{slug}/osb/{sessionId}/). This matters for two reasons:
 *   1. The recall store (session.db) is a RE-DERIVABLE cache of the JSONL —
 *      openStore() DROPs and rebuilds its tables on a version/dim/model bump — so
 *      a marker written INTO session.db would be wiped. A sidecar is not derived
 *      from anything and survives rebuilds.
 *   2. `/sessions/export` tars all of ~/.claude/projects/, so the sidecar travels
 *      with the session automatically (no export change needed).
 *
 * INTEGRITY: the recall store is append-only, so its total row count is
 * monotonically non-decreasing across the life of a session. Each record stamps
 * `transcriptRows` (the store's row count at compaction time); if a later
 * compaction sees FEWER rows than an earlier one, transcript content was dropped
 * between them — checkCompactionIntegrity() flags it and the warning rides the
 * record + event all the way to the marker card.
 *
 * Pure helpers (serialize/parse/integrity/toMarker) take no filesystem or DB and
 * are unit-tested directly (compaction-log.test.ts) — the IO wrappers only add
 * path resolution + append/read.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { getStorePath, storeExists, openStore } from './session-store.js'

/** One persisted compaction. `at` is ISO-8601; `v` guards the line format. */
export interface CompactionRecord {
  v: 1
  /** ISO-8601 timestamp of compaction completion. */
  at: string
  /** What kicked off compaction (e.g. 'auto', 'manual'); carried from PreCompact. */
  trigger?: string
  /** How many durable skill/memory files this compaction wrote. */
  skillsWritten: number
  /** The names of those durable memories/skills (what was kept). */
  skillNames: string[]
  /** Recall-store row count at compaction time — the append-only high-water mark. */
  transcriptRows: number
  /** Set when the integrity self-check detected that content may have been lost. */
  integrityWarning?: string
}

/** The marker shape the frontend consumes (store internals omitted). */
export interface CompactionMarkerWire {
  at: string
  trigger?: string
  skillNames: string[]
  skillsWritten: number
  integrityWarning?: string
}

/** True when `v` is a valid CompactionRecord-ish object (lenient on optionals). */
function isRecordish(o: any): o is CompactionRecord {
  return (
    o && typeof o === 'object' &&
    o.v === 1 &&
    typeof o.at === 'string' && o.at.length > 0 &&
    typeof o.skillsWritten === 'number' &&
    Array.isArray(o.skillNames)
  )
}

/** Serialize one record to a single JSONL line (no trailing newline). */
export function serializeCompactionRecord(rec: CompactionRecord): string {
  return JSON.stringify(rec)
}

/**
 * Parse a compactions.jsonl blob into records, chronological by `at`.
 * Tolerant: blank/unparseable/malformed lines are skipped (a half-written tail
 * line from a crash never breaks the read). Equal timestamps keep file order.
 */
export function parseCompactionLog(text: string): CompactionRecord[] {
  if (!text) return []
  const out: { rec: CompactionRecord; idx: number }[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      const obj = JSON.parse(line)
      if (isRecordish(obj)) {
        // Build minimally — undefined optionals are OMITTED (not set to undefined)
        // so a parse(serialize(rec)) round-trips to the same key set.
        const rec: CompactionRecord = {
          v: 1,
          at: obj.at,
          skillsWritten: obj.skillsWritten,
          skillNames: obj.skillNames.filter((s: unknown): s is string => typeof s === 'string'),
          transcriptRows: typeof obj.transcriptRows === 'number' ? obj.transcriptRows : 0,
        }
        if (typeof obj.trigger === 'string') rec.trigger = obj.trigger
        if (typeof obj.integrityWarning === 'string') rec.integrityWarning = obj.integrityWarning
        out.push({ rec, idx: i })
      }
    } catch {
      // skip unparseable line (e.g. a torn final line)
    }
  }
  out.sort((a, b) => {
    const ta = Date.parse(a.rec.at)
    const tb = Date.parse(b.rec.at)
    const na = Number.isNaN(ta), nb = Number.isNaN(tb)
    if (na && nb) return a.idx - b.idx
    if (na) return 1
    if (nb) return -1
    if (ta !== tb) return ta - tb
    return a.idx - b.idx
  })
  return out.map((x) => x.rec)
}

/**
 * Integrity self-check across a compaction boundary. The recall store is
 * append-only, so `nextRows` (this compaction) must be >= the previous
 * compaction's `transcriptRows`. A shrink means transcript content was dropped
 * (bad rebuild, truncation, JSONL corruption) — return a human-readable warning;
 * otherwise undefined.
 */
export function checkCompactionIntegrity(
  prev: CompactionRecord | undefined,
  nextRows: number,
): string | undefined {
  if (!prev) return undefined
  if (typeof prev.transcriptRows !== 'number') return undefined
  if (nextRows < prev.transcriptRows) {
    return `transcript rows dropped ${prev.transcriptRows}→${nextRows} since the previous compaction — earlier content may have been lost`
  }
  return undefined
}

/** Project a stored record onto the minimal marker the frontend needs. */
export function toCompactionMarker(rec: CompactionRecord): CompactionMarkerWire {
  return {
    at: rec.at,
    trigger: rec.trigger,
    skillNames: rec.skillNames,
    skillsWritten: rec.skillsWritten,
    integrityWarning: rec.integrityWarning,
  }
}

// ── IO wrappers (path resolution + append/read) ─────────────────────────────

/** Sidecar path for a session: next to session.db in the osb dir. */
export function getCompactionLogPath(sessionId: string, workingDir: string): string {
  return join(dirname(getStorePath(sessionId, workingDir)), 'compactions.jsonl')
}

/** Read + parse the sidecar for a session. Missing file → []. */
export function readCompactionRecords(sessionId: string, workingDir: string): CompactionRecord[] {
  const p = getCompactionLogPath(sessionId, workingDir)
  if (!existsSync(p)) return []
  try {
    return parseCompactionLog(readFileSync(p, 'utf-8'))
  } catch {
    return []
  }
}

/** Marker list for the wire (chronological). */
export function readCompactionMarkers(sessionId: string, workingDir: string): CompactionMarkerWire[] {
  return readCompactionRecords(sessionId, workingDir).map(toCompactionMarker)
}

/**
 * Count durable transcript rows in the recall store — the append-only
 * high-water mark used by the integrity check. No store yet → 0.
 */
export function countTranscriptRows(sessionId: string, workingDir: string): number {
  const dbPath = storeExists(sessionId, workingDir)
  if (!dbPath) return 0
  let db: ReturnType<typeof openStore> | undefined
  try {
    db = openStore(dbPath, { readonly: true })
    const row = db.prepare('SELECT COUNT(*) AS c FROM content').get() as { c: number } | undefined
    return row?.c ?? 0
  } catch {
    return 0
  } finally {
    try { db?.close() } catch { /* already closed */ }
  }
}

/**
 * Append one completed compaction to the sidecar and return the full record
 * (with any integrity warning filled in). Runs the append-only self-check
 * against the last existing record first. Never throws out — a persistence
 * failure must not break the compaction pipeline, so IO errors are swallowed
 * after logging by the caller (which also owns emitting the live event).
 */
export function appendCompactionRecord(
  sessionId: string,
  workingDir: string,
  input: {
    at?: string
    trigger?: string
    skillsWritten: number
    skillNames: string[]
    transcriptRows: number
  },
): CompactionRecord {
  const existing = readCompactionRecords(sessionId, workingDir)
  const prev = existing.length ? existing[existing.length - 1] : undefined
  const integrityWarning = checkCompactionIntegrity(prev, input.transcriptRows)
  const rec: CompactionRecord = {
    v: 1,
    at: input.at || new Date().toISOString(),
    trigger: input.trigger,
    skillsWritten: input.skillsWritten,
    skillNames: input.skillNames.filter((s): s is string => typeof s === 'string'),
    transcriptRows: input.transcriptRows,
    ...(integrityWarning ? { integrityWarning } : {}),
  }
  const p = getCompactionLogPath(sessionId, workingDir)
  mkdirSync(dirname(p), { recursive: true })
  appendFileSync(p, serializeCompactionRecord(rec) + '\n', 'utf-8')
  return rec
}
