/**
 * sprites.ts — Fly.io Sprites sandbox provisioning (server-side only)
 *
 * Drop-in replacement for daytona.ts. Manages per-user Osborn agent sandboxes
 * via the Sprites API at https://api.sprites.dev.
 *
 * Requires: SPRITES_API_TOKEN in frontend .env.local
 *
 * Key differences from Daytona:
 *  - Sprites expose a single HTTP port (8080) — osborn binds there via OSBORN_API_PORT=8080
 *  - Sleeping sprites auto-wake on HTTP request (~1s) — no explicit wake API needed
 *  - Services are registered via PUT, with env vars passed via "env" cmd+args pattern
 *    (ServiceRequest has NO env field — use Unix "env KEY=VAL ... cmd" pattern)
 *  - Checkpoints (CRIU) allow fast restore instead of full re-install on resume
 *  - The sprite URL comes from the create response `.url` — do not reconstruct it
 *  - Sprites auto-hibernate after ~30s of inactivity — callers must keep-alive frequently
 *
 * Auth: Each user authenticates Claude Code via OAuth flow (claude-auth.ts in agent).
 * Token persists in sprite filesystem across sleep/wake cycles.
 */

// 'use server' — this module must only be imported from Server Components or API routes

// ─────────────────────────────────────────
// Types
// ─────────────────────────────────────────

export interface SandboxInfo {
  id: string
  status: 'creating' | 'running' | 'warm' | 'cold' | 'sleeping' | 'stopped' | 'archived' | 'error'
  previewUrl?: string
  userId: string
  createdAt: string
  error?: string
}

interface SpritesSprite {
  name: string
  url: string
  /** API returns "cold", "warm", "running" */
  status: 'cold' | 'warm' | 'running' | string
}

interface SpritesCheckpoint {
  id: string
  /** Field name from the API is create_time (snake_case) */
  create_time: string
}

// NDJSON event emitted by streaming Sprites endpoints
interface SpritesStreamEvent {
  type: 'stdout' | 'stderr' | 'exit' | 'complete' | 'info' | 'error'
  data?: string
  exitCode?: number
}

// ─────────────────────────────────────────
// Config
// ─────────────────────────────────────────

const SPRITES_API_BASE = 'https://api.sprites.dev'
const OSBORN_HTTP_PORT = 8080

function getApiToken(): string {
  const token = process.env.SPRITES_API_TOKEN
  if (!token) throw new Error('SPRITES_API_TOKEN not configured')
  return token
}

/**
 * Returns true if Sprites is configured (SPRITES_API_TOKEN is set).
 * Used by route.ts to gate cloud-sandbox features.
 */
export function isSpritesConfigured(): boolean {
  return !!process.env.SPRITES_API_TOKEN
}

/**
 * Derive a deterministic sprite name from a userId.
 * Must be lowercase alphanumeric + hyphens, max 12 chars from userId.
 */
function spriteNameFromUserId(userId: string): string {
  const slug = userId.substring(0, 12).toLowerCase().replace(/[^a-z0-9]/g, '-')
  return `osborn-${slug}`
}

/**
 * Map API sprite status values to our SandboxInfo.status enum.
 * We now pass through the raw sprite status (cold / warm / running) so
 * the dashboard can display the full lifecycle state to the user. The
 * old mapping collapsed warm → running which hid whether the sprite was
 * genuinely serving requests or just hibernating with a CRIU snapshot.
 *
 * The SandboxInfo type union is widened to string to accommodate the
 * raw sprite API values alongside the legacy Daytona values.
 */
function mapSpriteState(status: string): SandboxInfo['status'] {
  // Pass through the meaningful sprite states as-is
  if (status === 'running' || status === 'warm' || status === 'cold') {
    return status as SandboxInfo['status']
  }
  return 'error'
}

/**
 * Collect platform infrastructure env vars to inject into every sprite.
 * Always includes OSBORN_API_PORT=8080 — sprites only expose port 8080.
 * OSBORN_CWD must match the workspace directory created during provisioning.
 * User is "sprite", home is /home/sprite.
 */
function getPlatformEnvVars(userId: string): Record<string, string> {
  const envVars: Record<string, string> = {
    OSBORN_API_PORT: '8080',
    OSBORN_CWD: '/home/sprite/workspace',
    HOME: '/home/sprite',
    // LiveKit room scoped to user for isolation
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

  // Tell the agent where to find this frontend's /api/upload route. The agent
  // uses this to upload session workspace artifacts to Supabase Storage and
  // pass URLs back via the data channel (instead of inlining large content
  // and corrupting the LiveKit publisher connection).
  //
  // OSBORN_PUBLIC_FRONTEND_URL — settable in Railway/deployment env, e.g.
  // "https://osborn.app" in production. VERCEL_URL is auto-populated on Vercel
  // deployments. Both fall back to nothing, in which case the agent just uses
  // the legacy inline path with a size cap.
  const frontendUrl = process.env.OSBORN_PUBLIC_FRONTEND_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '')
  if (frontendUrl) {
    envVars.OSBORN_FRONTEND_URL = frontendUrl
  }

  return envVars
}

// ─────────────────────────────────────────
// Raw API helpers
// ─────────────────────────────────────────

/** Raw JSON API call — GET/POST/PUT/DELETE. Does NOT handle streaming. */
async function api<T = unknown>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${SPRITES_API_BASE}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${getApiToken()}`,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Sprites API ${method} ${path} → ${res.status}: ${text.substring(0, 300)}`)
  }

  if (res.status === 204) return null as T
  return res.json() as Promise<T>
}

/**
 * Consume a streaming NDJSON response from a Sprites exec/service/checkpoint endpoint.
 * Parses line by line, tolerates malformed lines (skips them with a console.warn).
 *
 * Returns the list of parsed events and a boolean indicating whether an 'error'-type
 * event was encountered (distinct from HTTP-level errors).
 */
