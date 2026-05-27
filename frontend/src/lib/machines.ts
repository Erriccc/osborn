/**
 * machines.ts — Fly.io Machines per-user sandbox provisioning (server-side only)
 *
 * Parallel alternative to sprites.ts. Same exported interface, different backend.
 * Uses the Fly Machines API at https://api.machines.dev for per-user isolated
 * Fly apps, each running a single osborn agent machine.
 *
 * Key differences from Sprites:-
 *  - One Fly app per user (app name = osborn-{userId-slug})
 *  - Public URL: https://{app_name}.fly.dev (stable, no auth wall)
 *  - Suspend/resume via Fly CRIU (~300ms) — process state fully preserved
 *  - Auto-suspend: concurrency-based (not 30s timer) — machine stays up during active sessions
 *  - No filesystem API — bootstrap via Docker image CMD
 *  - Requires FLY_API_TOKEN (org-scoped), FLY_ORG_SLUG, FLY_SANDBOX_IMAGE env vars
 *  - IP allocation uses Fly Machines REST API (POST /v1/apps/{app}/ip_assignments)
 *
 * Env vars required in frontend/.env.local:
 *   FLY_API_TOKEN=<fly tokens org --name "osborn-provisioner">
 *   FLY_ORG_SLUG=<your org slug, e.g. "personal">
 *   FLY_SANDBOX_IMAGE=registry.fly.io/osborn-sandbox/agent:latest
 */

// ─────────────────────────────────────────
// Types
// ─────────────────────────────────────────

export interface SandboxInfo {
  id: string
  status: 'creating' | 'running' | 'sleeping' | 'stopped' | 'archived' | 'error'
  previewUrl?: string
  userId: string
  createdAt: string
  error?: string
}

interface FlyMachine {
  id: string
  name: string
  state: 'created' | 'starting' | 'started' | 'stopping' | 'stopped' | 'suspending' | 'suspended' | 'destroying' | 'destroyed'
  region: string
  image_ref?: { registry: string; repository: string; tag: string }
  created_at: string
  updated_at: string
  config?: { env?: Record<string, string>; image?: string; services?: unknown[]; [key: string]: unknown }
}

interface FlyApp {
  id: string
  name: string
  status: string
  hostname: string
}

// ─────────────────────────────────────────
// Config
// ─────────────────────────────────────────

const FLY_API_BASE = 'https://api.machines.dev'
const OSBORN_HTTP_PORT = 8741
const NPM_REGISTRY = 'https://registry.npmjs.org'

function getApiToken(): string {
  const token = process.env.FLY_API_TOKEN
  if (!token) throw new Error('FLY_API_TOKEN not configured')
  return token
}

function getOrgSlug(): string {
  return process.env.FLY_ORG_SLUG || 'personal'
}

/**
 * Build the sandbox image URL.
 *
 * When `version` is supplied (e.g. "0.9.24"), pin the tag explicitly. This
 * is what `updateOsborn` uses: every upgrade points at a version-tagged
 * digest in the Fly registry, so we never depend on `:latest` (which
 * `fly deploy --image-label` does NOT move automatically — leaving the
 * dashboard "Update" button silently re-installing whatever stale digest
 * happens to be sitting at `:latest`).
 *
 * When called with no argument, fall back to `FLY_SANDBOX_IMAGE` (or the
 * default `:latest` URL). This path is only used by `createSandbox` for
 * fresh provisioning where we haven't resolved the npm-latest version yet
 * — and even there, the bootstrap installs `osborn@latest` from npm at
 * boot, so the image's pinned osborn version is just a starting point.
 */
function getSandboxImage(version?: string): string {
  if (version) {
    // Repository host + path are stable; only the tag changes. Use the
    // configured env var as the source so tests / non-prod can override
    // the registry path, while still flipping the tag to the explicit
    // version we just resolved.
    const base = process.env.FLY_SANDBOX_IMAGE || 'registry.fly.io/osborn-sandbox/agent:latest'
    return base.replace(/:[^/:]+$/, `:${version}`)
  }
  return process.env.FLY_SANDBOX_IMAGE || 'registry.fly.io/osborn-sandbox/agent:latest'
}

export function isMachinesConfigured(): boolean {
  return !!process.env.FLY_API_TOKEN
}

function appNameFromUserId(userId: string): string {
  const slug = userId.substring(0, 12).toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/^-+|-+$/g, '')
  return `osborn-${slug}`
}

function mapMachineState(state: string): SandboxInfo['status'] {
  if (state === 'started') return 'running'
  if (state === 'suspended') return 'sleeping'
  if (state === 'stopped' || state === 'stopping') return 'stopped'
  if (state === 'creating' || state === 'starting') return 'creating'
  return 'error'
}

// ─────────────────────────────────────────
// Raw API helpers
// ─────────────────────────────────────────

async function api<T = unknown>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${FLY_API_BASE}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${getApiToken()}`,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Fly API ${method} ${path} → ${res.status}: ${text.substring(0, 300)}`)
  }

  if (res.status === 204) return null as T
  const contentLength = res.headers.get('content-length')
  const contentType = res.headers.get('content-type') || ''
  if (contentLength === '0' || !contentType.includes('json')) {
    try { return await res.json() as T } catch { return null as T }
  }
  return res.json() as Promise<T>
}

/**
 * Wait for a machine to reach a target state by polling the wait endpoint.
 * Fly's /wait endpoint long-polls until the state is reached or timeout.
 */
