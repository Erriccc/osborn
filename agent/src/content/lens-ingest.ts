/**
 * lens-ingest.ts — sends a published library page to the cloud content library
 * as a private DRAFT through the Supabase RPC `public.content_ingest(p_token,
 * p_payload)` (migration 007). This is the module behind the ingest seam in
 * lens-library.ts.
 *
 * - Auth: the machine's per-user OSBORN_SYNC_TOKEN is the credential. The RPC
 *   resolves the owner server-side. PostgREST is called with the PUBLIC anon key
 *   (shipped by the frontend by design). A service key is never used: any key
 *   whose JWT role isn't "anon" is refused.
 * - Fail-open: never throws. Times out after ~10s. Logs outcomes only (never the
 *   token, URL query, headers or body).
 * - Opt-out: OSBORN_CONTENT_INGEST=0. OSBORN_CONTENT_LENS=0 disables it too.
 * - Never sends a status. The server forces draft anyway.
 * - Idempotent: content_hash = sha256(sessionId, startRowId, page markdown), so
 *   re-runs upsert instead of duplicating.
 */

import { createHash } from 'node:crypto'
import { isContentLensEnabled } from './lens-launch.js'
import { parsePage } from './lens-library-index.js'

/** Public project values the frontend ships (NEXT_PUBLIC_*). The anon key is public by design. */
const DEFAULT_SUPABASE_URL = 'https://frzbawsadhmmltokvexj.supabase.co'
const DEFAULT_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZyemJhd3NhZGhtbWx0b2t2ZXhqIiwicm9sZSI6ImFub24iLCJpYXQiOjE2Nzg3MzgxMjcsImV4cCI6MTk5NDMxNDEyN30.KAHO-apaXL3G7mBTZ17r8GN0vXoOZIL7d_HzKr7hJjc'

export const INGEST_MAX_BYTES = 250 * 1024
export const INGEST_TIMEOUT_MS = 10_000

export type IngestStatus = 'ok' | 'error' | 'skipped' | 'oversize'
export interface IngestState {
  status: IngestStatus
  /** 'disabled' | 'no-token' | 'no-url' | 'no-key' | 'http-500' | 'timeout' | 'network' | 'oversize' ... */
  reason?: string
  contentHash: string
  httpStatus?: number
  id?: string
  at: string
}

/** The minimal page shape ingest needs (fresh pages and manifest retries both map to it). */
export interface IngestPage {
  sessionId: string
  startRowId: number
  endRowId: number
  index: number
  closedBy: number | 'compaction' | null
  file: string
  /** The page exactly as written to disk (already redacted by the library step). */
  markdown: string
}

export interface IngestOptions {
  /** Re-redaction applied to every text field before sending (client redactor + redactSecrets). */
  scrub?: (s: string) => string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  log?: (m: string) => void
}

const OFF = ['0', 'off', 'false', 'no']
export function isIngestEnabled(): boolean {
  if (!isContentLensEnabled()) return false
  return !OFF.includes((process.env.OSBORN_CONTENT_INGEST ?? '').trim().toLowerCase())
}

/** True only for keys safe to send from a machine: anon JWTs or sb_publishable_ keys. */
export function isAnonKey(key: string): boolean {
  if (key.startsWith('sb_publishable_')) return true
  const parts = key.split('.')
  if (parts.length !== 3) return false
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'))?.role === 'anon'
  } catch {
    return false
  }
}

export type IngestConfig = { ok: true; url: string; anonKey: string; token: string } | { ok: false; reason: string }

