#!/usr/bin/env node
/**
 * bake-golden-snapshot.mjs — produce a "golden" Fly volume snapshot for fast
 * new-user provisioning.
 *
 * Architecture context:
 *   The chroot architecture (Dockerfile.sandbox) seeds /etc and default skills
 *   onto the persistent volume on first boot. For new users that takes ~60-90s.
 *   With this snapshot, the volume comes up PRE-SEEDED so first-boot drops to
 *   ~15-20s (just boot init + chroot mount re-attach + osborn launch).
 *
 * Critical privacy invariant (verified 2026-05-28):
 *   The snapshot MUST be taken before any user-private data lands on the volume.
 *   That means:
 *     - No Claude OAuth completed (no .credentials.json, no .oauth-token)
 *     - No user chat() (no projects/<slug>/*.jsonl)
 *     - No gh/ssh/git credentials (no ~/.gh, ~/.ssh, ~/.gitconfig)
 *   This script controls the sacrificial machine and stops it as soon as
 *   /workspace/.chroot-seeded appears — well before any auth flow can fire.
 *
 * Usage:
 *   FLY_API_TOKEN=<token> \
 *   FLY_IMAGE=registry.fly.io/osborn-sandbox/agent:0.9.47 \
 *   node frontend/scripts/bake-golden-snapshot.mjs
 *
 *   Prints: GOLDEN_SNAPSHOT_ID=vs_xxxxxxxxxxxxx
 *
 * Set this snapshot ID as FLY_GOLDEN_SNAPSHOT_ID on Railway. createSandbox
 * picks it up automatically and provisions all new user volumes from it.
 *
 * Refresh policy:
 *   Re-run this script after any image-version bump that affects /etc or
 *   skills content. osborn binary upgrades alone don't need a fresh snapshot
 *   (osborn lives in image's /usr/local, bind-mounted, image-swap refreshes).
 */

import { setTimeout as sleep } from 'node:timers/promises'

const FLY_API = process.env.FLY_API_HOSTNAME || 'https://api.machines.dev'
const TOKEN = process.env.FLY_API_TOKEN
const IMAGE = process.env.FLY_IMAGE || 'registry.fly.io/osborn-sandbox/agent:latest'
const ORG = process.env.FLY_ORG || 'personal'
const REGION = process.env.FLY_REGION || 'iad'
const SACRIFICIAL_APP = process.env.FLY_BAKE_APP || `osborn-snapshot-bake-${Date.now().toString(36)}`

if (!TOKEN) {
  console.error('Error: FLY_API_TOKEN env required')
  process.exit(1)
}

