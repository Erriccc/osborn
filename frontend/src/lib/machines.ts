/**
 * machines.ts — Fly.io Machines per-user sandbox provisioning (server-side only)
 *
 * Parallel alternative to sprites.ts. Same exported interface, different backend.
 * Uses the Fly Machines API at https://api.machines.dev for per-user isolated
 * Fly apps, each running a single osborn agent machine.
 *
 * Key differences from Sprites:
 *  - One Fly app per user (app name = osborn-{userId-slug})
 *  - Public URL: https://{app_name}.fly.dev (stable, no auth wall)
 *  - Suspend/resume via Fly CRIU (~300ms) — process state fully preserved
 *  - Auto-suspend: concurrency-based (not 30s timer) — machine stays up during active sessions
 *  - No filesystem API — bootstrap via Docker image CMD
 *  - Requires FLY_API_TOKEN (org-scoped), FLY_ORG_SLUG, FLY_SANDBOX_IMAGE env vars
 *  - IP allocation uses flyctl subprocess (no pure API endpoint exists)
 *
 * Env vars required in frontend/.env.local:
 *   FLY_API_TOKEN=<fly tokens org --name "osborn-provisioner">
 *   FLY_ORG_SLUG=<your org slug, e.g. "personal">
 *   FLY_SANDBOX_IMAGE=registry.fly.io/osborn-sandbox/agent:latest
 */

import { execSync } from 'child_process'

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
  config?: { env?: Record<string, string> }
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

function getApiToken(): string {
  const token = process.env.FLY_API_TOKEN
  if (!token) throw new Error('FLY_API_TOKEN not configured')
  return token
}

function getOrgSlug(): string {
  return process.env.FLY_ORG_SLUG || 'personal'
}

function getSandboxImage(): string {
  return process.env.FLY_SANDBOX_IMAGE || 'registry.fly.io/osborn-sandbox/agent:latest'
}

export function isMachinesConfigured(): boolean {
  return !!process.env.FLY_API_TOKEN
}

function appNameFromUserId(userId: string): string {
  const slug = userId.substring(0, 12).toLowerCase().replace(/[^a-z0-9]/g, '-')
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
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
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
  try {
    await fetch(
      `${FLY_API_BASE}/v1/apps/${appName}/machines/${machineId}/wait?state=${targetState}&timeout=${timeoutSec}`,
      {
        headers: { 'Authorization': `Bearer ${getApiToken()}` },
        signal: AbortSignal.timeout((timeoutSec + 5) * 1000),
      },
    )
    return true
  } catch (err) {
    console.warn(`[machines] waitForMachineState(${targetState}) failed: ${(err as Error).message}`)
    return false
  }
}

/**
 * Poll the agent's /health endpoint until it returns 200.
 */
async function waitForHealth(previewUrl: string, maxAttempts = 30): Promise<boolean> {
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
 * Allocate a shared IPv4 for a Fly app using flyctl subprocess.
 * Required for the app to be reachable at {app_name}.fly.dev.
 * Returns true on success.
 */
function allocateIp(appName: string): boolean {
  try {
    execSync(`fly ips allocate-v4 --shared -a ${appName}`, {
      stdio: 'pipe',
      timeout: 30000,
    })
    console.log(`[machines] Allocated shared IPv4 for ${appName}`)
    return true
  } catch (err) {
    // 409 / "already allocated" is fine
    const msg = (err as Error).message || ''
    if (msg.includes('already') || msg.includes('exists')) {
      console.log(`[machines] IP already allocated for ${appName}`)
      return true
    }
    console.error(`[machines] IP allocation failed for ${appName}: ${msg}`)
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
    'DEEPGRAM_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
    'SMITHERY_API_KEY', 'RECALL_API_KEY',
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
 */
export async function createSandbox(userId: string): Promise<SandboxInfo> {
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
    allocateIp(appName)

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
      guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 1024 },
      services: [{
        protocol: 'tcp',
        internal_port: OSBORN_HTTP_PORT,
        ports: [
          { port: 443, handlers: ['tls', 'http'] },
          { port: 80, handlers: ['http'], force_https: true },
        ],
        autostop: 'suspend',
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
 * Derives app name from userId and checks the Fly API.
 */
export async function findUserSandbox(userId: string): Promise<SandboxInfo | null> {
  const appName = appNameFromUserId(userId)
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
 * Suspend a sandbox machine (CRIU snapshot, ~300ms).
 * Process state is fully preserved — resume picks up exactly where it left off.
 */
export async function stopSandbox(sandboxId: string): Promise<boolean> {
  const appName = sandboxId
  try {
    const machine = await getFirstMachine(appName)
    if (!machine) return true // nothing to stop
    await api('POST', `/v1/apps/${appName}/machines/${machine.id}/suspend`)
    console.log(`[machines] Machine ${machine.id} suspended`)
    return true
  } catch (err) {
    console.error(`[machines] stopSandbox failed: ${(err as Error).message}`)
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