async function consumeNdjsonStream(
  res: Response,
  label: string,
): Promise<{ events: SpritesStreamEvent[]; hasError: boolean }> {
  const events: SpritesStreamEvent[] = []
  let hasError = false

  if (!res.body) {
    console.warn(`[sprites] ${label}: response has no body`)
    return { events, hasError }
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      // Keep any incomplete trailing line in the buffer
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const event = JSON.parse(trimmed) as SpritesStreamEvent
          events.push(event)
          if (event.type === 'error') {
            hasError = true
            console.error(`[sprites] ${label} stream error: ${event.data}`)
          }
        } catch {
          console.warn(`[sprites] ${label}: malformed NDJSON line — skipping: ${trimmed.substring(0, 120)}`)
        }
      }
    }
    // Flush any remaining buffer content
    if (buffer.trim()) {
      try {
        const event = JSON.parse(buffer.trim()) as SpritesStreamEvent
        events.push(event)
        if (event.type === 'error') hasError = true
      } catch {
        // Ignore incomplete trailing line
      }
    }
  } finally {
    reader.releaseLock()
  }

  return { events, hasError }
}

/**
 * Execute a command inside a sprite via the exec API.
 * Returns stdout/stderr output and exit code.
 *
 * @param spriteName - the sprite name (e.g. "osborn-abc123")
 * @param cmd        - the executable path or command name
 * @param args       - argument list (strings, no shell expansion)
 * @param timeoutSec - exec timeout in seconds
 * @param env        - optional extra env vars for this exec
 */
export async function execInSprite(
  spriteName: string,
  cmd: string,
  args: string[] = [],
  timeoutSec = 30,
  env: Record<string, string> = {},
): Promise<{ exitCode: number; output: string }> {
  const res = await fetch(`${SPRITES_API_BASE}/v1/sprites/${spriteName}/exec`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${getApiToken()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ cmd, args, env, timeout: timeoutSec }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Sprite exec failed: ${res.status}: ${text.substring(0, 200)}`)
  }

  if (!res.body) throw new Error(`exec: no response body`)

  // Sprites exec returns binary protocol (application/octet-stream).
  // Each HTTP chunk is one frame: [stream_id: u8][payload...]
  //   0x01 = stdout, 0x02 = stderr, 0x03 = exit (payload[0] = exit code)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value?.length) chunks.push(value)
  }

  const dec = new TextDecoder()
  let output = ''
  let exitCode = 0
  for (const chunk of chunks) {
    if (!chunk.length) continue
    const sid = chunk[0]
    const payload = chunk.slice(1)
    if (sid === 0x01 || sid === 0x02) output += dec.decode(payload)
    else if (sid === 0x03 && payload.length > 0) exitCode = payload[0]
  }
  return { output: output.trim(), exitCode }
}

/**
 * Write a bash startup script to the sprite at /home/sprite/start-osborn.sh.
 *
 * The script sets PATH to include /.sprite/bin (where node and osborn live),
 * exports all platform env vars, then calls `exec osborn`. The OS kernel reads
 * the osborn shim's shebang (#!/usr/bin/env node) and resolves node from PATH —
 * this avoids the broken `exec node shell-script` pattern used previously.
 *
 * The write uses base64-encode + bash redirect to guarantee the file lands correctly.
 * The write result is verified by reading back the first 3 lines.
 */
export async function writeStartupScript(
  spriteName: string,
  envVars: Record<string, string>,
): Promise<boolean> {
  const exportLines = Object.entries(envVars)
    .map(([k, v]) => `export ${k}='${v.replace(/'/g, "'\\''")}'`)
    .join('\n')

  const scriptContent = `#!/bin/bash
export PATH="/.sprite/bin:\${PATH:-/usr/local/bin:/usr/bin:/bin}"
${exportLines}
exec osborn
`

  const scriptB64 = Buffer.from(scriptContent).toString('base64')
  const writeResult = await execInSprite(
    spriteName,
    'bash',
    ['-c', `echo '${scriptB64}' | base64 -d > /home/sprite/start-osborn.sh && chmod +x /home/sprite/start-osborn.sh`],
    15,
  )
  if (writeResult.exitCode !== 0) {
    console.error(`[sprites] Script write failed (exit ${writeResult.exitCode}): ${writeResult.output}`)
    return false
  }

  // Verify the write by reading back a few lines
  const verify = await execInSprite(spriteName, 'head', ['-3', '/home/sprite/start-osborn.sh'], 5)
  console.log(`[sprites] Startup script verified:\n${verify.output}`)
  if (!verify.output.includes('#!/bin/bash')) {
    console.error('[sprites] Script verification failed — file contents wrong')
    return false
  }

  console.log(`[sprites] Startup script written to /home/sprite/start-osborn.sh`)
  return true
}

/**
 * Wait until the sprite is ready to accept service registrations.
 * Polls GET /v1/sprites/{name} until status is 'warm' or 'running',
 * then attempts a no-op probe to confirm the service endpoint is responsive.
 * Returns true when ready, false on timeout.
 */
async function waitForServiceReady(spriteName: string, maxAttempts = 20): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const sprite = await api<SpritesSprite>('GET', `/v1/sprites/${spriteName}`)
      if (sprite.status === 'warm' || sprite.status === 'running') {
        console.log(`[sprites] Sprite ${spriteName} is ${sprite.status} — ready for service registration`)
        return true
      }
      console.log(`[sprites] Waiting for sprite to warm up (status: ${sprite.status}, attempt ${i + 1}/${maxAttempts})...`)
    } catch {
      // Network error — keep polling
    }
    await new Promise(r => setTimeout(r, 3000))
  }
  console.warn(`[sprites] Sprite ${spriteName} did not reach warm/running state within ${maxAttempts * 3}s`)
  return false
}

/**
 * Register the osborn service on a sprite using an inline bootstrap bash script.
 *
 * All setup logic lives in the service cmd itself — no separate exec/file-write needed.
 * The bootstrap script installs osborn if not present (skipped on checkpoint restores),
 * sets all env vars, creates the workspace directory, then exec's osborn.
 *
 * This approach is reliable because the service manager always runs its configured cmd
 * regardless of whether exec is fire-and-forget.
 */
