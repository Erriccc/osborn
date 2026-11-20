// The sandbox entrypoint (Dockerfile.sandbox) syncs the volume's osborn copy to
// the image's version on boot and writes the outcome as JSON. /health serves it
// as `volumeSync` so the dashboard can say why an update did not take
// (disk full, npm failed) instead of timing out.
import { readFileSync } from 'node:fs'

export interface VolumeSyncStatus {
  ok: boolean
  /** synced | up_to_date | disk_full | npm_failed */
  reason: string
  image: string | null
  volume: string | null
  freeMb: number | null
  needMb: number | null
  detail: string | null
  at: string | null
}

/** /tmp is written only when the volume could not take the file on this boot, so it wins. */
export const VOLUME_SYNC_STATUS_FILES = ['/tmp/osborn-sync-status', '/workspace/.osborn-sync-status']

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v ? v.slice(0, max) : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** The newest sync outcome, or null off a sandbox (no file) or when the file is unreadable. */
export function readVolumeSyncStatus(files: string[] = VOLUME_SYNC_STATUS_FILES): VolumeSyncStatus | null {
  for (const file of files) {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    if (!raw || typeof raw !== 'object' || typeof (raw as { ok?: unknown }).ok !== 'boolean') continue
    const r = raw as Record<string, unknown>
    return {
      ok: r.ok as boolean,
      reason: str(r.reason, 40) ?? 'unknown',
      image: str(r.image, 64),
      volume: str(r.volume, 64),
      freeMb: num(r.freeMb),
      needMb: num(r.needMb),
      detail: str(r.detail, 600),
      at: str(r.at, 40),
    }
  }
  return null
}
