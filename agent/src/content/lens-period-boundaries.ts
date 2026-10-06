/**
 * lens-period-boundaries.ts — compaction seams in the raw session.db store
 * (read-only). Owned by the period map; the clipper re-exports it.
 *
 * A seam is a main-session user row that STARTS with compaction evidence: a
 * <session_tail …> replay block, "Conversation compacted", or the
 * "(This session is being) continued from a previous conversation" lead.
 * A mention of those phrases later in a genuine utterance is not a seam.
 */

import { brotliDecompressSync } from 'node:zlib'
import Database from 'better-sqlite3'

const BOUNDARY_HEAD_RE =
  /^\s*(?:\[time:[^\]]*\]\s*)?(?:<session_tail\b[^>]*>|Conversation compacted\b|(?:This session is being )?continued from a previous conversation)/i

/** True when a user row's text begins with compaction evidence. Pure. */
export function isCompactionBoundaryHead(text: string): boolean {
  return BOUNDARY_HEAD_RE.test(text ?? '')
}

/** content.ids of compaction seams, ascending. */
export function readCompactionBoundaries(dbPath: string): number[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    db.pragma('busy_timeout = 5000')
    const out: number[] = []
    const stmt = db.prepare(`SELECT id, blob FROM content WHERE msg_type = 'user' AND source = 'main' ORDER BY id`)
    for (const r of stmt.iterate() as Iterable<{ id: number; blob: Buffer }>) {
      let head = ''
      try {
        head = brotliDecompressSync(r.blob).toString('utf-8').slice(0, 400)
      } catch {
        continue
      }
      if (isCompactionBoundaryHead(head)) out.push(r.id)
    }
    return out
  } finally {
    db.close()
  }
}