async function flyApi(method, path, body) {
  const res = await fetch(`${FLY_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`${method} ${path} → HTTP ${res.status}: ${text.substring(0, 300)}`)
  }
  if (res.status === 204) return null
  return await res.json()
}

async function flyExec(appName, machineId, cmd, timeoutSec = 60) {
  return await flyApi('POST', `/v1/apps/${appName}/machines/${machineId}/exec`, {
    command: cmd,
    timeout: timeoutSec,
  })
}

function log(msg) {
  console.error(`[bake] ${msg}`)
}

async function main() {
  log(`Image: ${IMAGE}`)
  log(`Sacrificial app: ${SACRIFICIAL_APP}`)
  log(`Region: ${REGION}`)

  // 1. Create sacrificial app
  log('Creating sacrificial app...')
  try {
    await flyApi('POST', '/v1/apps', { app_name: SACRIFICIAL_APP, org_slug: ORG })
  } catch (err) {
    if (!String(err).includes('already exists')) throw err
    log('App already exists, continuing')
  }

  // 2. Create empty volume (small — golden snapshot is tiny per B4 measurement)
  log('Creating fresh empty volume...')
  const vol = await flyApi('POST', `/v1/apps/${SACRIFICIAL_APP}/volumes`, {
    name: 'workspace',
    region: REGION,
    size_gb: 3, // smaller than user volumes (10GB); snapshot can restore into larger
    encrypted: true,
  })
  log(`Volume: ${vol.id}`)

  // 3. Spin sacrificial machine with the new image. NO real env vars — we
  //    don't want anything user-specific persisted. The agent will fail to
  //    connect to LiveKit (no credentials) but that doesn't matter; we only
  //    need the entrypoint's first-boot chroot seed to run.
  log('Spinning sacrificial machine...')
  const machine = await flyApi('POST', `/v1/apps/${SACRIFICIAL_APP}/machines`, {
    name: 'osborn-bake',
    region: REGION,
    config: {
      image: IMAGE,
      env: {
        // Deliberately minimal — no LIVEKIT_*, no API keys. Agent will error
        // but entrypoint's chroot seed still runs first.
        OSBORN_API_PORT: '8741',
      },
      mounts: [{ volume: vol.id, path: '/workspace' }],
      guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 512 },
      auto_destroy: false,
      restart: { policy: 'no' },
    },
  })
  log(`Machine: ${machine.id}`)

  // 4. Wait for the chroot-seeded marker to appear on the volume.
  //    The entrypoint writes /workspace/.chroot-seeded RIGHT AFTER seeding
  //    /etc + default skills, BEFORE any user activity could occur.
  log('Waiting for /workspace/.chroot-seeded marker (max 120s)...')
  const seededDeadline = Date.now() + 120_000
  let seeded = false
  while (Date.now() < seededDeadline) {
    try {
      const res = await flyExec(SACRIFICIAL_APP, machine.id, ['test', '-f', '/workspace/.chroot-seeded'], 5)
      const exitCode = res?.exit_code ?? res?.exitCode ?? 1
      if (exitCode === 0) {
        seeded = true
        log('Marker found ✓')
        break
      }
    } catch (err) {
      log(`exec probe error (will retry): ${String(err).substring(0, 100)}`)
    }
    await sleep(3000)
  }
  if (!seeded) throw new Error('Timed out waiting for chroot-seeded marker')

  // 5. CRITICAL: stop the machine BEFORE snapshotting to avoid in-flight
  //    OAuth or chat data landing on the volume. Also gives the cleanest
  //    snapshot per B1 (running snapshots have no consistency guarantee
  //    per Fly docs; stopped snapshot is documented as safe).
  log('Stopping sacrificial machine for clean snapshot...')
  await flyApi('POST', `/v1/apps/${SACRIFICIAL_APP}/machines/${machine.id}/stop`)
  // Wait until state is actually stopped
  for (let i = 0; i < 30; i++) {
    const m = await flyApi('GET', `/v1/apps/${SACRIFICIAL_APP}/machines/${machine.id}`)
    if (m.state === 'stopped') break
    await sleep(2000)
  }

  // 6. Create snapshot
  log('Creating volume snapshot...')
  const snapshotRes = await flyApi(
    'POST',
    `/v1/apps/${SACRIFICIAL_APP}/volumes/${vol.id}/snapshots`,
  )
  log(`Snapshot initiated: ${JSON.stringify(snapshotRes).substring(0, 200)}`)

  // 7. Poll snapshot list until our new one is in state='created'
  log('Polling snapshot list until state=created (max 5min)...')
  const snapDeadline = Date.now() + 5 * 60_000
  let snapshotId = null
  while (Date.now() < snapDeadline) {
    const snaps = await flyApi('GET', `/v1/apps/${SACRIFICIAL_APP}/volumes/${vol.id}/snapshots`)
    const list = Array.isArray(snaps) ? snaps : (snaps?.snapshots ?? [])
    // Find the most recent (highest created_at)
    const sorted = list.slice().sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    if (sorted.length > 0) {
      const latest = sorted[0]
      log(`  state=${latest.status || latest.state} id=${latest.id}`)
      if ((latest.status || latest.state) === 'created') {
        snapshotId = latest.id
        break
      }
    }
    await sleep(10_000)
  }
  if (!snapshotId) throw new Error('Snapshot did not reach state=created within 5min')

  // 8. Teardown sacrificial machine + volume (snapshot survives independently)
  log('Tearing down sacrificial machine...')
  try {
    await flyApi('DELETE', `/v1/apps/${SACRIFICIAL_APP}/machines/${machine.id}?force=true`)
  } catch (err) {
    log(`(non-fatal) machine destroy failed: ${err.message}`)
  }
  log('Tearing down sacrificial volume...')
  try {
    await flyApi('DELETE', `/v1/apps/${SACRIFICIAL_APP}/volumes/${vol.id}`)
  } catch (err) {
    log(`(non-fatal) volume destroy failed: ${err.message}`)
  }
  // We leave the app itself in place — apps are cheap and reusing avoids the
  // "App name reuse blocked for 24h" Fly behavior. Future runs can use the
  // same app.

  log('=== DONE ===')
  console.log(`GOLDEN_SNAPSHOT_ID=${snapshotId}`)
  console.log(`# Set on Railway: FLY_GOLDEN_SNAPSHOT_ID=${snapshotId}`)
}

main().catch((err) => {
  console.error(`[bake] FATAL: ${err.stack || err.message || err}`)
  process.exit(1)
})
