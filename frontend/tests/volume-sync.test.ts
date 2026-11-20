// The update-failure wording for a machine whose boot could not install osborn
// on its volume (agent /health `volumeSync`).
// Run:  cd frontend && npx tsx tests/volume-sync.test.ts

import assert from 'node:assert/strict'
import { settledSyncFailure, volumeSyncProblem, type VolumeSyncStatus } from '../src/lib/volume-sync'

const diskFull: VolumeSyncStatus = { ok: false, reason: 'disk_full', image: '0.9.295', volume: '0.9.290', freeMb: 12, needMb: 2048 }

// --- volumeSyncProblem --------------------------------------------------------
assert.equal(
  `Update failed: ${volumeSyncProblem(diskFull)}`,
  "Update failed: the machine's disk is full (12 MB free, needs 2,048 MB). Free space or grow the volume, then press Update again.",
)
assert.equal(volumeSyncProblem({ ...diskFull, freeMb: null, needMb: null }), "the machine's disk is full. Free space or grow the volume, then press Update again.")
assert.equal(volumeSyncProblem({ ...diskFull, freeMb: -3 }), "the machine's disk is full (0 MB free, needs 2,048 MB). Free space or grow the volume, then press Update again.")
assert.equal(
  volumeSyncProblem({ ...diskFull, reason: 'npm_failed', detail: 'npm error code E404\nnpm error 404 Not Found - osborn@0.9.295\n' }),
  'the machine could not install v0.9.295 (npm error 404 Not Found - osborn@0.9.295). Press Update again; if it fails again, check the machine log.',
)
assert.equal(volumeSyncProblem({ ...diskFull, ok: true, reason: 'synced' }), null, 'a good sync is no problem')
assert.equal(volumeSyncProblem(null), null, 'older agents send no volumeSync')
assert.equal(volumeSyncProblem(diskFull, '0.9.296'), null, 'a failure for another image does not count')
assert.ok(volumeSyncProblem(diskFull, '0.9.295'))

// --- settledSyncFailure -------------------------------------------------------
const after = { machineState: 'running', installedVersion: '0.9.290', lastUpdate: null, volumeSync: diskFull }
assert.match(settledSyncFailure(after, '0.9.295')!, /disk is full \(12 MB free, needs 2,048 MB\)/, 'the incident: up on the old version, sync of the target failed')
assert.equal(settledSyncFailure({ ...after, lastUpdate: { status: 'in-progress' } }, '0.9.295'), null, 'mid-update: keep waiting')
assert.equal(settledSyncFailure({ ...after, machineState: 'stopped' }, '0.9.295'), null, 'machine not up yet')
assert.equal(settledSyncFailure({ ...after, installedVersion: '0.9.295' }, '0.9.295'), null, 'on the target: not a failure')
assert.equal(settledSyncFailure({ ...after, volumeSync: { ...diskFull, image: '0.9.290' } }, '0.9.295'), null, 'status from the boot before the update')
assert.equal(settledSyncFailure(after, null), null, 'no target known')
assert.equal(settledSyncFailure({ ...after, volumeSync: null }, '0.9.295'), null)

console.log('volume-sync: all assertions passed')
