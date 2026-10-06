/**
 * content-manifest.ts — Stage A per-period / per-piece state in
 *   <library dir>/.content-manifest.json
 * mirroring lens-library.ts's .library-manifest.json (same dir, keyed on the
 * period's opening row id).
 *
 * Idempotency rules (content-run.ts):
 *   - period "done"  → skipped, no model call, no spend.
 *   - piece "ready"   → checks passed; only the ingest is (re)tried, no model call.
 *   - piece "ingested" / "blocked" → terminal. Blocked is NEVER auto-fixed or retried.
 *   - piece "error" / "capped" → regenerated next run (research + truth-check caches still apply).
 *   - the period's plan (topics, research refs, briefs) is stored once and reused.
 * Never throws on read (missing / unreadable → empty).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { IngestState } from './lens-ingest.js'

export const CONTENT_MANIFEST_FILE = '.content-manifest.json'
/** Script drafts on disk: <library dir>/content/period-NN/<piece>.{json,md} */
export const CONTENT_DIR = 'content'

export type PieceKind = 'highlight' | 'howto'
export type PieceStatus = 'ready' | 'ingested' | 'blocked' | 'error' | 'capped'
export type PeriodStatus = 'done' | 'partial' | 'capped' | 'error' | 'dry' | 'no-pieces'

export interface CheckSummary {
  prepass: { ok: boolean; flags: string[]; rows: { line: number; row: number; match: string }[] }
  truth: { ok: boolean; flags: string[]; model: string; provider: string; cacheKey: string; cached: boolean } | null
  audience: { ok: boolean; flags: string[]; model: string; provider: string } | null
  length: { ok: boolean; seconds: number; min: number; max: number }
}

export interface PieceEntry {
  id: string
  kind: PieceKind
  status: PieceStatus
  title: string
  /** Every flag from every check (empty unless blocked). */
  flags: string[]
  checks?: CheckSummary
  /** Stable per piece (session + period + piece id), so later media attach hits the same row. */
  contentHash?: string
  ingest?: IngestState
  /** Script JSON on disk, relative to the library dir. */
  file?: string
  costUsd: number
  errors: string[]
  updatedAt: string
}

export interface PeriodEntry {
  startRowId: number
  endRowId: number
  index: number
  /** The library page this period's content was built from (file name in the library dir). */
  page: string
  status: PeriodStatus
  /** Cumulative spend for this period across runs (the per-period cap reads this). */
  costUsd: number
  /** Topics + briefs, stored once so a rerun never re-plans. */
  plan?: unknown
  pieces: Record<string, PieceEntry>
  errors: string[]
  updatedAt: string
}

export interface ContentManifest {
  version: 1
  sessionId: string
  /** key = String(startRowId) */
  periods: Record<string, PeriodEntry>
}

export function readContentManifest(dir: string, sessionId: string): ContentManifest {
  try {
    const o = JSON.parse(readFileSync(join(dir, CONTENT_MANIFEST_FILE), 'utf-8'))
    if (o && typeof o.periods === 'object' && !Array.isArray(o.periods)) return { version: 1, sessionId, periods: o.periods }
  } catch {
    /* missing / unreadable → empty */
  }
  return { version: 1, sessionId, periods: {} }
}

export function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text, 'utf-8')
  renameSync(tmp, path)
}

export function writeContentManifest(dir: string, m: ContentManifest): void {
  mkdirSync(dir, { recursive: true })
  writeAtomic(join(dir, CONTENT_MANIFEST_FILE), JSON.stringify(m, null, 2) + '\n')
}

export const isPieceTerminal = (p: PieceEntry | undefined): boolean => !!p && (p.status === 'ingested' || p.status === 'blocked')
/** Checks done (ready / ingested / blocked): never regenerated. */
export const isPieceSettled = (p: PieceEntry | undefined): boolean => !!p && (isPieceTerminal(p) || p.status === 'ready')

/**
 * Period status from its pieces. `ingestPending` = some ready piece still needs an
 * ingest that can be retried for free; the period then stays "partial".
 */
export function periodStatusFor(e: PeriodEntry, o: { dry: boolean; ingestPending: boolean; planned: boolean }): PeriodStatus {
  const ps = Object.values(e.pieces)
  if (o.planned && ps.length === 0) return 'no-pieces'
  if (ps.some(p => p.status === 'capped')) return 'capped'
  if (!o.planned || ps.some(p => p.status === 'error')) return ps.some(p => isPieceSettled(p)) ? 'partial' : 'error'
  if (o.dry) return 'dry'
  return o.ingestPending ? 'partial' : 'done'
}

export const periodDirName = (index: number): string => `period-${String(index).padStart(2, '0')}`
