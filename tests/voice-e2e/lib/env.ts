import { readFileSync, existsSync } from 'fs'

/**
 * Key resolution, portable: process env first (containers/CI pass keys that
 * way), then an env-file (OSBORN_ENV_FILE, or the local agent/.env on the
 * dev machine).
 */
const ENV_FILE_CANDIDATES = [
  process.env.OSBORN_ENV_FILE,
  '/Users/newupgrade/Desktop/Developer/osborn/agent/.env',
  '/secrets/.env',
].filter(Boolean) as string[]

export function envKey(name: string): string {
  const v = optionalEnvKey(name)
  if (!v) throw new Error(`${name} not found in process.env or ${ENV_FILE_CANDIDATES.join(', ')}`)
  return v
}

export function optionalEnvKey(name: string): string | null {
  if (process.env[name]) return process.env[name]!
  for (const f of ENV_FILE_CANDIDATES) {
    if (!existsSync(f)) continue
    const m = readFileSync(f, 'utf8').match(new RegExp(`^${name}=(\\S+)`, 'm'))
    if (m) return m[1]
  }
  return null
}