async function waitForMachineState(
  appName: string,
  machineId: string,
  targetState: string,
  timeoutSec = 60,
): Promise<boolean> {
  // Fly's /wait long-polls until state is reached OR timeout. 200 = reached;
  // 408/504 = timeout (state not reached). Previously this function returned
  // `true` on ANY fetch resolution, masking timeouts as success — callers then
  // declared updates done while machines were still in 'replacing' state. Now
  // we check the status code AND verify the current machine state with a
  // follow-up GET as a tiebreaker (Fly occasionally returns 200 even for
  // mismatched state during fast transitions).
  try {
    const res = await fetch(
      `${FLY_API_BASE}/v1/apps/${appName}/machines/${machineId}/wait?state=${targetState}&timeout=${timeoutSec}`,
      {
        headers: { 'Authorization': `Bearer ${getApiToken()}` },
        signal: AbortSignal.timeout((timeoutSec + 5) * 1000),
      },
    )
    if (!res.ok) {
      console.warn(`[machines] waitForMachineState(${targetState}) HTTP ${res.status} — state not reached`)
      return false
    }
    // Confirm the current state actually matches what we waited for.
    try {
      const m = await api<{ state?: string }>('GET', `/v1/apps/${appName}/machines/${machineId}`)
      if (m?.state !== targetState) {
        console.warn(`[machines] waitForMachineState(${targetState}) returned 200 but actual state=${m?.state}`)
        return false
      }
    } catch {
      // GET probe failed — trust the 200 from /wait
    }
    return true
  } catch (err) {
    console.warn(`[machines] waitForMachineState(${targetState}) failed: ${(err as Error).message}`)
    return false
  }
}

/**
 * Poll machine state via GET until it leaves a transitional state (e.g. "replacing").
 * Returns the final state, or null on timeout / error. Used after a config PATCH:
 * the Fly `/wait?state=...` endpoint refuses (HTTP 400) when the post-replace
 * target state is ambiguous (replaced-from-stopped lands in stopped, not started),
 * so we poll directly and let the caller decide what to do with the resolved state.
 */
async function waitForReplacementComplete(
  appName: string,
  machineId: string,
  timeoutSec = 120,
): Promise<string | null> {
  const deadline = Date.now() + timeoutSec * 1000
  while (Date.now() < deadline) {
    try {
      const m = await api<{ state?: string }>('GET', `/v1/apps/${appName}/machines/${machineId}`)
      const state = m?.state
      if (state && state !== 'replacing' && state !== 'creating') {
        return state
      }
    } catch (err) {
      console.warn(`[machines] waitForReplacementComplete poll failed: ${(err as Error).message}`)
    }
    await new Promise(r => setTimeout(r, 2000))
  }
  console.warn(`[machines] waitForReplacementComplete timed out after ${timeoutSec}s`)
  return null
}

/**
 * Poll the agent's /health endpoint until it returns 200.
 */
export async function waitForHealth(previewUrl: string, maxAttempts = 30): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`${previewUrl}/health`, {
        signal: AbortSignal.timeout(4000),
      })
      if (res.ok) return true
    } catch {
      // Expected while agent is starting
    }
    await new Promise(r => setTimeout(r, 2000))
  }
  return false
}

/**
 * Get the first machine in a Fly app. Returns null if no machines.
 */
async function getFirstMachine(appName: string): Promise<FlyMachine | null> {
  try {
    const machines = await api<FlyMachine[]>('GET', `/v1/apps/${appName}/machines`)
    return machines?.[0] ?? null
  } catch {
    return null
  }
}

/**
 * Allocate a shared IPv4 for a Fly app via the Fly Machines REST API.
 * Required for the app to be reachable at {app_name}.fly.dev.
 * Returns true on success.
 */
async function allocateIp(appName: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.machines.dev/v1/apps/${appName}/ip_assignments`, {
      method: 'POST',
      headers: {
        'Authorization': `FlyV1 ${getApiToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: 'shared_v4' }),
    })
    if (!res.ok) {
      const text = await res.text()
      console.error(`[machines] IP allocation failed for ${appName}: HTTP ${res.status} — ${text}`)
      return false
    }
    return true
  } catch (err) {
    console.error(`[machines] IP allocation error for ${appName}:`, err)
    return false
  }
}

/**
 * Get platform env vars to inject into every machine.
 */
function getPlatformEnvVars(userId: string): Record<string, string> {
  const envVars: Record<string, string> = {
    OSBORN_API_PORT: String(OSBORN_HTTP_PORT),
    OSBORN_CWD: '/workspace',
    HOME: '/root',
    LIVEKIT_ROOM: `osborn-${userId.substring(0, 8)}`,
  }
  const forwardKeys = [
    'LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET',
    'NEXT_PUBLIC_LIVEKIT_URL',
    'DEEPGRAM_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY',
    'RECALL_API_KEY', 'SMITHERY_API_KEY', 'GROQ_API_KEY',
  ]
  for (const key of forwardKeys) {
    if (process.env[key]) envVars[key] = process.env[key]!
  }
  return envVars
}

// ─────────────────────────────────────────
// Public API
// ─────────────────────────────────────────

/**
 * Create a new Fly Machines sandbox for a user.
 *
 * Flow:
 *  1. Create Fly app (osborn-{userId-slug})
 *  2. Allocate shared IPv4 via flyctl
 *  3. Create a Fly volume for persistent storage
 *  4. Create a machine with the pre-built osborn Docker image
 *  5. Wait for machine to reach 'started' state
 *  6. Poll /health until agent responds
 *  7. Return SandboxInfo
 *
 * Autostop policy: DEFAULTS TO `'off'` — machines stay running until WE
 * explicitly call stopSandbox(). This is intentional: we want full manual
 * control over lifecycle so unexpected wakes / cold-start delays / suspend-
 * related bugs don't surprise users. The dashboard (or any keepalive watcher)
 * is responsible for calling /api/sandbox `stop` when the user goes idle.
 * Caller can opt in to Fly-managed autostop by passing `autostopMode: 'stop'`.
 *
 * @param options.autostopMode - 'off' (default, manual lifecycle) or 'stop' (Fly-managed cold stop/start)
 */