export async function registerService(
  spriteName: string,
  serviceName: string,
  httpPort: number,
  envVars: Record<string, string>,
): Promise<boolean> {
  const exportLines = Object.entries(envVars)
    .map(([k, v]) => `export ${k}='${v.replace(/'/g, "'\\''")}'`)
    .join('\n')

  // Bootstrap script WITH INSTALL DIAGNOSTICS.
  //
  // Why the complexity: we've seen npm install hang indefinitely after
  // deprecation warnings, with no output to stdout, even though `npm install`
  // is the exact same command that worked in 38 seconds earlier today.
  // Strong signal that a transitive dep or the Sprites npm mirror is stuck.
  //
  // To diagnose, we:
  //   1. Run npm install in the background with --loglevel=verbose, writing
  //      ALL output to /tmp/npm-install.log (readable via Sprites fs API).
  //   2. Run a heartbeat loop in the foreground that emits progress to stdout
  //      (service log) every 20 seconds: elapsed time, line count, last line.
  //      Lets us watch progress live and know if npm is still alive.
  //   3. Kill npm install if it's been running > 10 minutes. Prevents infinite
  //      hang from eating the entire waitForHealth budget.
  //   4. If install fails/hangs, `exec sleep infinity` keeps the sprite alive
  //      so we can read /tmp/npm-install.log post-mortem.
  //
  // Remove this diagnostic shim once the root cause is identified and fixed.
  const bootstrapScript = `
set -e
# npm global bin (e.g. /.sprite/languages/node/nvm/versions/node/<ver>/bin) must come first
# so command -v osborn works on checkpoint restores and exec osborn works after first-run install.
export PATH="$(npm prefix -g)/bin:/.sprite/bin:\${PATH:-/usr/local/bin:/usr/bin:/bin}"
${exportLines}
mkdir -p /home/sprite/workspace

# Install osborn if not already present (skipped on checkpoint restores)
if ! command -v osborn >/dev/null 2>&1; then
  echo "[osborn-bootstrap] Installing osborn + claude-code (verbose -> /tmp/npm-install.log)..."

  # Run npm install in background with verbose logging to a file
  npm install -g osborn@latest @anthropic-ai/claude-code --loglevel=verbose > /tmp/npm-install.log 2>&1 &
  NPM_PID=$!

  # Heartbeat loop: log progress every 20 seconds to the service log
  START=$SECONDS
  while kill -0 $NPM_PID 2>/dev/null; do
    sleep 20
    ELAPSED=$((SECONDS - START))
    LINES=$(wc -l < /tmp/npm-install.log 2>/dev/null || echo 0)
    LAST=$(tail -1 /tmp/npm-install.log 2>/dev/null | head -c 150 || echo "")
    echo "[osborn-bootstrap] install t=\${ELAPSED}s lines=\${LINES} last='\${LAST}'"
    # Kill if stuck > 10 min so waitForHealth doesn't time out waiting forever
    if [ "$ELAPSED" -gt 600 ]; then
      echo "[osborn-bootstrap] STUCK > 10 min, killing npm install pid=\$NPM_PID"
      kill -9 $NPM_PID 2>/dev/null || true
      break
    fi
  done

  wait $NPM_PID 2>/dev/null || true
  INSTALL_EXIT=$?
  echo "[osborn-bootstrap] npm install finished (exit=\$INSTALL_EXIT)"

  # If install failed, keep the sprite alive so we can read /tmp/npm-install.log
  if [ "$INSTALL_EXIT" -ne 0 ] || ! command -v osborn >/dev/null 2>&1; then
    echo "[osborn-bootstrap] INSTALL FAILED - keeping sprite alive for diagnosis"
    echo "[osborn-bootstrap] Read /tmp/npm-install.log via Sprites fs API"
    exec sleep infinity
  fi

  echo "[osborn-bootstrap] Install complete"
fi

echo "[osborn-bootstrap] Starting osborn on port ${httpPort}..."
exec osborn >> /tmp/osborn-sprite.log 2>&1
`.trim()

  const serviceBody = JSON.stringify({
    cmd: '/bin/bash',
    args: ['-c', bootstrapScript],
    needs: [],
    http_port: httpPort,
  })

  const headers = {
    'Authorization': `Bearer ${getApiToken()}`,
    'Content-Type': 'application/json',
  }

  // Retry on 503 — sprite may not be ready to accept service registrations yet
  let res!: Response
  for (let attempt = 0; attempt < 10; attempt++) {
    if (attempt > 0) {
      console.log(`[sprites] registerService: retrying after 503 (attempt ${attempt + 1}/10)...`)
      await new Promise(r => setTimeout(r, 5000))
    }
    res = await fetch(`${SPRITES_API_BASE}/v1/sprites/${spriteName}/services/${serviceName}`, {
      method: 'PUT',
      headers,
      body: serviceBody,
    })
    if (res.status !== 503) break
    await res.body?.cancel().catch(() => {})
  }

  // 409 means the service already exists — delete it first then retry
  if (res.status === 409) {
    console.log(`[sprites] Service ${serviceName} already exists — deleting and re-registering...`)
    await res.body?.cancel().catch(() => {})
    const delRes = await fetch(`${SPRITES_API_BASE}/v1/sprites/${spriteName}/services/${serviceName}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${getApiToken()}` },
    })
    if (!delRes.ok && delRes.status !== 404) {
      const text = await delRes.text()
      console.error(`[sprites] DELETE service failed: ${delRes.status}: ${text.substring(0, 200)}`)
      return false
    }
    await delRes.body?.cancel().catch(() => {})
    res = await fetch(`${SPRITES_API_BASE}/v1/sprites/${spriteName}/services/${serviceName}`, {
      method: 'PUT',
      headers,
      body: serviceBody,
    })
  }

  if (!res.ok) {
    const text = await res.text()
    console.error(`[sprites] registerService failed: ${res.status}: ${text.substring(0, 200)}`)
    return false
  }

  // The PUT response streams NDJSON startup output — read it to confirm service started
  const { events, hasError } = await consumeNdjsonStream(res, `register-service:${serviceName}`)
  console.log(`[sprites] Service registered (events: ${events.map(e => e.type).join(', ')})`)
  return !hasError
}

