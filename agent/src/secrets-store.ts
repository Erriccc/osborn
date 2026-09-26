/**
 * secrets-store.ts — volume-persisted store for user-manageable API keys.
 *
 * Osborn's platform keys (LiveKit, Deepgram, Smithery, Fly infra) are injected
 * as machine env by the frontend and only change on reboot — fine, they rarely
 * rotate. But a *user* adding their own Anthropic / OpenRouter / Recall key
 * mid-conversation must take effect WITHOUT a reboot (the OS can't hot-inject
 * env into a running process). So those keys live here instead of in machine
 * env: a JSON file on the Fly volume (`~/.osborn/secrets.json` →
 * `/workspace/.osborn/secrets.json`, survives restart AND recreate) that we
 * ALSO mirror into process.env so osborn's own code (which reads process.env)
 * picks them up on the next read.
 *
 * Security:
 *   • Writes are allowlist-filtered by USER_SECRET_KEYS — a user can never set
 *     a platform/infra key (FLY_*, LIVEKIT_*, tokens…) through this path.
 *   • File is written mode 0600.
 *   • Secret VALUES are never returned by listSecretStatus() — status only.
 *
 * Keep the allowlist in sync with env-keys.ts (USER_SECRET_KEYS) and the
 * frontend platform-env.ts scope:'user' entries.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { USER_SECRET_KEYS, isUserSecretKey } from './env-keys.js'

const SECRETS_DIR = join(homedir(), '.osborn')
const SECRETS_FILE = join(SECRETS_DIR, 'secrets.json')

/** Keys whose values must be masked in any status readout (all except RECALL_REGION). */
const NON_SECRET_KEYS = new Set(['RECALL_REGION'])

export interface SecretStatus {
  key: string
  /** true if a non-empty value is currently set (in the store or process.env). */
  set: boolean
  /** true if this key holds a credential (masked); false = plain config (e.g. region). */
  secret: boolean
  /** masked preview — never the raw value; empty string when unset. */
  masked: string
  /** where the current value came from, for the UI. */
  source: 'store' | 'env' | 'none'
}

export interface SetSecretsResult {
  set: string[]
  deleted: string[]
  rejected: string[]
}

/** Read the on-disk store. Returns {} if missing/unreadable. */
function readStore(): Record<string, string> {
  if (!existsSync(SECRETS_FILE)) return {}
  try {
    const parsed = JSON.parse(readFileSync(SECRETS_FILE, 'utf-8'))
    if (parsed && typeof parsed === 'object') return parsed as Record<string, string>
    return {}
  } catch (err) {
    console.error(`❌ Failed to read secrets store: ${(err as Error).message}`)
    return {}
  }
}

/** Write the store atomically-ish with 0600 perms. */
function writeStore(store: Record<string, string>): void {
  if (!existsSync(SECRETS_DIR)) {
    mkdirSync(SECRETS_DIR, { recursive: true })
  }
  writeFileSync(SECRETS_FILE, JSON.stringify(store, null, 2), { encoding: 'utf-8', mode: 0o600 })
  try {
    chmodSync(SECRETS_FILE, 0o600)
  } catch {
    // best-effort; some filesystems ignore chmod
  }
}

/** Return the current store (allowlist-filtered), without touching env. */
export function loadSecrets(): Record<string, string> {
  const store = readStore()
  const clean: Record<string, string> = {}
  for (const [k, v] of Object.entries(store)) {
    if (isUserSecretKey(k) && typeof v === 'string' && v.length > 0) clean[k] = v
  }
  return clean
}

/**
 * Copy stored user secrets into process.env so osborn's own code sees them.
 * Call ONCE at bootstrap, BEFORE applyAuthFallback() and before recall-client
 * is imported (both read these keys at module/boot time). Store values win over
 * pre-existing machine env only when non-empty. Returns the keys hydrated.
 */
export function hydrateSecretsIntoEnv(): string[] {
  const store = loadSecrets()
  const applied: string[] = []
  for (const [k, v] of Object.entries(store)) {
    process.env[k] = v
    applied.push(k)
  }
  if (applied.length > 0) {
    console.log(`🔑 Hydrated ${applied.length} user secret(s) from volume: ${applied.join(', ')}`)
  }
  return applied
}

/**
 * Set (or delete) user secrets. An empty-string value deletes the key.
 * Writes the volume file AND mirrors into process.env for live effect.
 * Keys not in USER_SECRET_KEYS are rejected (never written).
 */
export function setSecrets(entries: Record<string, unknown>): SetSecretsResult {
  const store = readStore()
  const result: SetSecretsResult = { set: [], deleted: [], rejected: [] }

  for (const [rawKey, rawVal] of Object.entries(entries)) {
    const key = rawKey.trim()
    if (!isUserSecretKey(key)) {
      result.rejected.push(key)
      continue
    }
    const val = typeof rawVal === 'string' ? rawVal.trim() : ''
    if (val.length === 0) {
      // delete
      delete store[key]
      delete process.env[key]
      result.deleted.push(key)
    } else {
      store[key] = val
      process.env[key] = val
      result.set.push(key)
    }
  }

  // Only persist allowlisted keys (drop any stale non-allowlisted entries too).
  const persisted: Record<string, string> = {}
  for (const [k, v] of Object.entries(store)) {
    if (isUserSecretKey(k) && typeof v === 'string' && v.length > 0) persisted[k] = v
  }
  writeStore(persisted)

  return result
}

/** Delete a single user secret. */
export function deleteSecret(key: string): boolean {
  if (!isUserSecretKey(key)) return false
  const store = readStore()
  const existed = key in store
  delete store[key]
  delete process.env[key]
  const persisted: Record<string, string> = {}
  for (const [k, v] of Object.entries(store)) {
    if (isUserSecretKey(k) && typeof v === 'string' && v.length > 0) persisted[k] = v
  }
  writeStore(persisted)
  return existed
}

function mask(value: string): string {
  if (!value) return ''
  if (value.length <= 8) return '••••'
  return `${value.slice(0, 4)}••••${value.slice(-4)}`
}

/**
 * Report which user keys are set — WITHOUT returning raw values. Considers both
 * the store and the live process.env (so a key injected as machine env still
 * shows as "set", sourced 'env'). Values are masked.
 */
export function listSecretStatus(): SecretStatus[] {
  const store = readStore()
  return USER_SECRET_KEYS.map((key) => {
    const inStore = typeof store[key] === 'string' && store[key].length > 0
    const envVal = process.env[key]
    const inEnv = typeof envVal === 'string' && envVal.length > 0
    const value = inStore ? store[key] : inEnv ? (envVal as string) : ''
    const isSecret = !NON_SECRET_KEYS.has(key)
    return {
      key,
      set: inStore || inEnv,
      secret: isSecret,
      // Non-secret config (region) can be shown in full; credentials are masked.
      masked: value ? (isSecret ? mask(value) : value) : '',
      source: inStore ? 'store' : inEnv ? 'env' : 'none',
    }
  })
}