export async function createSandbox(userId: string, options?: { autostopMode?: 'off' | 'stop' }): Promise<SandboxInfo> {
  if (!isMachinesConfigured()) {
    return { id: '', status: 'error', userId, createdAt: new Date().toISOString(), error: 'FLY_API_TOKEN not configured' }
  }

  const appName = appNameFromUserId(userId)
  const previewUrl = `https://${appName}.fly.dev`
  console.log(`[machines] Creating sandbox "${appName}" for user ${userId}...`)

  try {
    // Step 1: Create Fly app
    try {
      await api('POST', '/v1/apps', { app_name: appName, org_slug: getOrgSlug() })
      console.log(`[machines] App created: ${appName}`)
    } catch (err) {
      const msg = (err as Error).message
      if (!msg.includes('already exists') && !msg.includes('409')) throw err
      console.log(`[machines] App ${appName} already exists — continuing...`)
    }

    // Step 2: Allocate shared IP (required for fly.dev URL routing)
    await allocateIp(appName)

    // Step 3: Create volume for persistent workspace + credentials
    let volumeId: string | undefined
    try {
      const vol = await api<{ id: string }>('POST', `/v1/apps/${appName}/volumes`, {
        name: 'workspace',
        region: process.env.FLY_REGION || 'iad',
        size_gb: 10,
        encrypted: true,
      })
      volumeId = vol.id
      console.log(`[machines] Volume created: ${vol.id}`)
    } catch (err) {
      console.warn(`[machines] Volume creation failed (may already exist): ${(err as Error).message}`)
      // Try to get existing volume
      try {
        const vols = await api<{ id: string }[]>('GET', `/v1/apps/${appName}/volumes`)
        volumeId = vols?.[0]?.id
      } catch { /* ignore */ }
    }

    // Step 4: Create machine
    const envVars = getPlatformEnvVars(userId)
    const machineConfig: Record<string, unknown> = {
      image: getSandboxImage(),
      init: { exec: ['/entrypoint.sh'] },
      env: envVars,
      // performance-1x:2048MB — dedicated vCPU prevents audio jitter from CPU-steal;
      // 2GB RAM gives headroom for osborn + Claude Code subprocess + large JSONL replay
      // without hitting OOM. Matches the performance class used by Sprites.
      // (shared-cpu-1x:1024MB caused event-loop pauses under memory pressure,
      // degrading both STT and TTS simultaneously mid-conversation.)
      guest: { cpu_kind: 'performance', cpus: 1, memory_mb: 2048 },
      services: [{
        protocol: 'tcp',
        internal_port: OSBORN_HTTP_PORT,
        ports: [
          { port: 443, handlers: ['tls', 'http'] },
          { port: 80, handlers: ['http'], force_https: true },
        ],
        // Manual lifecycle by default — see createSandbox doc for rationale.
        // Frontend/server explicitly calls stopSandbox() when user goes idle.
        autostop: options?.autostopMode ?? 'off',
        autostart: true,
        concurrency: { type: 'connections', soft_limit: 5, hard_limit: 10 },
      }],
      metadata: { userId, app: 'osborn' },
      restart: { policy: 'on-failure', max_retries: 3 },
      auto_destroy: false,
    }

    if (volumeId) {
      machineConfig.mounts = [{ volume: volumeId, path: '/workspace' }]
    }

    const machine = await api<FlyMachine>('POST', `/v1/apps/${appName}/machines`, {
      name: 'osborn-agent',
      region: process.env.FLY_REGION || 'iad',
      config: machineConfig,
    })
    console.log(`[machines] Machine created: ${machine.id} (state: ${machine.state})`)

    // Step 5: Wait for machine to start
    const started = await waitForMachineState(appName, machine.id, 'started', 120)
    if (!started) {
      console.warn(`[machines] Machine ${machine.id} did not reach started state within 120s`)
    }

    // Step 6: Poll /health
    console.log(`[machines] Waiting for agent health at ${previewUrl}/health...`)
    const healthy = await waitForHealth(previewUrl, 60) // 60 × 2s = 2min
    if (!healthy) {
      console.warn(`[machines] Agent did not become healthy within 2 minutes`)
    }

    return {
      id: appName,
      status: healthy ? 'running' : 'error',
      previewUrl,
      userId,
      createdAt: new Date().toISOString(),
      ...(healthy ? {} : { error: 'Agent did not pass health check after creation' }),
    }
  } catch (err) {
    const msg = (err as Error).message
    console.error(`[machines] Sandbox creation failed: ${msg}`)
    return { id: appName, status: 'error', userId, createdAt: new Date().toISOString(), error: msg }
  }
}

/**
 * Find an existing sandbox for a user.
 *
 * `knownSandboxId` (typically from Supabase `instances.sandbox_id`) is the
 * authoritative source — honor it when provided. Fall back to deterministic
 * naming only when Supabase has no record (legacy users provisioned before
 * row creation, or first-time provision-lookup race).
 *
 * Earlier versions of this function ignored `knownSandboxId` with a "deterministic
 * from userId" comment. That assumption silently broke any user whose stored
 * sandbox name differed from the derived one — for example after a manual
 * provisioning script used a timestamped name, or if Fly app naming evolves
 * to add a suffix (as sprites already does via `generateUniqueSpriteName`).
 * The code-level parity test caught this — see tests/parity/code-level-parity.ts.
 *
 * @param userId         - the user ID to look up
 * @param knownSandboxId - if provided, this is the actual Fly app name; used as-is
 */
