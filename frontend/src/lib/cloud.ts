/**
 * cloud.ts — Provider switch between Sprites and Fly Machines.
 *
 * Re-exports the 16 shared functions from either lib/sprites or lib/machines
 * based on the `CLOUD_PROVIDER` env var:
 *
 *   CLOUD_PROVIDER=sprites   (default, current production)
 *   CLOUD_PROVIDER=machines  (Fly.io Machines — once existing users migrated)
 *
 * Why a thin wrapper instead of changing /api/sandbox/route.ts imports
 * directly: route.ts has 16 named imports across ~20 call sites. Swapping the
 * import path on every version flip + back-and-forth during rollout adds churn
 * and merge conflict risk. With this wrapper, route.ts has ONE import line and
 * the swap is a config flag set in Railway env vars — flip without code change,
 * easy rollback.
 *
 * Both modules implement the same SandboxInfo shape and method signatures (see
 * tests/parity/code-level-parity.ts — all 16 verified 1:1). Functions only
 * exported by sprites.ts (buildOsbornBootstrap, createCheckpoint, pool helpers,
 * etc.) are correctly absent from this wrapper because /api/sandbox/route.ts
 * doesn't need them — they're sprites-internal implementation details.
 *
 * Note on `SandboxInfo` type: the two libs export the same shape with slightly
 * different `status` enum variants. We re-export from sprites for legacy
 * reasons (existing route.ts code paths match), and machines' values
 * ('running'/'stopped'/'sleeping'/'archived'/'error') are a subset of sprites'
 * superset — so downstream code that compares status strings works against
 * both.
 */

import * as sprites from './sprites'
import * as machines from './machines'

const provider = process.env.CLOUD_PROVIDER === 'machines' ? machines : sprites

if (typeof process !== 'undefined' && process.env.CLOUD_PROVIDER) {
  // Log the active provider once per server start so the choice is visible
  // in Railway logs without grepping for the env var.
  console.log(`[cloud] CLOUD_PROVIDER=${process.env.CLOUD_PROVIDER} → using lib/${process.env.CLOUD_PROVIDER === 'machines' ? 'machines' : 'sprites'}`)
}

// ─── Re-exports — only the 16 functions /api/sandbox/route.ts actually calls ──
export const assignFromPoolOrCreate = provider.assignFromPoolOrCreate
export const checkOsbornHealth = provider.checkOsbornHealth
export const checkSessionLayerConsistency = provider.checkSessionLayerConsistency
export const createSandbox = provider.createSandbox
export const deleteSandbox = provider.deleteSandbox
export const execInSprite = provider.execInSprite
export const findUserSandbox = provider.findUserSandbox
export const isSpritesConfigured = provider.isSpritesConfigured
export const keepAliveSandbox = provider.keepAliveSandbox
export const readInstalledOsbornVersion = provider.readInstalledOsbornVersion
export const resolveOsbornLatest = provider.resolveOsbornLatest
export const restartService = provider.restartService
export const startSandbox = provider.startSandbox
export const stopSandbox = provider.stopSandbox
export const updateOsborn = provider.updateOsborn
export const waitForHealth = provider.waitForHealth

// Type export (both libs have compatible SandboxInfo shapes)
export type { SandboxInfo } from './sprites'

/**
 * Returns the active cloud provider name. Used by debug/health endpoints
 * so we can confirm the runtime choice without poking at env vars from outside.
 */
export function getCloudProvider(): 'sprites' | 'machines' {
  return process.env.CLOUD_PROVIDER === 'machines' ? 'machines' : 'sprites'
}
