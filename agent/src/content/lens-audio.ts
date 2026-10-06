/**
 * lens-audio.ts — OPTIONAL, pluggable session-recording lookup (no paid calls).
 *
 * LiveKit egress is not enabled today, so this is a convention-based local
 * lookup. Checks, in order:
 *   1. <projectDir>/recordings/<sessionId>.<media-ext>
 *   2. $OSBORN_RECORDINGS_DIR/<sessionId>.<media-ext>
 * An optional sidecar <sessionId>.json ({ "startedAt": ISO | epoch-ms | "started_at": ns })
 * pins the recording start exactly; without it the start is approximated by the
 * first transcript record's timestamp and offsets are marked approximate.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const MEDIA_EXT = ['.mp4', '.webm', '.ogg', '.opus', '.m4a', '.mp3', '.wav', '.mkv']

export interface SessionRecording {
  path: string
  /** Recording start (epoch ms) if known from a sidecar; else null. */
  startedAtMs: number | null
}

export interface RecordingAlignment {
  path: string
  startIso: string
  approximate: boolean
  basis: string
}

function parseStart(meta: any): number | null {
  if (!meta || typeof meta !== 'object') return null
  const v = meta.startedAt ?? meta.started_at ?? meta.startTime
  if (typeof v === 'string') {
    if (/^\d+$/.test(v)) return parseStart({ startedAt: Number(v) })
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : null
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (v > 1e17) return Math.floor(v / 1e6) // ns (LiveKit egress started_at)
    if (v > 1e14) return Math.floor(v / 1e3) // µs
    if (v > 1e11) return v // ms
    return v * 1000 // s
  }
  return null
}

function lookIn(dir: string, sessionId: string): SessionRecording | null {
  if (!dir || !existsSync(dir)) return null
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return null
  }
  const media = names.find(n => n.startsWith(sessionId + '.') && MEDIA_EXT.some(e => n.toLowerCase().endsWith(e)))
  if (!media) return null
  let startedAtMs: number | null = null
  const side = join(dir, `${sessionId}.json`)
  if (existsSync(side)) {
    try {
      startedAtMs = parseStart(JSON.parse(readFileSync(side, 'utf-8')))
    } catch {
      /* bad sidecar → approximate */
    }
  }
  return { path: join(dir, media), startedAtMs }
}

/** Pluggable lookup. Returns null when no recording exists (the normal case today). */
export function findSessionRecording(sessionId: string, projectDir: string | null): SessionRecording | null {
  if (!sessionId || !/^[A-Za-z0-9._-]{1,128}$/.test(sessionId)) return null
  try {
    if (projectDir) {
      const r = lookIn(join(projectDir, 'recordings'), sessionId)
      if (r) return r
    }
    const envDir = process.env.OSBORN_RECORDINGS_DIR
    return envDir ? lookIn(envDir, sessionId) : null
  } catch {
    return null
  }
}

/** Choose the alignment origin: sidecar start (exact) or first transcript record (approximate). */
export function alignRecording(rec: SessionRecording, firstRecordIso: string | undefined): RecordingAlignment | null {
  if (rec.startedAtMs !== null) {
    return { path: rec.path, startIso: new Date(rec.startedAtMs).toISOString(), approximate: false, basis: 'sidecar startedAt' }
  }
  if (firstRecordIso && Number.isFinite(Date.parse(firstRecordIso))) {
    return { path: rec.path, startIso: firstRecordIso, approximate: true, basis: 'first session record timestamp' }
  }
  return null
}

/**
 * OPTIONAL input adapter for recordings. Every lens stage (period map, clip,
 * library, formats) works on the transcript alone; when an adapter returns an
 * alignment, row ranges additionally get clip offsets, otherwise they stay rows only.
 */
export interface AudioAdapter {
  align(sessionId: string, projectDir: string | null, firstRecordIso: string | undefined): RecordingAlignment | null
}

/** Default adapter: the local convention lookup above (null today — no egress). */
export const localRecordingAdapter: AudioAdapter = {
  align(sessionId, projectDir, firstRecordIso) {
    const rec = findSessionRecording(sessionId, projectDir)
    return rec ? alignRecording(rec, firstRecordIso) : null
  },
}

/** Clip offset "H:MM:SS" of a quote relative to the recording start; null if before start. */
export function clipOffset(quoteIso: string, startIso: string): string | null {
  const d = Date.parse(quoteIso) - Date.parse(startIso)
  if (!Number.isFinite(d) || d < 0) return null
  const s = Math.floor(d / 1000)
  const hh = Math.floor(s / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = s % 60
  return `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}