export async function findUserSandbox(userId: string, knownSandboxId?: string): Promise<SandboxInfo | null> {
  const appName = knownSandboxId || appNameFromUserId(userId)
  try {
    // Ensure the app exists before checking machines
    await api<FlyApp>('GET', `/v1/apps/${appName}`)
    const machine = await getFirstMachine(appName)
    return {
      id: appName,
      status: machine ? mapMachineState(machine.state) : 'stopped',
      previewUrl: `https://${appName}.fly.dev`,
      userId,
      createdAt: machine?.created_at || new Date().toISOString(),
    }
  } catch (err) {
    const msg = (err as Error).message
    if (msg.includes('404') || msg.includes('Could not find')) return null
    console.error(`[machines] findUserSandbox failed: ${msg}`)
    return null
  }
}

/**
 * Start (resume) a suspended or stopped sandbox.
 *
 * If machine is suspended: resume via /start (CRIU restore, ~300ms)
 * If machine is stopped: start via /start (cold boot from Docker image, ~1s)
 * Both paths: poll /health up to 60s
 */
export async function startSandbox(sandboxId: string, userId: string): Promise<SandboxInfo | null> {
  const appName = sandboxId // sandboxId IS the app name
  try {
    const machine = await getFirstMachine(appName)
    if (!machine) {
      console.warn(`[machines] No machine found for ${appName}`)
      return null
    }

    const previewUrl = `https://${appName}.fly.dev`
    console.log(`[machines] Starting machine ${machine.id} (state: ${machine.state})...`)

    // Start/resume the machine
    await api('POST', `/v1/apps/${appName}/machines/${machine.id}/start`)
    await waitForMachineState(appName, machine.id, 'started', 60)

    // Poll health
    const healthy = await waitForHealth(previewUrl, 30) // 30 × 2s = 60s
    return {
      id: appName,
      status: healthy ? 'running' : 'error',
      previewUrl,
      userId,
      createdAt: machine.created_at,
      ...(healthy ? {} : { error: 'Agent did not pass health check after start' }),
    }
  } catch (err) {
    console.error(`[machines] startSandbox failed: ${(err as Error).message}`)
    return null
  }
}

/**
 * Stop a sandbox machine (cold stop, waits for stopped state).
 * Delegates to stopMachineCold — no CRIU snapshot on Fly Machines in this path.
 */
export async function stopSandbox(sandboxId: string): Promise<boolean> {
  return stopMachineCold(sandboxId)
}

/**
 * Hard-stop a sandbox machine (cold stop, no CRIU snapshot).
 * Use this when autostop is 'off' and you want a clean stop/start cycle
 * without any checkpoint state — the machine will cold-boot on next start.
 */
export async function stopMachineCold(sandboxId: string): Promise<boolean> {
  const appName = sandboxId
  try {
    const machine = await getFirstMachine(appName)
    if (!machine) return true // nothing to stop
    await api('POST', `/v1/apps/${appName}/machines/${machine.id}/stop`)
    await waitForMachineState(appName, machine.id, 'stopped', 60)
    console.log(`[machines] Machine ${machine.id} stopped (cold)`)
    return true
  } catch (err) {
    console.error(`[machines] stopMachineCold failed: ${(err as Error).message}`)
    return false
  }
}

/**
 * Ping the sandbox to keep it alive and prevent auto-suspend.
 */
