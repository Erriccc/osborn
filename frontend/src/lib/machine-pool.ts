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
  deleteSandbox,
  repointAndStartSandbox,
  type SandboxInfo,
} from './machines'

// ─────────────────────────────────────────
// Config
// ─────────────────────────────────────────

const POOL_MIN_SPARES = 2
const WARM_POOL_MAX_DEFAULT = 2

/**
 * Hard cap on spare machines (env WARM_POOL_MAX, default 2; 0 disables the
 * pool). ensurePool never targets more than this, whatever `min` a caller
 * passes, so a retry loop or a bad caller can't create unbounded machines.
 * Invalid values fall back to the default. The cap is enforced per process
 * and per replica (see the ensurePool guard below), not globally.
 */
export function warmPoolMax(): number {
  const raw = process.env.WARM_POOL_MAX
  if (raw === undefined || raw.trim() === '') return WARM_POOL_MAX_DEFAULT
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) {
    console.warn(`[machine-pool] invalid WARM_POOL_MAX=${JSON.stringify(raw)} — using ${WARM_POOL_MAX_DEFAULT}`)
    return WARM_POOL_MAX_DEFAULT
  }
  return n
}

/**
 * Best-effort destroy of a pool machine that failed partway (created on Fly but
 * not registered, or claimed but broken). Pool apps have unique
 * `osborn-pool-*` names owned by nobody else, so deleting the whole app is
 * safe. Never throws — the caller's original error has already been logged
 * and must stay the reported failure.
 */
// Exactly the shape poolAppName() produces. destroyPoolMachine deletes the
// whole Fly app, so it refuses anything else (e.g. a user's osborn-<id> app).
const POOL_APP_NAME_RE = /^osborn-pool-[0-9a-f]{12}$/

export async function destroyPoolMachine(appName: string, reason: string): Promise<void> {
  if (!POOL_APP_NAME_RE.test(appName)) {
    console.error(`[machine-pool] refusing to destroy ${JSON.stringify(appName)}: not a pool app name (${reason})`)
    return
  }
  try {
    const ok = await deleteSandbox(appName)
    if (ok) console.warn(`[machine-pool] destroyed ${appName} after failure (${reason})`)
    else console.error(`[machine-pool] COST LEAK RISK: could not destroy ${appName} after failure (${reason}) — clean up manually`)
  } catch (err) {
    console.error(`[machine-pool] COST LEAK RISK: destroying ${appName} threw: ${(err as Error).message} (after: ${reason}) — clean up manually`)
  }
}

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

// NOTE: this guard and the WARM_POOL_MAX cap are per-process. Each Next.js
// server process (and each deployed replica) runs its own ensurePool, so N
// replicas racing on the same machine_pool table can briefly exceed the cap.
let poolEnsuring = false

/**
 * Bring the pool to `min` spare machines. Safe to call concurrently: a module-
 * level flag ensures only one replenish loop runs at a time (callers that
 * arrive while one is in flight return immediately rather than queueing a
 * second pass — the next claim/boot trigger will re-check).
 */
export async function ensurePool(min: number = POOL_MIN_SPARES): Promise<void> {
  if (poolEnsuring) return
  const target = Math.min(min, warmPoolMax())
  if (target <= 0) return
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
    const missing = Math.max(0, target - (count ?? 0))
    if (missing === 0) return
    console.log(`[machine-pool] ${count}/${target} spares (cap ${warmPoolMax()}) — provisioning ${missing}`)

    for (let i = 0; i < missing; i++) {
      // Stop the pass on the first failure: a failing provider must not be
      // hammered; the next claim/boot trigger re-checks.
      if (!(await provisionSpare(supabase))) break
    }
  } finally {
    poolEnsuring = false
  }
}

/**
 * Provision one spare machine: create the Fly app+volume+machine (FULL
 * platform env, placeholder owner), register it as 'spare', then stop it cold.
 * On any failure before registration the Fly app is best-effort destroyed —
 * an unregistered machine is never handed out and nothing else would ever
 * stop it. Returns true when the spare was registered.
 */
async function provisionSpare(supabase: SupabaseClient): Promise<boolean> {
  const appName = poolAppName()
  let registered = false
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

    registered = true

    // A registered spare that never stops stays running (and billing) while
    // it waits to be claimed. Retry the stop once; if it still fails, destroy
    // the machine and mark its row dead so it is never handed out.
    if (!(await tryStopCold(appName)) && !(await tryStopCold(appName))) {
      console.error(`[machine-pool] spare ${appName} would not stop after retry — destroying + marking dead`)
      await destroyPoolMachine(appName, 'cold stop failed twice')
      await supabase
        .from('machine_pool')
        .update({ status: 'dead' })
        .eq('app_name', appName)
        .then(() => {}, () => {})
      return false
    }
    console.log(`[machine-pool] spare ready: ${appName}`)
    return true
  } catch (err) {
    const msg = (err as Error).message
    console.error(`[machine-pool] provisioning ${appName} failed: ${msg}`)
    // Registered = recorded in machine_pool, so it is accounted for; only an
    // unregistered machine is an orphan.
    if (!registered) await destroyPoolMachine(appName, `provision failed: ${msg}`)
    return registered
  }
}

/** stopMachineCold, with a throw treated as a failed stop. */
async function tryStopCold(appName: string): Promise<boolean> {
  try {
    return await stopMachineCold(appName)
  } catch (err) {
    console.error(`[machine-pool] stopping ${appName} threw: ${(err as Error).message}`)
    return false
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
    const msg = (err as Error).message
    console.error(`[machine-pool] claim of ${appName} for ${userId} failed: ${msg} — destroying + marking dead, caller falls back to createSandbox`)
    // The repoint may have left the machine running; a dead row is never
    // reused or stopped by anyone, so destroy it now rather than leak it.
    await destroyPoolMachine(appName, `claim failed: ${msg}`)
    // Mark dead so no one else gets handed a possibly-broken machine.
    await supabase
      .from('machine_pool')
      .update({ status: 'dead' })
      .eq('id', claimedRowId)
      .then(() => {}, () => {})
    return null
  }
}