/**
 * Start a named service on a sprite.
 * Streams the response and waits for completion or error.
 */
export async function startService(spriteName: string, serviceName: string): Promise<boolean> {
  const res = await fetch(`${SPRITES_API_BASE}/v1/sprites/${spriteName}/services/${serviceName}/start`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${getApiToken()}`,
      'Content-Type': 'application/json',
    },
  })

  if (!res.ok) {
    const text = await res.text()
    console.error(`[sprites] startService failed: ${res.status}: ${text.substring(0, 200)}`)
    return false
  }

  const { hasError } = await consumeNdjsonStream(res, `start-service:${serviceName}`)
  return !hasError
}

/**
 * Create a CRIU checkpoint of the current sprite state.
 * Enables fast restore on next startSandbox() instead of full re-install.
 */
export async function createCheckpoint(spriteName: string): Promise<boolean> {
  const res = await fetch(`${SPRITES_API_BASE}/v1/sprites/${spriteName}/checkpoint`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${getApiToken()}`,
    },
  })

  if (!res.ok) {
    const text = await res.text()
    console.error(`[sprites] createCheckpoint failed: ${res.status}: ${text.substring(0, 200)}`)
    return false
  }

  const { events, hasError } = await consumeNdjsonStream(res, 'create-checkpoint')
  const completed = events.some(e => e.type === 'complete')
  if (!completed || hasError) {
    console.warn(`[sprites] Checkpoint may not have completed cleanly. hasError=${hasError}`)
  }
  return !hasError
}

/**
 * List restorable checkpoints for a sprite.
 * Filters out the "Current" pseudo-checkpoint (live state, not restorable via restore endpoint).
 * Sorts by create_time descending — latest first.
 */
export async function listCheckpoints(spriteName: string): Promise<SpritesCheckpoint[]> {
  try {
    const checkpoints = await api<SpritesCheckpoint[]>('GET', `/v1/sprites/${spriteName}/checkpoints`)
    if (!Array.isArray(checkpoints)) return []
    return checkpoints
      .filter(cp => cp.id !== 'Current')
      .sort((a, b) => new Date(b.create_time).getTime() - new Date(a.create_time).getTime())
  } catch (err) {
    console.warn(`[sprites] listCheckpoints failed: ${(err as Error).message}`)
    return []
  }
}

/**
 * Restore a sprite from a specific checkpoint.
 * Streams the restore response and returns whether it succeeded.
 *
 * @param checkpointId - versioned checkpoint ID (e.g. "v0", "v1")
 */
