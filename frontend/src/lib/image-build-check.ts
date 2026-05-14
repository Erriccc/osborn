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
import { execSync, spawn, spawnSync } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'

/**
 * Async wrapper around child_process.spawn — returns { status, stdout, stderr }.
 * Use this instead of spawnSync for any subprocess that could take >100ms,
 * because spawnSync BLOCKS THE NODE EVENT LOOP for its entire duration.
 *
 * Background: this file is invoked from Next.js instrumentation register(),
 * which runs during server startup. If we spawnSync a 5-10 minute `fly deploy`,
 * Next.js cannot answer any HTTP request including Railway's healthcheck, the
 * deploy fails the healthcheck window (5 min), and Railway rolls back the deploy.
 * One real incident: deploy 62d079f2 (May 14 5:48 PM CDT) — caught + fixed by
 * switching to this async wrapper.
 */
function spawnAsync(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let killedByTimeout = false
    const timer = opts.timeoutMs
      ? setTimeout(() => { killedByTimeout = true; child.kill('SIGTERM') }, opts.timeoutMs)
      : null
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer)
      resolve({
        status: code,
        signal: killedByTimeout ? 'SIGTERM' : signal,
        stdout,
        stderr,
      })
    })
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      resolve({ status: null, signal: null, stdout, stderr: stderr + '\n' + (err as Error).message })
    })
  })
}

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
 * Resolve the absolute path to the frontend/ directory.
 *
 * On Railway, `process.cwd()` is `/app` (the repo root), NOT `/app/frontend/`
 * — even though railway.toml/Procfile do `cd frontend && npm run start`. The
 * Node process starts at /app for reasons that aren't worth chasing. We just
 * need to find the dir containing `fly-sandbox.toml` and use absolute paths.
 *
 * Strategy: walk up from process.cwd() looking for fly-sandbox.toml. Covers
 * cwd=/app (find at /app/frontend/) AND cwd=/app/frontend (find here). If
 * neither match, log a clear error and bail.
 */
function findFlyConfigDir(): string | null {
  const candidates = [
    process.cwd(),
    join(process.cwd(), 'frontend'),
    join(homedir(), '..', 'app', 'frontend'),  // /app/frontend safety net
  ]
  for (const c of candidates) {
    if (existsSync(join(c, 'fly-sandbox.toml'))) return c
  }
  return null
}

/**
 * Run `fly auth docker` to register the Fly registry credentials with the
 * local Docker daemon. The `fly deploy --build-only --push` flow requires
 * this — without it, the registry push step errors with auth failures.
 *
 * Idempotent — safe to call before every deploy.
 */
async function flyAuthDocker(flyBin: string): Promise<void> {
  log('Running: fly auth docker')
  const result = await spawnAsync(flyBin, ['auth', 'docker'], {
    env: buildEnvWithFlyPath(),
    timeoutMs: 30000,
  })
  if (result.stdout) console.log('[fly auth docker stdout]', result.stdout.trim())
  if (result.stderr) console.log('[fly auth docker stderr]', result.stderr.trim())
  if (result.status !== 0) {
    // Non-fatal — some builders (e.g. remote builder) don't need it.
    log(`fly auth docker exited ${result.status} (continuing — may not be needed for remote builder)`)
  }
}

/**
 * Run `fly deploy --build-only --push --image-label {version}` with absolute
 * paths so cwd doesn't matter. Streams stdout/stderr to our own logger.
 */
async function buildAndPushImage(version: string, flySandboxApp: string): Promise<void> {
  const flyBin = resolveFlyBin()
  const configDir = findFlyConfigDir()
  if (!configDir) {
    throw new Error(
      `Could not locate fly-sandbox.toml. process.cwd()=${process.cwd()}. ` +
      `Searched: ${[process.cwd(), join(process.cwd(), 'frontend')].join(', ')}. ` +
      `Ensure fly-sandbox.toml + Dockerfile.sandbox are present in the deployed frontend/ dir.`,
    )
  }
  const configPath = join(configDir, 'fly-sandbox.toml')
  const dockerfilePath = join(configDir, 'Dockerfile.sandbox')

  log(`Working directory (resolved): ${configDir}`)
  log(`Config: ${configPath} ${existsSync(configPath) ? '(exists)' : '(MISSING!)'}`)
  log(`Dockerfile: ${dockerfilePath} ${existsSync(dockerfilePath) ? '(exists)' : '(MISSING — prebuild step did not run)'}`)

  // Step 1: register Fly registry creds with Docker (required for --push).
  await flyAuthDocker(flyBin)

  // Step 2: deploy with --build-only --push.
  // Use absolute paths so cwd ambiguity doesn't break --config resolution.
  // Pass --build-arg OSBORN_VERSION=<version> to invalidate the Docker layer
  // cache when osborn npm version changes. Without this, the RUN instruction
  // for `npm install -g osborn@${OSBORN_VERSION}` would cache-hit from previous
  // builds, producing images that claim a new version label but contain stale
  // osborn code inside.
  const args = [
    'deploy',
    '--build-only',
    '--push',
    '--image-label', version,
    '--build-arg', `OSBORN_VERSION=${version}`,
    '--app', flySandboxApp,
    '--config', configPath,
  ]

  log(`Running: ${flyBin} ${args.join(' ')}`)

  // Critical: use spawnAsync (event-loop-safe), NOT spawnSync.
  // A 5-10 min spawnSync here blocks the Next.js server from answering
  // Railway's healthcheck, causing the deploy to roll back before the
  // build finishes. See spawnAsync docstring for the full incident note.
  const result = await spawnAsync(flyBin, args, {
    cwd: configDir,
    env: buildEnvWithFlyPath(),
    timeoutMs: 900000, // 15 minutes — image build + push can take 10+ min
  })

  // Always log both streams — historically only the last line of stderr was
  // visible, hiding the real error (e.g. "Could not find App", "config not found").
  if (result.stdout) console.log('[fly deploy stdout]\n' + result.stdout)
  if (result.stderr) console.log('[fly deploy stderr]\n' + result.stderr)
  log(`fly deploy: status=${result.status} signal=${result.signal ?? 'none'}`)

  if (result.status !== 0) {
    throw new Error(
      `fly deploy exited with status ${result.status}` +
      (result.signal ? ` (killed by ${result.signal})` : '') +
      `. See stderr above for details.`,
    )
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
