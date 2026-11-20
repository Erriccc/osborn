// The machine's boot-time sync of osborn onto its volume (agent /health
// `volumeSync`, written by Dockerfile.sandbox). Client-safe: used by
// machines.ts, the sandbox route and the Settings / dashboard update flows.

export interface VolumeSyncStatus {
  ok: boolean
  reason: string
  image: string | null
  volume: string | null
  freeMb: number | null
  needMb: number | null
  detail?: string | null
  at?: string | null
}

const mb = (n: number | null | undefined) => (typeof n === 'number' ? `${Math.max(0, Math.round(n)).toLocaleString('en-US')} MB` : null)

/**
 * Plain words for a failed sync, to follow "Update failed: ", or null when the
 * sync is fine or unknown. `forVersion` limits it to a sync of that image.
 */
export function volumeSyncProblem(s: VolumeSyncStatus | null | undefined, forVersion?: string | null): string | null {
  if (!s || s.ok) return null
  if (forVersion && s.image && s.image !== forVersion) return null
  if (s.reason === 'disk_full') {
    const free = mb(s.freeMb)
    const need = mb(s.needMb)
    const sizes = free && need ? ` (${free} free, needs ${need})` : free ? ` (${free} free)` : ''
    return `the machine's disk is full${sizes}. Free space or grow the volume, then press Update again.`
  }
  const lastLine = (s.detail ?? '').trim().split('\n').pop()?.trim()
  return `the machine could not install v${s.image ?? '?'}${lastLine ? ` (${lastLine})` : ''}. Press Update again; if it fails again, check the machine log.`
}

/**
 * During verify-update polling: the sync failure that settles the update, or
 * null to keep waiting. Only a sync of the target image, once the server is no
 * longer mid-update and the machine is up on another version, so the status
 * left by the boot before the update cannot end it early.
 */
export function settledSyncFailure(
  data: { machineState?: string | null; installedVersion?: string | null; lastUpdate?: { status?: string } | null; volumeSync?: VolumeSyncStatus | null },
  targetVersion: string | null,
): string | null {
  if (!targetVersion || data.lastUpdate?.status === 'in-progress') return null
  if (data.machineState !== 'running' || !data.installedVersion || data.installedVersion === targetVersion) return null
  if (data.volumeSync?.image !== targetVersion) return null
  return volumeSyncProblem(data.volumeSync, targetVersion)
}