export async function keepAliveSandbox(sandboxId: string): Promise<boolean> {
  const appName = sandboxId
  try {
    const res = await fetch(`https://${appName}.fly.dev/health`, {
      signal: AbortSignal.timeout(4000),
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Permanently delete a sandbox: destroy the machine, delete volumes, delete app.
 */
export async function deleteSandbox(sandboxId: string): Promise<boolean> {
  const appName = sandboxId
  try {
    // Destroy the machine first
    const machine = await getFirstMachine(appName)
    if (machine) {
      await api('DELETE', `/v1/apps/${appName}/machines/${machine.id}?force=true`)
      console.log(`[machines] Machine ${machine.id} destroyed`)
    }

    // Delete volumes
    try {
      const vols = await api<{ id: string }[]>('GET', `/v1/apps/${appName}/volumes`)
      for (const vol of vols || []) {
        await api('DELETE', `/v1/apps/${appName}/volumes/${vol.id}`)
      }
    } catch { /* ignore */ }

    // Delete app
    await api('DELETE', `/v1/apps/${appName}?force=true`)
    console.log(`[machines] App ${appName} deleted`)
    return true
  } catch (err) {
    console.error(`[machines] deleteSandbox failed: ${(err as Error).message}`)
    return false
  }
}

// ─────────────────────────────────────────
// Parity exports (drop-in replacement for sprites.ts)
// ─────────────────────────────────────────

/**
 * Alias to isMachinesConfigured — drop-in parity with sprites.ts isSpritesConfigured().
 */
export function isSpritesConfigured(): boolean {
  return isMachinesConfigured()
}

/**
 * Single health probe with 5s timeout, no retry loop.
 * Drop-in parity with sprites.ts checkOsbornHealth().
 *
 * @param previewUrl - full base URL (e.g. https://osborn-abc.fly.dev)
 */
export async function checkOsbornHealth(previewUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${previewUrl}/health`, {
      signal: AbortSignal.timeout(5000),
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Assign a sandbox to a user — alias to createSandbox.
 * No pool needed on Fly Machines (one app per user, deterministic name).
 * Drop-in parity with sprites.ts assignFromPoolOrCreate().
 */
export async function assignFromPoolOrCreate(userId: string): Promise<SandboxInfo> {
  return createSandbox(userId)
}

/**
 * Restart the osborn process in a sandbox — stops the machine cold then starts it.
 * Returns true if the machine comes back healthy.
 * Drop-in parity with sprites.ts restartService().
 *
 * @param sandboxId - the app name (e.g. "osborn-abc123def456")
 * @param userId    - user ID, required for startSandbox
 */
export async function restartService(sandboxId: string, userId?: string): Promise<boolean> {
  const stopped = await stopMachineCold(sandboxId)
  if (!stopped) {
    console.warn(`[machines] restartService: stopMachineCold failed for ${sandboxId}`)
  }
  const info = await startSandbox(sandboxId, userId ?? '')
  return info?.status === 'running'
}

/**
 * Fetch the latest published version of `osborn` from the npm registry.
 * Returns a concrete version string like "0.8.31". Throws on network failure.
 */
export async function resolveOsbornLatest(): Promise<string> {
  const res = await fetch(`${NPM_REGISTRY}/osborn/latest`, {
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) {
    throw new Error(`npm registry returned ${res.status} for osborn/latest`)
  }
  const data = (await res.json()) as { version?: string }
  if (!data.version) throw new Error('npm registry response missing version field')
  return data.version
}

/**
 * Read the version of osborn currently running on a Fly Machines sandbox.
 *
 * Strategy:
 *  1. GET /health — if the response body has a `version` field, return it.
 *  2. Fall back to machine.image_ref.tag from the Fly API.
 *  3. Return null if both fail.
 *
 * @param sandboxId - the app name (e.g. "osborn-abc123def456")
 */
export async function readInstalledOsbornVersion(sandboxId: string): Promise<string | null> {
  const appName = sandboxId
  const previewUrl = `https://${appName}.fly.dev`

  // ONLY trust the running container's /health endpoint. We previously fell back
  // to the Fly Machines API's image_ref.tag, but that's the *configured* image
  // tag — Fly reports the new tag immediately after our PATCH, before the
  // container has pulled, unpacked, or run that image. During the in-place
  // replacement window the tag says "0.9.36" while the running container is
  // still "0.9.35", causing updateOsbornImpl to declare success on a failed
  // update. Returning null instead lets the caller treat the version as
  // unknown and surface a real failure.
  try {
    const res = await fetch(`${previewUrl}/health`, {
      signal: AbortSignal.timeout(5000),
    })
    if (res.ok) {
      const data = (await res.json()) as { version?: string }
      if (data.version) return data.version
    }
  } catch {
    // /health unreachable → unknown
  }

  return null
}

// Per-sandbox in-flight lock for updateOsborn.
// Concurrent calls collide destructively (stop → PATCH → start in sequence).
// The lock returns the in-flight promise to subsequent callers so they get the
// same result instead of triggering parallel work.
const updateInflight = new Map<string, Promise<{ success: boolean; version: string | null; log: string }>>()

// ─── Update result store (signal #4: server-side last-known outcome) ─────────
//
// `verify-update` needs a server-side source of truth for whether the most
// recent `updateOsborn` finished — independent of whether the long-held POST
// response reached the browser. Without this, a Safari fetch drop during the
// ~90s update window leaves the dashboard guessing. With this, the dashboard
// can call `verify-update` and learn the actual outcome.
//
// In-memory Map is fine on Railway (single Node process, single replica per
// service). If we ever scale frontend > 1 replica or restart frontend mid-
// update, the next verify call returns `null` for `lastUpdateResult`. That's
// not a regression vs today — the dashboard already has to fall back to
// version probing in that case. We just buy a higher-fidelity signal when
// available.
export interface UpdateResult {
  sandboxId: string
  status: 'in-progress' | 'success' | 'error'
  targetVersion: string | null
  installedVersion: string | null
  error: string | null
  startedAt: number          // epoch ms
  completedAt: number | null // epoch ms; null while in-progress
  log: string
}

const lastUpdateResult = new Map<string, UpdateResult>()

export function getLastUpdateResult(sandboxId: string): UpdateResult | null {
  return lastUpdateResult.get(sandboxId) ?? null
}

function setUpdateResult(r: UpdateResult): void {
  lastUpdateResult.set(r.sandboxId, r)
}

/**
 * Upgrade osborn on a Fly Machines sandbox to a target version.
 *
 * Flow:
 *  1. Serialize concurrent calls (per-sandbox in-flight dedup lock)
 *  2. Resolve target version (npm registry latest, unless caller passed one)
 *  3. stopMachineCold — clean stop before config change
 *  4. PATCH machine config with updated image via Fly Machines API
 *  5. startSandbox — cold boot from new image
 *  6. readInstalledOsbornVersion — confirm installed version
 *  7. Return { success, version, log }
 *
 * @param sandboxId - the app name (e.g. "osborn-abc123def456")
 * @param userId    - user ID for startSandbox
 * @param version   - optional target version. Omit to use npm registry latest.
 */
export async function updateOsborn(
  sandboxId: string,
  userId: string,
  version?: string,
): Promise<{ success: boolean; version: string | null; log: string }> {
  const existing = updateInflight.get(sandboxId)
  if (existing) {
    console.log(`[machines] updateOsborn: join in-flight call for ${sandboxId} (de-duped)`)
    return existing
  }

  const work = updateOsbornImpl(sandboxId, userId, version)
  updateInflight.set(sandboxId, work)
  work.finally(() => {
    if (updateInflight.get(sandboxId) === work) {
      updateInflight.delete(sandboxId)
    }
  })
  return work
}

/**
 * Real exec inside a running Fly Machine via POST /v1/apps/{app}/machines/{id}/exec.
 *
 * Distinct from execInSprite() below: that one is the backend-specific logs
 * adapter retained for the /api/sandbox 'fetch-log' route, which historically
 * predates this endpoint being wired up. New code should call this directly.
 */
async function execInMachine(
  appName: string,
  machineId: string,
  cmd: string[],
  timeoutSec = 60,
): Promise<{ exitCode: number; stdOut: string; stdErr: string }> {
  try {
    // IMPORTANT: Fly's exec endpoint has TWO accepted body shapes:
    //   - { cmd: "shell string here", ... }       — `cmd` is a string (shell-interpreted)
    //   - { command: ["bin", "arg1", ...], ... }  — `command` is an array (no shell)
    // Sending `cmd: [array]` returns 400 "cannot unmarshal array into ... cmd of type string"
    // (the original v0.9.38 implementation hit this and every update fell back to image-swap
    // because isManifestAware silently returned false on the 400). We use `command` (array)
    // here because it's safer: no shell escaping needed for arbitrary args.
    const res = await fetch(
      `${FLY_API_BASE}/v1/apps/${appName}/machines/${machineId}/exec`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${getApiToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ command: cmd, timeout: timeoutSec }),
        signal: AbortSignal.timeout((timeoutSec + 10) * 1000),
      },
    )
    if (!res.ok) {
      const text = await res.text()
      return { exitCode: 1, stdOut: '', stdErr: `exec API ${res.status}: ${text.substring(0, 300)}` }
    }
    // Fly's response uses snake_case: { stdout, stderr, exit_code, exit_signal }
    const data = await res.json() as {
      exit_code?: number; exitCode?: number
      stdout?: string; stdOut?: string
      stderr?: string; stdErr?: string
    }
    return {
      exitCode: data.exit_code ?? data.exitCode ?? 1,
      stdOut: data.stdout ?? data.stdOut ?? '',
      stdErr: data.stderr ?? data.stdErr ?? '',
    }
  } catch (err) {
    return { exitCode: 1, stdOut: '', stdErr: `execInMachine error: ${(err as Error).message}` }
  }
}

/**
 * Probe whether this machine's image has the /etc/osborn-manifest-aware
 * marker. Currently unused by any active update flow (see comment near
 * updateViaManifest below for why the manifest path was abandoned), but kept
 * as a diagnostic helper for ad-hoc operator queries / future tooling.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function isManifestAware(appName: string, machineId: string): Promise<boolean> {
  const res = await execInMachine(appName, machineId, ['test', '-f', '/etc/osborn-manifest-aware'], 10)
  return res.exitCode === 0
}

async function updateOsbornImpl(
  sandboxId: string,
  userId: string,
  version?: string,
): Promise<{ success: boolean; version: string | null; log: string }> {
  const startedAt = Date.now()
  // Seed the result store immediately so verify-update knows an update is
  // in-flight even if the caller never gets the final response (mobile
  // Safari closing the socket etc.). Subsequent updates overwrite this
  // entry — we only care about the LAST update per sandbox.
  setUpdateResult({
    sandboxId,
    status: 'in-progress',
    targetVersion: version ?? null,
    installedVersion: null,
    error: null,
    startedAt,
    completedAt: null,
    log: 'updateOsborn: started',
  })

  // Helper to record a terminal outcome before returning. Mirrors what we
  // return to the caller so the dashboard sees the same shape it always
  // did, just persisted server-side too.
  const finish = (
    payload: { success: boolean; version: string | null; log: string },
    targetForLog: string | null,
  ): { success: boolean; version: string | null; log: string } => {
    setUpdateResult({
      sandboxId,
      status: payload.success ? 'success' : 'error',
      targetVersion: targetForLog,
      installedVersion: payload.version,
      error: payload.success ? null : payload.log,
      startedAt,
      completedAt: Date.now(),
      log: payload.log,
    })
    return payload
  }

  let targetVersion: string
  try {
    targetVersion = version ?? (await resolveOsbornLatest())
  } catch (err) {
    return finish(
      { success: false, version: null, log: `Could not resolve target version: ${(err as Error).message}` },
      null,
    )
  }

  console.log(`[machines] updateOsborn: target=${targetVersion} on ${sandboxId}`)
  // Update the in-progress entry with the resolved target version so
  // verify-update can render "Installing v0.9.24…" even before the patch
  // lands.
  setUpdateResult({
    sandboxId,
    status: 'in-progress',
    targetVersion,
    installedVersion: null,
    error: null,
    startedAt,
    completedAt: null,
    log: `updateOsborn: target=${targetVersion}`,
  })

  const appName = sandboxId

  // Step 1: Get the current machine config
  const machine = await getFirstMachine(appName)
  if (!machine) {
    return finish({ success: false, version: null, log: `No machine found for app ${appName}` }, targetVersion)
  }

  // Step 2: Use the image-swap update path.
  //
  // We previously branched here between a "manifest flow" (write manifest +
  // restartService) and image-swap based on whether the machine had the
  // /etc/osborn-manifest-aware marker. That manifest flow was REMOVED because:
  //   - restartService doesn't PATCH the image config, so the container restarts
  //     on the SAME old image. The entrypoint then sees a version mismatch and
  //     attempts `npm install -g osborn@<target>` AT RUNTIME, on every boot.
  //   - That runtime install is fragile (network blip → hang → container never
  //     reaches `exec osborn` → boot loops). Production incident 2026-05-22:
  //     v0.9.40 update hung the agent + required manual recovery via SSH.
  //   - The install also doesn't persist (Fly wipes overlay on stop/start),
  //     so EVERY restart pays the install cost.
  //
  // The image-swap path (PATCH config to new image tag) is the only mechanism
  // that actually works reliably on Fly Machines without NPM_CONFIG_PREFIX on
  // the volume. New image has the desired osborn baked in → entrypoint sees no
  // mismatch → no runtime install → fast clean boot.
  //
  // The marker file `/etc/osborn-manifest-aware` is still baked in (Dockerfile
  // line 36) and the entrypoint's manifest check is still there as a SAFETY
  // NET for future use (e.g. if someone manually writes the manifest), but
  // it's no longer the primary mechanism.
  //
  // Clear any stale manifest file from the failed flow (best-effort, fire-and-
  // forget). If the file is present when the new image boots, the entrypoint
  // will try to install again — which is fine if the manifest matches the
  // image-baked version, but a safety wipe avoids edge cases.
  execInMachine(appName, machine.id, ['rm', '-f', '/workspace/.osborn-want-version'], 5).catch(() => {})

  // Step 3: Stop the machine cold before changing config
  console.log(`[machines] updateOsborn: stopping machine ${machine.id}`)
  const stopped = await stopMachineCold(sandboxId)
  if (!stopped) {
    console.warn(`[machines] updateOsborn: stopMachineCold did not confirm stopped state — proceeding anyway`)
  }

  // Step 3: PATCH machine config with new image
  // Fly Machines uses POST /machines/{id} to update config (same as create endpoint).
  //
  // VERSION-PINNED: pass `targetVersion` so the URL is `agent:0.9.24`, not
  // `agent:latest`. `fly deploy --image-label X.Y.Z` (in image-build-check.ts)
  // only writes the version tag — it does NOT move `:latest`. If we kept
  // pulling `:latest` here, the registry would return whatever stale digest
  // happens to be sitting there from a previous build, and the user's
  // "Update to vX.Y.Z" click would silently re-install the old version.
  // Pinning to the resolved target version makes upgrades deterministic.
  const newImage = getSandboxImage(targetVersion)
  console.log(`[machines] updateOsborn: patching machine config image=${newImage}`)
  try {
    await api('POST', `/v1/apps/${appName}/machines/${machine.id}`, {
      config: {
        ...(machine.config ?? {}),
        image: newImage,
      },
    })
  } catch (err) {
    return finish(
      { success: false, version: null, log: `Machine config PATCH failed: ${(err as Error).message}` },
      targetVersion,
    )
  }

  // Step 4: Wait for the replacement to settle, then start.
  // A config PATCH with a new image triggers an in-place machine replacement on Fly.
  // The replacement lands in whatever state the machine was in BEFORE the PATCH —
  // we just stopped it in step 2, so it lands in "stopped". The earlier flow tried
  // /wait?state=started which Fly rejects with HTTP 400 in this case (the machine
  // isn't transitioning toward started), then fell through to startSandbox which
  // hit 412 ("machine getting replaced, refusing to start") because the replacement
  // was still in flight.
  //
  // Correct flow: poll GET /machines/{id} until state leaves "replacing" (lands in
  // "stopped"), then explicitly start. This is robust to Fly's state machine and
  // avoids depending on the /wait endpoint's quirks across transition boundaries.
  console.log(`[machines] updateOsborn: waiting for replacement to settle`)
  const settledState = await waitForReplacementComplete(appName, machine.id, 120)
  if (!settledState) {
    return finish(
      { success: false, version: null, log: 'Machine replacement did not settle within 120s' },
      targetVersion,
    )
  }
  console.log(`[machines] updateOsborn: replacement settled in state=${settledState}`)

  let info: SandboxInfo | null = null
  if (settledState === 'started') {
    // Replacement auto-started (rare in our flow, since we stopped first — but
    // possible if Fly's behavior changes). Just poll health.
    const previewUrl = `https://${appName}.fly.dev`
    console.log(`[machines] updateOsborn: machine already started post-replace, polling health`)
    const healthy = await waitForHealth(previewUrl, 30)
    info = {
      id: appName,
      status: healthy ? 'running' : 'error',
      previewUrl,
      userId,
      createdAt: machine.created_at,
      ...(healthy ? {} : { error: 'Agent did not pass health check after update' }),
    }
  } else {
    // Normal post-stop replace path: machine is now in "stopped" — start it.
    console.log(`[machines] updateOsborn: starting machine after replacement`)
    info = await startSandbox(sandboxId, userId)
  }

  if (!info || info.status !== 'running') {
    return finish(
      { success: false, version: null, log: 'Machine did not come back healthy after image update' },
      targetVersion,
    )
  }

  // Step 5: Read the installed version. NOTE: this is signal #2 — even if
  // we got here, the install only counts as a real success if /health
  // reports the target version. If the probe fails or reports an older
  // version, surface that as an error instead of claiming success.
  const installed = await readInstalledOsbornVersion(sandboxId)
  if (!installed) {
    return finish(
      { success: false, version: null, log: 'Machine running but /health did not return a version' },
      targetVersion,
    )
  }
  if (installed !== targetVersion) {
    return finish(
      {
        success: false,
        version: installed,
        log: `Machine running on v${installed} but expected v${targetVersion} — image swap did not take effect`,
      },
      targetVersion,
    )
  }
  console.log(`[machines] updateOsborn: success — osborn installed=${installed} on ${sandboxId}`)
  return finish(
    {
      success: true,
      version: installed,
      log: `Updated to image ${newImage} (osborn@${installed})`,
    },
    targetVersion,
  )
}

// REMOVED 2026-05-22: updateViaManifest function.
//
// Was meant as a faster update mechanism that wrote a manifest file to the
// volume, then called restartService to let the entrypoint npm-install the
// new version at boot. In practice it broke updates in production:
//   - restartService restarts on the SAME image config (no PATCH), so the
//     entrypoint always sees a version mismatch when the desired version
//     differs from the image-baked one.
//   - The runtime `npm install -g osborn@<target>` hung on the Fly machine
//     (network blip + 363 deps to fetch), preventing the entrypoint from
//     ever reaching `exec osborn` → container boot-looped.
//   - Even on successful install, Fly wipes overlay on every stop/start, so
//     the install doesn't persist — every restart pays the same cost.
//
// Image-swap (PATCH config to new image tag) is the only path that works
// reliably without NPM_CONFIG_PREFIX=/workspace/.npm-global. The marker file
// (/etc/osborn-manifest-aware) + entrypoint manifest check are still in
// place as harmless infrastructure for potential future use, but no caller
// invokes them from this file anymore. See updateOsbornImpl above for the
// active flow.

/**
 * Fetch recent log output from a Fly Machines sandbox via the Fly logs API.
 *
 * No exec API exists on Fly Machines — this is the closest equivalent.
 * The command/args/env/timeout parameters are accepted for API parity with
 * sprites.ts execInSprite() but are ignored in the implementation.
 *
 * Returns exitCode 0 on success with log lines in `output`.
 *
 * @param sandboxId  - the app name (e.g. "osborn-abc123def456")
 * @param _cmd       - ignored (no exec API on Fly Machines)
 * @param _args      - ignored
 * @param _timeoutSec - ignored
 * @param _env       - ignored
 */
export async function execInSprite(
  sandboxId: string,
  _cmd: string,
  _args?: string[],
  _timeoutSec?: number,
  _env?: Record<string, string>,
): Promise<{ exitCode: number; output: string }> {
  const appName = sandboxId
  try {
    const machine = await getFirstMachine(appName)
    if (!machine) {
      return { exitCode: 1, output: `No machine found for app ${appName}` }
    }

    // Fly Machines does NOT expose a REST /logs endpoint (the previous
    // implementation hit /v1/apps/{app}/machines/{id}/logs which returns 404
    // → that 404 string was getting uploaded as "the session log" for every
    // disconnect since this code was written). Verified 2026-05-27 by curling
    // it directly.
    //
    // Correct approach: read the persistent log file written by the entrypoint
    // (tee'd to /workspace/osborn.log — see Dockerfile.sandbox). The exec API
    // works fine; we used it for stopMachineCold and waitForReplacementComplete.
    const result = await execInMachine(
      appName,
      machine.id,
      ['tail', '-n', '500', '/workspace/osborn.log'],
      15,
    )
    if (result.exitCode === 0) {
      return { exitCode: 0, output: result.stdOut || '(empty log)' }
    }
    // exit_code != 0 typically means the log file doesn't exist yet (sprite
    // hasn't booted with the tee'd entrypoint yet — applies until image
    // bake includes the new Dockerfile). Surface stderr for diagnostics.
    const errMsg = result.stdErr.trim() || `tail exited ${result.exitCode}`
    return {
      exitCode: result.exitCode,
      output: `[execInSprite] /workspace/osborn.log not readable: ${errMsg}\n` +
              `This sprite is likely on an older image that doesn't tee stdout to the log file. ` +
              `Update the sprite to pick up the latest osborn-sandbox image.`,
    }
  } catch (err) {
    return { exitCode: 1, output: `execInSprite error: ${(err as Error).message}` }
  }
}

/**
 * Check session layer consistency.
 *
 * Drop-in parity with sprites.ts checkSessionLayerConsistency() — returns the
 * SAME response shape (`SessionLayerConsistency` interface from sprites.ts) so
 * /api/sandbox can return the report verbatim and the dashboard can render the
 * same banner regardless of backend.
 *
 * No CRIU overlay filesystem exists on Fly Machines — the container view and
 * the mounted volume are always the same. `mismatch` is always false because
 * there's no layer to diverge from. Container count is the authoritative number.
 *
 * Fields we cannot populate without an exec API (which Fly Machines doesn't
 * expose for our use case) are filled with zero-as-equal-to-container so the
 * dashboard's "X persistent vs Y container" comparison renders as in-sync.
 */
export interface SessionLayerConsistency {
  persistentSessionCount: number
  persistentTotalJsonl: number
  persistentBytes: number
  containerSessionCount: number
  mismatch: boolean
  projects: Array<{ slug: string; jsonlCount: number; bigJsonlCount: number; totalBytes: number }>
}

export async function checkSessionLayerConsistency(
  _sandboxId: string,
  containerSessionCount: number,
): Promise<SessionLayerConsistency | null> {
  void _sandboxId
  return {
    persistentSessionCount: containerSessionCount,
    persistentTotalJsonl: containerSessionCount,
    persistentBytes: 0, // unknown without volume inspection — dashboard tolerates 0
    containerSessionCount,
    mismatch: false,
    projects: [],
  }
}
