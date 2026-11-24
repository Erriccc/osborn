import { settledSyncFailure } from '@/lib/volume-sync'

export type VerifyUpdateResult = { success: true; version: string | null } | { success: false; error: string }

type Deps = {
  fetchFn: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; json: () => Promise<any> }>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  pollMs?: number
  /** After a final error from the update POST: report the stored error once this long has passed, without waiting for the machine to settle. */
  settleMs?: number
}

const BASE_MS = 3 * 60_000
const IN_PROGRESS_CAP_MS = 10 * 60_000

/**
 * Polls `verify-update` until the update outcome is known. The live check wins:
 * a running machine on the target version is success whatever an older stored
 * `lastUpdate` error says. The 3-minute budget stretches to 10 while the stored
 * status is still 'in-progress', so a slow real failure shows its own message.
 */
export async function pollVerifyUpdate(sandboxId: string, targetVersion: string | null, deps: Deps): Promise<VerifyUpdateResult> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const start = now()
  let deadline = start + BASE_MS
  let lastError: string | null = null
  let lastSignals: { machineState?: string | null; installedVersion?: string | null } = {}
  while (now() < deadline) {
    try {
      const r = await deps.fetchFn('/api/sandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'verify-update', sandboxId }),
      })
      if (r.ok) {
        const data = await r.json()
        lastSignals = { machineState: data.machineState, installedVersion: data.installedVersion }
        if (data.lastUpdate?.status === 'in-progress') deadline = start + IN_PROGRESS_CAP_MS
        // Live check first: running on the target version beats any stored outcome.
        if (data.machineState === 'running' && data.installedVersion && targetVersion && data.installedVersion === targetVersion) {
          return { success: true, version: data.installedVersion }
        }
        // A stored outcome only counts for THIS target.
        const lastTargetMatches =
          data.lastUpdate?.targetVersion && targetVersion ? data.lastUpdate.targetVersion === targetVersion : true
        if (data.lastUpdate?.status === 'success' && lastTargetMatches) {
          if (!targetVersion || (data.installedVersion && data.installedVersion === targetVersion)) {
            return { success: true, version: data.lastUpdate.installedVersion ?? null }
          }
        }
        if (data.lastUpdate?.status === 'error' && lastTargetMatches) {
          lastError = data.lastUpdate.error ?? 'Update failed'
          // Honour it only once the live signals settled; a machine still coming up may yet land on the target.
          const down = ['stopped', 'sleeping', 'error'].includes(data.machineState)
          const settled = deps.settleMs !== undefined && now() - start >= deps.settleMs
          if (down || settled || (data.installedVersion && data.installedVersion !== targetVersion)) {
            return { success: false, error: lastError as string }
          }
        }
        const syncFailure = settledSyncFailure(data, targetVersion)
        if (syncFailure) return { success: false, error: syncFailure }
      }
    } catch {
      // Network error during poll: keep retrying until the deadline.
    }
    await sleep(deps.pollMs ?? 4000)
  }
  // Never success without an observed version.
  if (targetVersion && lastSignals.installedVersion === targetVersion) {
    return { success: true, version: lastSignals.installedVersion }
  }
  if (lastError) return { success: false, error: lastError }
  const detail = lastSignals.machineState
    ? ` (machine=${lastSignals.machineState}, installed=${lastSignals.installedVersion ?? 'unknown'})`
    : ''
  const mins = Math.round((deadline - start) / 60_000)
  return { success: false, error: `Verification timed out after ${mins} min${detail}` }
}
