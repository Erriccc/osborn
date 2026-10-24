/**
 * machine-pool.ts — warm machine pool for Fly Machines sandboxes.
 *
 * Founder's model: a new user's first session should start in SECONDS.
 * Assignment should be "one DB row + waking a pre-provisioned machine", not a
 * 1-2 minute cold app+volume+machine create. This module keeps ~2 spares warm:
 *
 *   ensurePool(min)      — top the pool up to `min` spare machines (idempotent,
 *                          mutex-guarded against concurrent over-provisioning).
 *                          Boot: called fire-and-forget from instrumentation.ts.
 *                          Assign: called fire-and-forget after each claim.
 *   takeSpareFromPool()  — atomically claim one spare (service-role DB update),
 *                          repoint its env at the real user, start + health-wait.
 *                          ANY failure → null → caller falls back to legacy
 *                          createSandbox.
 *   replenishPool()      — fire-and-forget ensurePool() wrapper.
 *
 * Pool machines are ordinary osborn sandboxes created via machines.ts's
 * createSandboxRaw with `osborn-pool-*` names, given the FULL platform env
 * (forwardHostEnv — Z_AI_PERSONAL_API_KEY etc.), then stopped COLD. A stopped
 * Fly machine with volume + image in place costs ~nothing and boots in seconds.
 *
 * Pool bookkeeping lives in the `machine_pool` Supabase table, accessed ONLY
 * with the service-role key (RLS enabled, zero policies — the anon/authed
 * clients can neither read nor write it). status ∈ spare | assigned | dead.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  isMachinesConfigured,
  createSandboxRaw,
  stopMachineCold,
  repointAndStartSandbox,
  type SandboxInfo,
} from './machines'

// ─────────────────────────────────────────
// Config
// ─────────────────────────────────────────

const POOL_MIN_SPARES = 2

function getPoolClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.warn('[machine-pool] SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_URL missing — pool disabled')
    return null
  }
  // Created per call (cheap) so env changes between hot reloads are picked up.
  return createClient(url, key, { auth: { persistSession: false } })
}

function poolAppName(): string {
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(6)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
  return `osborn-pool-${rand}`
}

// ─────────────────────────────────────────
// ensurePool — top up spares (mutex-guarded)
// ─────────────────────────────────────────

let poolEnsuring = false

/**
 * Bring the pool to `min` spare machines. Safe to call concurrently: a module-
 * level flag ensures only one replenish loop runs at a time (callers that
 * arrive while one is in flight return immediately rather than queueing a
 * second pass — the next claim/boot trigger will re-check).
 */
export async function ensurePool(min: number = POOL_MIN_SPARES): Promise<void> {
  if (poolEnsuring) return
  if (!isMachinesConfigured()) return
  const supabase = getPoolClient()
  if (!supabase) return

  poolEnsuring = true
  try {
    const { count, error } = await supabase
      .from('machine_pool')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'spare')
    if (error) {
      console.warn(`[machine-pool] spare count failed: ${error.message}`)
      return
    }
    const missing = Math.max(0, min - (count ?? 0))
    if (missing === 0) return
    console.log(`[machine-pool] ${count}/${min} spares — provisioning ${missing}`)

    for (let i = 0; i < missing; i++) {
      await provisionSpare(supabase)
    }
  } finally {
    poolEnsuring = false
  }
}

/**
 * Provision one spare machine: create the Fly app+volume+machine (FULL
 * platform env, placeholder owner), register it as 'spare', then stop it cold.
 * On any failure the Fly resources are left as-is and nothing is registered —
 * orphaned app cleanup can be handled manually; never registered = never
 * handed to a user.
 */