export async function restoreCheckpoint(spriteName: string, checkpointId: string): Promise<boolean> {
  const res = await fetch(`${SPRITES_API_BASE}/v1/sprites/${spriteName}/checkpoints/${checkpointId}/restore`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${getApiToken()}`,
      'Content-Type': 'application/json',
    },
  })

  if (!res.ok) {
    const text = await res.text()
    console.error(`[sprites] restoreCheckpoint(${checkpointId}) failed: ${res.status}: ${text.substring(0, 200)}`)
    return false
  }

  const { hasError } = await consumeNdjsonStream(res, `restore-checkpoint:${checkpointId}`)
  return !hasError
}

/**
 * Poll the sprite's preview URL /health endpoint until it returns 200.
 * Returns true if healthy within the timeout, false otherwise.
 *
 * @param previewUrl   - full base URL of the sprite (e.g. https://osborn-abc.sprites.app)
 * @param maxAttempts  - max poll attempts (2s apart)
 */
export async function waitForHealth(previewUrl: string, maxAttempts = 45): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`${previewUrl}/health`, {
        signal: AbortSignal.timeout(4000),
      })
      if (res.ok) return true
    } catch {
      // Expected while agent is starting — keep polling
    }
    await new Promise(r => setTimeout(r, 2000))
  }
  return false
}

// ─────────────────────────────────────────
// Public API
// ─────────────────────────────────────────

/**
 * Create a new Sprites sandbox for a user.
 *
 * Flow:
 *  1. POST /v1/sprites with { name } only
 *  2. PUT /v1/sprites/{name} to set url_settings.auth=public (separate call required)
 *  3. Wait 2s before first interaction
 *  4. Register osborn as a service with an inline bootstrap script.
 *     The bootstrap handles npm install (on first run only) + env vars + exec osborn.
 *     No exec calls needed — all setup happens inside the service itself.
 *  5. Start the service
 *  6. Poll /health up to 3min (first run installs osborn ~2min; checkpoint restores ~10-20s)
 *  7. Create CRIU checkpoint for fast future restores
 *  8. Return SandboxInfo
 *
 * Rate limits: Sprites enforces concurrent limits (3 on free tier).
 * If creation returns 429 or a rate-limit error body, returns status='error'.
 */
export async function createSandbox(userId: string): Promise<SandboxInfo> {
  if (!isSpritesConfigured()) {
    return { id: '', status: 'error', userId, createdAt: new Date().toISOString(), error: 'Sprites not configured. Set SPRITES_API_TOKEN in .env.local' }
  }

  const spriteName = spriteNameFromUserId(userId)
  console.log(`[sprites] Creating sandbox "${spriteName}" for user ${userId}...`)

  try {
    // Step 1: Create the sprite — send { name } ONLY.
    // url_settings must NOT be in the create body; set it via a separate PUT.
    const createRes = await fetch(`${SPRITES_API_BASE}/v1/sprites`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${getApiToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: spriteName }),
    })

    if (createRes.status === 409) {
      // Sprite already exists — re-register with fresh env and restart
      console.log(`[sprites] Sprite ${spriteName} already exists — recovering...`)
      const existing = await api<SpritesSprite>('GET', `/v1/sprites/${spriteName}`)
      const previewUrl = existing.url
      if (!previewUrl) {
        return { id: spriteName, status: 'error', userId, createdAt: new Date().toISOString(), error: 'Could not recover existing sprite' }
      }
      const envVars = getPlatformEnvVars(userId)
      await registerService(spriteName, 'osborn', OSBORN_HTTP_PORT, envVars)
      await startService(spriteName, 'osborn')
      const healthy = await waitForHealth(previewUrl, 90)
      return {
        id: spriteName,
        status: healthy ? 'running' : 'error',
        previewUrl,
        userId,
        createdAt: new Date().toISOString(),
        ...(healthy ? {} : { error: 'Health check failed after recovery' }),
      }
    }

    if (!createRes.ok) {
      const text = await createRes.text()
      if (createRes.status === 429 || text.includes('concurrent_sprite_limit_exceeded') || text.includes('sprite_creation_rate_limited')) {
        return { id: spriteName, status: 'error', userId, createdAt: new Date().toISOString(), error: 'Concurrent sprite limit exceeded' }
      }
      throw new Error(`Sprites API POST /v1/sprites → ${createRes.status}: ${text.substring(0, 300)}`)
    }

    const sprite = await createRes.json() as SpritesSprite
    console.log(`[sprites] Sprite created: ${spriteName}, url=${sprite.url}`)

    // Step 2: Make the preview URL public (must be a separate PUT call)
    await api('PUT', `/v1/sprites/${spriteName}`, { url_settings: { auth: 'public' } })
    console.log(`[sprites] Sprite made public`)

    const previewUrl = sprite.url

    // Step 3: Wait for sprite to be ready for service registration (avoids 503 race)
    await waitForServiceReady(spriteName)

    // Step 4: Register osborn as a service with an inline bootstrap script.
    // The bootstrap handles npm install (on first run only) + env vars + exec osborn.
    // No exec calls needed — all setup happens inside the service itself.
    const envVars = getPlatformEnvVars(userId)
    console.log(`[sprites] Registering osborn service with bootstrap script...`)
    await registerService(spriteName, 'osborn', OSBORN_HTTP_PORT, envVars)

    // Step 5: Start the service
    console.log(`[sprites] Starting osborn service...`)
    await startService(spriteName, 'osborn')

    // Step 6: Poll /health. First run installs osborn (~2min), so allow up to 3min.
    // Checkpoint restores are fast (~10-20s). No checkpoint on first run.
    console.log(`[sprites] Waiting for agent health at ${previewUrl}/health (up to 3min for first-run install)...`)
    const healthy = await waitForHealth(previewUrl, 90) // 90 × 2s = 3min
    if (!healthy) {
      console.warn(`[sprites] Agent did not become healthy within 3 minutes`)
    } else {
      console.log(`[sprites] Agent healthy`)
    }

    // Step 7: Create CRIU checkpoint — future startSandbox() calls restore in ~10s
    // instead of waiting for npm install again.
    if (healthy) {
      console.log(`[sprites] Creating checkpoint for fast future restores...`)
      await createCheckpoint(spriteName)
      console.log(`[sprites] Checkpoint created`)
    }

    return {
      id: spriteName,
      status: healthy ? 'running' : 'error',
      previewUrl,
      userId,
      createdAt: new Date().toISOString(),
      ...(healthy ? {} : { error: 'Agent did not pass health check after creation' }),
    }
  } catch (err) {
    const msg = (err as Error).message
    console.error(`[sprites] Sandbox creation failed: ${msg}`)
    return { id: spriteName, status: 'error', userId, createdAt: new Date().toISOString(), error: msg }
  }
}

/**
 * Find an existing sandbox for a user by deriving the sprite name from userId.
 *
 * Returns null if the sprite does not exist (404) or lookup fails.
 * Maps sprite state: "cold" → "stopped", "running" → "running", anything else → "error".
 */
export async function findUserSandbox(userId: string): Promise<SandboxInfo | null> {
  const spriteName = spriteNameFromUserId(userId)
  try {
    const sprite = await api<SpritesSprite>('GET', `/v1/sprites/${spriteName}`)

    return {
      id: spriteName,
      status: mapSpriteState(sprite.status),
      previewUrl: sprite.url,
      userId,
      createdAt: new Date().toISOString(),
    }
  } catch (err) {
    const msg = (err as Error).message
    // 404 means no sandbox exists yet — this is normal, not an error
    if (msg.includes('404')) return null
    console.error(`[sprites] findUserSandbox failed: ${msg}`)
    return null
  }
}

/**
 * Start a stopped or sleeping sandbox.
 *
 * After checkpoint restore, startService returns 404 because the Sprites service
 * registry (control plane) does NOT survive cold sleep — only the container filesystem
 * and process memory do. The service must always be re-registered after cold wake.
 *
 * Flow:
 *  1. Get sprite status + URL
 *  2. Restore latest checkpoint if one exists
 *  3. waitForServiceReady — handles 503 race after waking
 *  4. registerService — re-registers + starts the service (handles 409/503 internally)
 *  5. Poll /health up to 60s (30 attempts × 2s)
 *  6. Return SandboxInfo
 *
 * @param sandboxId - the sprite name (e.g. "osborn-abc123def456")
 * @param userId    - user ID, required for getPlatformEnvVars
 */
export async function startSandbox(sandboxId: string, userId: string): Promise<SandboxInfo | null> {
  try {
    // Step 1: Get current sprite state and URL
    const sprite = await api<SpritesSprite>('GET', `/v1/sprites/${sandboxId}`)
    const previewUrl = sprite.url
    console.log(`[sprites] Starting sandbox "${sandboxId}" (current state: ${sprite.status})...`)

    // Step 2: Restore latest checkpoint if available (preserves installed binaries + filesystem)
    // NOTE: Sprites CRIU checkpoints capture container filesystem+memory but NOT the service
    // registry (control plane). The service must always be re-registered after cold wake.
    const checkpoints = await listCheckpoints(sandboxId)
    if (checkpoints.length > 0) {
      const latest = checkpoints[0]
      console.log(`[sprites] Restoring checkpoint ${latest.id} (created ${latest.create_time})...`)
      const restored = await restoreCheckpoint(sandboxId, latest.id)
      if (!restored) {
        console.warn(`[sprites] Checkpoint restore failed — proceeding with cold start`)
      } else {
        console.log(`[sprites] Checkpoint restored`)
      }
    } else {
      console.log(`[sprites] No restorable checkpoints — cold start without restore`)
    }

    // Step 3: Wait for sprite to be ready for service registration
    // Sprite needs ~seconds after waking before the service endpoint accepts requests.
    await waitForServiceReady(sandboxId)

    // Step 4: Re-register the osborn service (required on every cold wake)
    // The Sprites service registry lives in the control plane, not the container —
    // it does NOT survive cold sleep even with CRIU. We must re-register every time.
    // registerService handles: 409 (already registered → delete+retry), 503 (not ready → retry).
    // If osborn is already installed (checkpoint preserved it), the bootstrap skips npm install.
    const envVars = getPlatformEnvVars(userId)
    console.log(`[sprites] Re-registering osborn service (install skipped if checkpoint present)...`)
    const registered = await registerService(sandboxId, 'osborn', OSBORN_HTTP_PORT, envVars)
    if (!registered) {
      console.warn(`[sprites] Service re-registration failed — health check may fail`)
    }

    // Step 5: Poll /health — registerService starts osborn, allow 60s to bind
    console.log(`[sprites] Waiting for agent health at ${previewUrl}/health...`)
    const healthy = await waitForHealth(previewUrl, 30) // 30 × 2s = 60s
    if (!healthy) {
      console.warn(`[sprites] Agent did not respond to health check within 60s`)
    }

    return {
      id: sandboxId,
      status: healthy ? 'running' : 'error',
      previewUrl,
      userId,
      createdAt: new Date().toISOString(),
      ...(healthy ? {} : { error: 'Agent did not pass health check after start' }),
    }
  } catch (err) {
    console.error(`[sprites] startSandbox failed: ${(err as Error).message}`)
    return null
  }
}

/**
 * Stop a sandbox.
 *
 * Sprites auto-hibernate after approximately 30 seconds of inactivity — there is
 * no explicit stop/hibernate endpoint. This function is a no-op that returns true
 * so route.ts can update Supabase status to 'stopped' for UI consistency.
 *
 * @param _sandboxId - unused; sprites hibernate automatically
 */
export async function stopSandbox(_sandboxId: string): Promise<boolean> {
  // Sprites auto-hibernate on inactivity (~30s); there is no explicit stop API.
  // Returning true so route.ts can update Supabase status to 'stopped' for UI consistency.
  return true
}

/**
 * Send a keepalive ping to prevent the sprite from hibernating.
 *
 * IMPORTANT: Sprites auto-hibernate after approximately 30 seconds of inactivity.
 * Callers MUST ping at least every 20 seconds to reliably prevent hibernation.
 * The chat page currently pings every 5 minutes — this is sufficient only because
 * active HTTP requests to the agent also reset the idle timer. If the user is idle,
 * increase the ping frequency to every 20 seconds.
 *
 * @param sandboxId - the sprite name
 */
export async function keepAliveSandbox(sandboxId: string): Promise<boolean> {
  try {
    // Fetching the sprite metadata wakes it if hibernating
    const sprite = await api<SpritesSprite>('GET', `/v1/sprites/${sandboxId}`)

    // Ping the agent health endpoint to confirm it's responding
    const res = await fetch(`${sprite.url}/health`, {
      signal: AbortSignal.timeout(4000),
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Install the latest version of osborn globally inside a sprite.
 * Runs `npm install -g osborn@latest` with a 180s timeout (npm install can be slow).
 * Returns the combined stdout/stderr log and whether the install succeeded.
 *
 * @param sandboxId - the sprite name (e.g. "osborn-abc123def456")
 */
export async function updateOsborn(sandboxId: string): Promise<{ success: boolean; log: string }> {
  console.log(`[sprites] updateOsborn: running npm install -g osborn@latest on ${sandboxId}...`)
  try {
    const { exitCode, output } = await execInSprite(
      sandboxId,
      'npm',
      ['install', '-g', 'osborn@latest'],
      180,
    )
    console.log(`[sprites] updateOsborn: exit=${exitCode}, output length=${output.length}`)
    return { success: exitCode === 0, log: output }
  } catch (err) {
    const msg = (err as Error).message
    console.error(`[sprites] updateOsborn failed: ${msg}`)
    return { success: false, log: msg }
  }
}

/**
 * Restart the osborn service on a sprite via the Sprites service restart endpoint.
 * Use this instead of asking osborn to restart itself (which fails when osborn is frozen).
 *
 * @param sandboxId - the sprite name (e.g. "osborn-abc123def456")
 */
export async function restartService(sandboxId: string): Promise<boolean> {
  try {
    const res = await fetch(`${SPRITES_API_BASE}/v1/sprites/${sandboxId}/services/osborn/restart`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${getApiToken()}`,
        'Content-Type': 'application/json',
      },
    })
    if (!res.ok) {
      const text = await res.text()
      console.error(`[sprites] restartService failed: ${res.status}: ${text.substring(0, 200)}`)
      return false
    }
    await res.body?.cancel().catch(() => {})
    console.log(`[sprites] Service osborn restarted on ${sandboxId}`)
    return true
  } catch (err) {
    console.error(`[sprites] restartService error: ${(err as Error).message}`)
    return false
  }
}