export function resolveIngestConfig(): IngestConfig {
  if (!isIngestEnabled()) return { ok: false, reason: 'disabled' }
  const token = (process.env.OSBORN_SYNC_TOKEN ?? '').trim()
  if (!token) return { ok: false, reason: 'no-token' }
  const e = process.env
  const url = (e.OSBORN_SUPABASE_URL ?? e.SUPABASE_URL ?? e.NEXT_PUBLIC_SUPABASE_URL ?? DEFAULT_SUPABASE_URL).trim().replace(/\/+$/, '')
  if (!/^https:\/\/[^/?#]+$/.test(url)) return { ok: false, reason: 'no-url' }
  const anonKey = [e.OSBORN_SUPABASE_ANON_KEY, e.SUPABASE_ANON_KEY, e.NEXT_PUBLIC_SUPABASE_ANON_KEY, DEFAULT_ANON_KEY]
    .map(k => (k ?? '').trim())
    .find(k => k && isAnonKey(k))
  if (!anonKey) return { ok: false, reason: 'no-key' }
  return { ok: true, url, anonKey, token }
}

export function contentHashFor(p: Pick<IngestPage, 'sessionId' | 'startRowId' | 'markdown'>): string {
  return createHash('sha256').update(`${p.sessionId}\n${p.startRowId}\n${p.markdown}`).digest('hex')
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s)
const SESSION_ID_RE = /^[a-zA-Z0-9._-]{1,128}$/

/** Map a page to the content_ingest payload. Never includes status/published_at/owner. */
export function buildIngestPayload(p: IngestPage, scrub: (s: string) => string = s => s): Record<string, unknown> {
  const summary = parsePage(p.file, p.markdown)
  const nn = String(p.index).padStart(2, '0')
  const goal = summary.goal && summary.goal !== '(no verified goal)' ? summary.goal : ''
  const title = clip(scrub(goal ? `Period ${nn}: ${goal}` : `Period ${nn}`), 200)
  const hook = clip(scrub(summary.topItem ?? goal ?? ''), 280)
  return {
    type: 'text_post',
    title,
    hook: hook || null,
    body: scrub(p.markdown),
    source_session_id: SESSION_ID_RE.test(p.sessionId) ? p.sessionId : null,
    source_anchors: { start_row_id: p.startRowId, end_row_id: p.endRowId, closed_by: p.closedBy, period_index: p.index, file: p.file },
    source_kind: 'library_page',
    content_hash: contentHashFor(p),
  }
}

/** POST one page to content_ingest. Never throws; returns the state to record in the manifest. */
export async function ingestPage(p: IngestPage, o: IngestOptions = {}): Promise<IngestState> {
  const log = o.log ?? (() => {})
  const at = new Date().toISOString()
  let contentHash = ''
  const tag = `library: ingest period ${p.index} (#${p.startRowId})`
  try {
    contentHash = contentHashFor(p)
    const cfg = resolveIngestConfig()
    if (!cfg.ok) return { status: 'skipped', reason: (cfg as { reason: string }).reason, contentHash, at }
    const payload = buildIngestPayload(p, o.scrub)
    const body = JSON.stringify({ p_token: cfg.token, p_payload: payload })
    const bytes = Buffer.byteLength(body, 'utf-8')
    if (bytes > INGEST_MAX_BYTES) {
      log(`${tag} → skipped: payload ${bytes} bytes > ${INGEST_MAX_BYTES}`)
      return { status: 'oversize', reason: 'oversize', contentHash, at }
    }
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? INGEST_TIMEOUT_MS)
    try {
      const res = await (o.fetchImpl ?? fetch)(`${cfg.url}/rest/v1/rpc/content_ingest`, {
        method: 'POST',
        // This project's PostgREST db_schema lists `storage` first, so the profile headers are required to hit public.content_ingest.
        headers: { apikey: cfg.anonKey, Authorization: `Bearer ${cfg.anonKey}`, 'Content-Type': 'application/json', 'Content-Profile': 'public', 'Accept-Profile': 'public' },
        body,
        signal: ctl.signal,
      })
      const text = await res.text().catch(() => '')
      if (!res.ok) {
        // Only the sanitized PostgREST code (e.g. 28000) and hint are logged, never the message or body.
        let code = ''
        let hint = ''
        try {
          const j = JSON.parse(text)
          code = String(j?.code ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8)
          hint = String(j?.hint ?? '').replace(/[^A-Za-z0-9 ._-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80)
        } catch { /* not JSON */ }
        log(`${tag} → failed: HTTP ${res.status}${code ? ` code=${code}` : ''}${hint ? ` hint="${hint}"` : ''} (will retry next run)`)
        return { status: 'error', reason: `http-${res.status}`, httpStatus: res.status, contentHash, at }
      }
      let id: string | undefined
      try { const v = JSON.parse(text); if (typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v)) id = v } catch { /* ignore */ }
      log(`${tag} → ok: draft saved (HTTP ${res.status})`)
      return { status: 'ok', httpStatus: res.status, ...(id ? { id } : {}), contentHash, at }
    } finally {
      clearTimeout(timer)
    }
  } catch (e: any) {
    const reason = e?.name === 'AbortError' ? 'timeout' : 'network'
    log(`${tag} → failed: ${reason} (will retry next run)`)
    return { status: 'error', reason, contentHash, at }
  }
}

/** Does this manifest entry still need an ingest attempt? */
export function needsIngest(state: IngestState | undefined, currentHash: string): boolean {
  if (!state) return true
  if (state.contentHash !== currentHash) return true
  return state.status !== 'ok' && state.status !== 'oversize'
}