async function provisionSpare(supabase: SupabaseClient): Promise<void> {
  const appName = poolAppName()
  try {
    // Provision via createSandbox's machinery. No instances row is written —
    // createSandboxRaw only touches Fly; DB writes live with the callers.
    const info = await createSandboxRaw(
      appName,
      'pool', // placeholder owner — repointed at claim time
      { autostopMode: 'off' },
      { skipHealthWait: true }, // state wait above proves it boots; we cold-stop next anyway
    )
    if (info.status === 'error') {
      throw new Error(info.error || 'provisioning returned error status')
    }

    const { error: regErr } = await supabase
      .from('machine_pool')
      .insert({ app_name: appName, status: 'spare' })
    if (regErr) throw new Error(`machine_pool insert failed: ${regErr.message}`)

    await stopMachineCold(appName)
    console.log(`[machine-pool] spare ready: ${appName}`)
  } catch (err) {
    console.error(`[machine-pool] provisioning ${appName} failed: ${(err as Error).message}`)
  }
}

/**
 * Fire-and-forget replenish — never throws, never blocks the caller.
 */
export function replenishPool(): void {
  void ensurePool().catch((err) => {
    console.warn(`[machine-pool] replenish failed: ${(err as Error).message}`)
  })
}

// ─────────────────────────────────────────
// takeSpareFromPool — claim + repoint + start
// ─────────────────────────────────────────

export async function takeSpareFromPool(
  userId: string,
  options?: { sourceSnapshotId?: string; syncToken?: string },
): Promise<SandboxInfo | null> {
  if (!isMachinesConfigured()) return null
  const supabase = getPoolClient()
  if (!supabase) return null

  // Atomically claim one spare. PostgREST UPDATE ... LIMIT 1 ... RETURNING gives
  // us the claimed row. Concurrent claimers are safe: PostgREST runs a single
  // UPDATE whose WHERE re-evaluates after row locks, so a second concurrent
  // claimer that loses the race gets 0 rows back. 0 rows = pool empty — return
  // null immediately (caller falls back to legacy createSandbox; we never block
  // a user synchronously on provisioning a new spare).
  const { data, error } = await supabase
    .from('machine_pool')
    .update({ status: 'assigned', assigned_to: userId, assigned_at: new Date().toISOString() })
    .eq('status', 'spare')
    .limit(1)
    .select('id, app_name')
  if (error) {
    console.warn(`[machine-pool] claim update failed: ${error.message}`)
    return null
  }
  if (!data || data.length === 0) return null
  const claimedRowId: string = data[0].id
  const appName: string = data[0].app_name

  try {
    // Repoint the user-specific env (LIVEKIT_ROOM / DEV_APP_NAME /
    // OSBORN_SYNC_TOKEN) at the real user, then start + health-wait. Returns
    // the exact SandboxInfo shape callers expect.
    const info = await repointAndStartSandbox(appName, userId, options?.syncToken)
    if (!info || info.status !== 'running') {
      throw new Error(info?.error || 'repoint/start did not reach running')
    }

    // Write the user's instances row pointing at the pooled app (service role —
    // the /api/sandbox route re-upserts the same fields with the authed client
    // afterwards, so this is belt-and-braces).
    const { error: instErr } = await supabase
      .from('instances')
      .upsert({
        user_id: userId,
        server_url: info.previewUrl || `https://${appName}.fly.dev`,
        instance_type: 'cloud',
        status: 'running',
        sandbox_id: appName,
        sandbox_url: info.previewUrl,
        sandbox_status: 'running',
        livekit_room: `osborn-${userId.substring(0, 8)}`,
        last_seen: new Date().toISOString(),
      }, { onConflict: 'user_id' })
    if (instErr) {
      // Machine is running and usable — log, don't fail the handoff. The route's
      // own upsert will write the row momentarily.
      console.warn(`[machine-pool] instances upsert failed for ${userId}: ${instErr.message}`)
    }

    console.log(`[machine-pool] claimed warm machine ${appName} → user ${userId}`)
    return info
  } catch (err) {
    console.error(`[machine-pool] claim of ${appName} for ${userId} failed: ${(err as Error).message} — marking dead, caller falls back to createSandbox`)
    // Mark dead so no one else gets handed a possibly-broken machine.
    await supabase
      .from('machine_pool')
      .update({ status: 'dead' })
      .eq('id', claimedRowId)
      .then(() => {}, () => {})
    return null
  }
}