/**
 * Single-shot health check against the osborn agent's /health endpoint.
 * Returns true if the agent responds with HTTP 200 within 3 seconds, false otherwise.
 * Does NOT poll — use waitForHealth() for polling.
 *
 * @param previewUrl - full base URL of the sprite (e.g. https://osborn-abc.sprites.app)
 */
export async function checkOsbornHealth(previewUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${previewUrl}/health`, {
      signal: AbortSignal.timeout(3000),
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Permanently delete a sprite sandbox.
 * Calls DELETE /v1/sprites/{name} on the Sprites API.
 * Returns true on success or if the sprite didn't exist (404), false on error.
 *
 * @param sandboxId - the sprite name (e.g. "osborn-abc123def456")
 */
export async function deleteSandbox(sandboxId: string): Promise<boolean> {
  try {
    const res = await fetch(`${SPRITES_API_BASE}/v1/sprites/${sandboxId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${getApiToken()}` },
    })
    if (res.status === 404 || res.ok) {
      await res.body?.cancel().catch(() => {})
      console.log(`[sprites] Sprite "${sandboxId}" deleted (status ${res.status})`)
      return true
    }
    const text = await res.text()
    console.error(`[sprites] deleteSandbox failed: ${res.status}: ${text.substring(0, 200)}`)
    return false
  } catch (err) {
    console.error(`[sprites] deleteSandbox error: ${(err as Error).message}`)
    return false
  }
}

/**
 * Read a file from inside a sprite using the Sprites filesystem REST API.
 * Returns the file contents as a string, or null if the file doesn't exist or read fails.
 *
 * @param spriteName - the sprite name (e.g. "osborn-abc123")
 * @param filePath   - absolute path inside the sprite (e.g. "/tmp/osborn-sprite.log")
 */
export async function readSpriteFile(spriteName: string, filePath: string): Promise<string | null> {
  try {
    const res = await fetch(
      `${SPRITES_API_BASE}/v1/sprites/${spriteName}/fs/read?path=${encodeURIComponent(filePath)}`,
      {
        headers: { 'Authorization': `Bearer ${getApiToken()}` },
        signal: AbortSignal.timeout(10000),
      }
    )
    if (!res.ok) {
      if (res.status === 404) return null
      const text = await res.text()
      console.warn(`[sprites] readSpriteFile(${filePath}): ${res.status}: ${text.substring(0, 200)}`)
      return null
    }
    return res.text()
  } catch (err) {
    console.warn(`[sprites] readSpriteFile(${filePath}) failed: ${(err as Error).message}`)
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────
// Pool management — pre-warmed sprites
// ─────────────────────────────────────────────────────────────────────
//
// A pool is a set of sprites named `osborn-pool-<suffix>` that have been
// through the full create → install → checkpoint pipeline and are sitting
// cold, ready to be assigned to a new user on demand.
//
// Assignment flow:
//   1. User arrives with no existing sandbox
//   2. Route handler lists pool sprites, cross-references Supabase
//      instances.sandbox_id to find one that isn't yet assigned
//   3. startSandbox(poolName, userId) — wakes from checkpoint AND re-registers
//      the service with the user's real env vars (LIVEKIT_ROOM etc).
//      Because startSandbox always re-registers after a cold wake (Sprites'
//      service registry doesn't survive CRIU), the pool placeholder env gets
//      replaced with the real per-user env on assignment automatically.
//   4. Route handler writes the assignment to Supabase
//   5. Route handler fires createPoolSprite() in the background to refill
//
// No labels API exists on Sprites — assignment is tracked solely in the
// Supabase instances table (sandbox_id column). Source of truth is the
// cross-reference of listPoolSprites() ∩ instances.sandbox_id.

const POOL_PREFIX = 'osborn-pool-'
const POOL_TARGET_SIZE = 3

/** Target size for the pool of unassigned pre-warmed sprites. */
export function getPoolTargetSize(): number {
  return POOL_TARGET_SIZE
}

/**
 * Placeholder user ID for pool sprites before they're assigned.
 * Pool sprites are provisioned with this ID so getPlatformEnvVars() produces
 * a LIVEKIT_ROOM value of "osborn-pool-una". When the pool sprite is later
 * assigned via startSandbox(name, realUserId), the service is re-registered
 * with the real userId and the LIVEKIT_ROOM is updated to the user-scoped value.
 */
const POOL_PLACEHOLDER_USER_ID = 'pool-unassigned'

/**
 * Generate a random sprite name for a pool sprite.
 * Format: osborn-pool-{8-char-hex-suffix}
 * Collision probability over 3 sprites ≈ 1 in 2^28. Fine for a dev feature.
 */
function randomPoolSpriteName(): string {
  const suffix = Math.random().toString(16).substring(2, 10).padEnd(8, '0')
  return `${POOL_PREFIX}${suffix}`
}

/**
 * List all pool sprites on the account. Pool sprites are identified by name
 * prefix (osborn-pool-). Returns a minimal summary — just the fields the
 * pool assignment logic needs.
 *
 * Sprites API returns { sprites: [...] } at GET /v1/sprites.
 */
export async function listPoolSprites(): Promise<Array<{ name: string; url: string; status: string }>> {
  try {
    const data = await api<{ sprites: SpritesSprite[] }>('GET', '/v1/sprites')
    if (!data?.sprites || !Array.isArray(data.sprites)) return []
    return data.sprites
      .filter(s => s.name.startsWith(POOL_PREFIX))
      .map(s => ({ name: s.name, url: s.url, status: s.status }))
  } catch (err) {
    console.error(`[sprites] listPoolSprites failed: ${(err as Error).message}`)
    return []
  }
}

/**
 * Create a new pool sprite. Runs the full provisioning flow (create → public →
 * waitForServiceReady → registerService → startService → waitForHealth →
 * createCheckpoint) — same as createSandbox — but with a random pool name and
 * a placeholder userId for the initial env vars.
 *
 * Takes ~6 minutes on first-run (npm install of osborn + claude-code). The
 * checkpoint captured at the end lets future startSandbox() calls restore in
 * ~10-20 seconds instead of re-running the full install.
 *
 * Returns the sprite name on success, null on failure.
 */
export async function createPoolSprite(): Promise<string | null> {
  if (!isSpritesConfigured()) return null

  const spriteName = randomPoolSpriteName()
  console.log(`[sprites] Creating pool sprite "${spriteName}"...`)

  try {
    // Step 1: Create the sprite
    const createRes = await fetch(`${SPRITES_API_BASE}/v1/sprites`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${getApiToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: spriteName }),
    })

    if (!createRes.ok) {
      const text = await createRes.text()
      console.error(`[sprites] createPoolSprite: create failed: ${createRes.status}: ${text.substring(0, 200)}`)
      return null
    }

    const sprite = await createRes.json() as SpritesSprite
    console.log(`[sprites] Pool sprite created: ${spriteName}, url=${sprite.url}`)

    // Step 2: Make public
    await api('PUT', `/v1/sprites/${spriteName}`, { url_settings: { auth: 'public' } })

    // Step 3: Wait for readiness (handles the 503 race on fresh sprites)
    const ready = await waitForServiceReady(spriteName)
    if (!ready) {
      console.error(`[sprites] createPoolSprite: sprite ${spriteName} never became ready`)
      return null
    }

    // Step 4: Register service with placeholder env vars. When the pool sprite
    // is later assigned to a real user, startSandbox() will re-register with
    // the user's real env vars — the placeholder LIVEKIT_ROOM gets overwritten.
    const envVars = getPlatformEnvVars(POOL_PLACEHOLDER_USER_ID)
    const registered = await registerService(spriteName, 'osborn', OSBORN_HTTP_PORT, envVars)
    if (!registered) {
      console.error(`[sprites] createPoolSprite: registerService failed for ${spriteName}`)
      return null
    }

    // Step 5: Start the service
    await startService(spriteName, 'osborn')

    // Step 6: Wait for health — first run installs osborn from scratch (~2min)
    console.log(`[sprites] Waiting for pool sprite ${spriteName} to become healthy...`)
    const healthy = await waitForHealth(sprite.url, 90) // 90 × 2s = 3min
    if (!healthy) {
      console.error(`[sprites] createPoolSprite: ${spriteName} did not pass health check`)
      return null
    }

    // Step 7: Checkpoint — next wake restores in ~10-20s instead of 6min
    console.log(`[sprites] Pool sprite ${spriteName} healthy — creating checkpoint...`)
    await createCheckpoint(spriteName)
    console.log(`[sprites] Pool sprite ${spriteName} ready and checkpointed`)

    return spriteName
  } catch (err) {
    console.error(`[sprites] createPoolSprite failed: ${(err as Error).message}`)
    return null
  }
}

/**
 * Find the first pool sprite that is not yet assigned to any user.
 * Cross-references listPoolSprites() output against the provided list of
 * assigned sandbox IDs (typically pulled from the Supabase instances table).
 *
 * Returns the first unassigned pool sprite, or null if none are available.
 */
async function findUnassignedPoolSprite(
  assignedSandboxIds: string[],
): Promise<{ name: string; url: string; status: string } | null> {
  const poolSprites = await listPoolSprites()
  const assignedSet = new Set(assignedSandboxIds)
  return poolSprites.find(s => !assignedSet.has(s.name)) ?? null
}

/**
 * Assign a pool sprite to a user (or provision fresh if the pool is empty).
 *
 * This is the single high-level entry point that route.ts uses in the
 * POST /api/sandbox create path. It:
 *   1. Tries to find an unassigned pool sprite
 *   2. If found, wakes it via startSandbox(name, userId) — re-registers the
 *      service with the user's real env (LIVEKIT_ROOM becomes user-scoped)
 *   3. Fire-and-forget: spawns a replacement pool sprite in the background
 *      if the pool falls below target size after this assignment
 *   4. If no pool sprites are available, falls back to createSandbox(userId)
 *      — the original per-user provisioning flow (~6 min cold)
 *
 * Caller is responsible for updating Supabase with the returned assignment.
 */
export async function assignFromPoolOrCreate(
  userId: string,
  assignedSandboxIds: string[],
): Promise<SandboxInfo> {
  const poolSprite = await findUnassignedPoolSprite(assignedSandboxIds)

  if (poolSprite) {
    console.log(`[sprites] Assigning pool sprite ${poolSprite.name} to user ${userId}`)
    const assigned = await startSandbox(poolSprite.name, userId)

    if (assigned && assigned.status === 'running') {
      // Fire-and-forget replenishment: if pool count drops below target,
      // spawn a replacement in the background. Errors are logged but don't
      // block the response.
      void (async () => {
        try {
          const remaining = await listPoolSprites()
          // Subtract the sprite we just assigned — it's no longer "in the pool"
          // conceptually even though its name still matches the prefix.
          const unassignedCount = remaining.filter(s => s.name !== poolSprite.name).length
          const deficit = getPoolTargetSize() - unassignedCount
          if (deficit > 0) {
            console.log(`[sprites] Pool replenish: creating ${deficit} replacement sprite(s) (current: ${unassignedCount}/${getPoolTargetSize()})...`)
            // Spawn them in parallel. Don't await — this runs after the response.
            await Promise.allSettled(
              Array.from({ length: deficit }, () => createPoolSprite()),
            )
            console.log(`[sprites] Pool replenish complete`)
          }
        } catch (err) {
          console.error(`[sprites] Pool replenish failed: ${(err as Error).message}`)
        }
      })()

      return assigned
    }

    console.warn(`[sprites] Pool assignment of ${poolSprite.name} failed — falling back to fresh provision`)
    // fall through to createSandbox
  } else {
    console.log(`[sprites] No unassigned pool sprites available — provisioning fresh`)
  }

  // No pool sprite available OR pool assignment failed — fall back to the
  // original per-user cold provisioning flow (~6 minutes).
  return createSandbox(userId)
}
