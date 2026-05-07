/**
 * image-build-check.ts
 *
 * Checks whether a Docker image tagged with the latest published osborn version
 * already exists in the Fly.io registry. If it is missing, downloads flyctl
 * (if needed) and runs `fly deploy --build-only --push` to build and push the
 * image without deploying.
 *
 * Invoked from instrumentation.ts as a fire-and-forget call on server startup.
 *
 * Never throws. All errors are logged to stderr only.
 */

import { existsSync } from 'fs'
import { execSync, spawnSync } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'

// ─── Config ──────────────────────────────────────────────────────────────────

const NPM_REGISTRY = 'https://registry.npmjs.org'
const FLY_REGISTRY = 'https://registry.fly.io'
const FLYCTL_INSTALL_URL = 'https://fly.io/install.sh'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(...args: unknown[]): void {
  console.log('[check-image-build]', ...args)
}

/**
 * Resolve the fly / flyctl binary path, preferring known install locations.
 * Returns the binary path string (may be a bare name for PATH lookup).
 */
function resolveFlyBin(): string {
  const candidates = [
    '/root/.fly/bin/flyctl',
    '/root/.fly/bin/fly',
    join(homedir(), '.fly', 'bin', 'flyctl'),
    join(homedir(), '.fly', 'bin', 'fly'),
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  // Fall back to PATH lookup — spawnSync will throw if it can't find it.
  return 'fly'
}

/**
 * Build a PATH string that includes the ~/.fly/bin directory so a freshly
 * installed flyctl is found by child processes.
 */
function buildEnvWithFlyPath(): NodeJS.ProcessEnv {
  const flyBin = join(homedir(), '.fly', 'bin')
  const currentPath = process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
  return {
    ...process.env,
    PATH: `${flyBin}:${currentPath}`,
  }
}

// ─── Steps ───────────────────────────────────────────────────────────────────

/**
 * Fetch the latest published version of `osborn` from the npm registry.
 * Returns a version string like "0.8.37".
 */
async function fetchLatestOsbornVersion(): Promise<string> {
  const res = await fetch(`${NPM_REGISTRY}/osborn/latest`, {
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) {
    throw new Error(`npm registry returned HTTP ${res.status} for osborn/latest`)
  }
  const data = await res.json() as { version?: string }
  if (!data.version) throw new Error('npm registry response is missing the version field')
  return data.version
}

/**
 * Query the Fly.io Docker registry for all tags on the given app repository.
 * Returns true if `version` is present in the tag list.
 */
async function imageTagExists(version: string, flyApiToken: string, flySandboxApp: string): Promise<boolean> {
  // Basic auth: username is literal "x", password is the API token.
  const credentials = Buffer.from(`x:${flyApiToken}`).toString('base64')

  const res = await fetch(`${FLY_REGISTRY}/v2/${flySandboxApp}/tags/list`, {
    headers: {
      Authorization: `Basic ${credentials}`,
    },
    signal: AbortSignal.timeout(15000),
  })

  if (!res.ok) {
    throw new Error(`Fly registry returned HTTP ${res.status} when listing tags for ${flySandboxApp}`)
  }

  const data = await res.json() as { tags?: unknown[] }
  const tags = Array.isArray(data.tags) ? data.tags as string[] : []
  log(`Registry tags for ${flySandboxApp}: [${tags.join(', ')}]`)
  return tags.includes(version)
}

/**
 * Download and install flyctl via the official install script if it is not
 * already available. After installation, the binary lives at ~/.fly/bin/flyctl.
 */
function ensureFlyctl(): void {
  // Already installed?
  const existing = resolveFlyBin()
  if (existing !== 'fly' && existsSync(existing)) {
    log(`flyctl already present at ${existing}`)
    return
  }

  // Try a plain PATH lookup before triggering the download.
  try {
    const result = spawnSync('fly', ['version'], { encoding: 'utf8', timeout: 5000 })
    if (result.status === 0) {
      log('flyctl found in PATH — skipping install')
      return
    }
  } catch {
    // Not in PATH; proceed to download.
  }

  log('flyctl not found — downloading via install script...')
  execSync(`curl -L ${FLYCTL_INSTALL_URL} | sh`, {
    stdio: 'pipe',
    env: buildEnvWithFlyPath(),
    timeout: 120000,
  })
  log('flyctl installed successfully')
}

/**
 * Run `fly deploy --build-only --push --image-label {version}` from the repo
 * root (two levels up from `src/lib/`). Streams stderr output to our own
 * stderr so progress is visible in logs.
 */
function buildAndPushImage(version: string, flySandboxApp: string): void {
  const flyBin = resolveFlyBin()
  // In Railway production, process.cwd() is always the frontend/ directory.
  // fly-sandbox.toml lives here, and the Dockerfile is at ../agent/Dockerfile.sandbox.
  const repoRoot = process.cwd()

  const args = [
    'deploy',
    '--build-only',
    '--push',
    '--image-label', version,
    '--app', flySandboxApp,
    '--config', 'fly-sandbox.toml',
  ]

  log(`Running: ${flyBin} ${args.join(' ')}`)
  log(`Working directory (frontend/): ${repoRoot}`)

  const result = spawnSync(flyBin, args, {
    cwd: repoRoot,
    stdio: 'pipe',
    encoding: 'utf8',
    env: buildEnvWithFlyPath(),
    timeout: 600000, // 10 minutes
  })

  if (result.stdout) console.log(result.stdout)
  if (result.stderr) console.log(result.stderr)

  if (result.status !== 0) {
    throw new Error(`fly deploy exited with status ${result.status}`)
  }

  log(`Image build and push complete for version ${version}`)
}

// ─── Exported entry point ─────────────────────────────────────────────────────

export async function checkImageBuild(): Promise<void> {
  try {
    const FLY_API_TOKEN = process.env.FLY_API_TOKEN
    const FLY_SANDBOX_APP = process.env.FLY_SANDBOX_APP || 'osborn-sandbox'

    // Ensure FLY_ORG_SLUG has a default so flyctl picks it up automatically.
    if (!process.env.FLY_ORG_SLUG) process.env.FLY_ORG_SLUG = 'personal'

    console.log('[image-build-check] starting version check')

    // Guard: require FLY_API_TOKEN — nothing to do without it.
    if (!FLY_API_TOKEN) {
      log('FLY_API_TOKEN is not set — skipping image build check')
      return
    }

    log(`Starting image build check (app=${FLY_SANDBOX_APP})`)

    // Step 1: Resolve latest published osborn version.
    const version = await fetchLatestOsbornVersion()
    log(`Latest osborn version on npm: ${version}`)
    console.log(`[image-build-check] npm latest version: ${version}`)

    // Step 2: Check if the image tag already exists in the Fly registry.
    const exists = await imageTagExists(version, FLY_API_TOKEN, FLY_SANDBOX_APP)

    if (exists) {
      log(`Image tag ${version} already exists in registry — nothing to do`)
      console.log(`[image-build-check] image tag ${version} exists in Fly registry — skipping build`)
      return
    }

    log(`Image tag ${version} not found — starting build`)
    console.log(`[image-build-check] image tag ${version} not found in Fly registry — starting build`)

    // Step 3: Ensure flyctl is available, installing it if necessary.
    ensureFlyctl()

    // Step 4: Build and push the image.
    buildAndPushImage(version, FLY_SANDBOX_APP)
  } catch (err) {
    // Never throw — log to stderr only.
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[check-image-build] ERROR: ${message}`)
  }
}
