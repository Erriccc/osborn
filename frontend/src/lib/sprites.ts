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
const NPM_REGISTRY = 'https://registry.npmjs.org'

function getApiToken(): string {
  const token = process.env.SPRITES_API_TOKEN
  if (!token) throw new Error('SPRITES_API_TOKEN not configured')
  return token
}

/**
 * Read the version of osborn currently installed on a sprite.
 *
 * Tries the marker file first (written by `buildOsbornBootstrap` after every
 * successful install) and falls back to reading the installed package.json
 * directly. Both via the Sprites fs API — neither involves the broken exec API.
 *
 * Returns null if neither source is readable (e.g. sprite never installed
 * osborn from registry, or fs API is unreachable).
 */
export async function readInstalledOsbornVersion(spriteName: string): Promise<string | null> {
  // 1. Marker file (preferred — written by our bootstrap, knows exactly what we asked for)
  const markerVersion = await readSpriteFile(spriteName, '/home/sprite/.osborn-installed-version')
  if (markerVersion) {
    const trimmed = markerVersion.trim()
    if (trimmed) return trimmed
  }

  // 2. Fallback: read the installed package.json. If osborn is a npm-link symlink to
  // local source, this still returns the symlink target's version (which may be stale).
  // The marker file path is the source of truth for "what we last installed via the
  // upgrade flow". When the marker is absent, we're reading whatever's there.
  // Try common Node version paths (Sprites uses nvm).
  const candidates = [
    '/.sprite/languages/node/nvm/versions/node/v22.20.0/lib/node_modules/osborn/package.json',
    '/.sprite/languages/node/nvm/versions/node/v22.14.0/lib/node_modules/osborn/package.json',
    '/.sprite/languages/node/nvm/versions/node/v20.11.0/lib/node_modules/osborn/package.json',
  ]
  for (const path of candidates) {
    const content = await readSpriteFile(spriteName, path)
    if (!content) continue
    try {
      const pkg = JSON.parse(content) as { version?: string }
      if (pkg.version) return pkg.version
    } catch {
      // continue
    }
  }
  return null
}

/**
 * Fetch the latest published version of `osborn` from the npm registry.
 *
 * Returns a concrete version string like "0.8.31". Throws on network failure
 * or unexpected response. Used by the bootstrap to bake a target version into
 * the service definition so the in-container marker comparison is meaningful
 * (comparing against literal "latest" never matches).
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
    'SMITHERY_API_KEY',
    // Recall.ai bot integration. RECALL_API_KEY is the auth token; RECALL_REGION
    // selects the regional API endpoint (default 'us-west-2' if unset). If the
    // user's Recall.ai account is in another region, this MUST be forwarded
    // or every meeting bot call hits the wrong endpoint.
    'RECALL_API_KEY', 'RECALL_REGION',
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
 * Wait until the sprite's exec subsystem is ready to accept commands.
 *
 * The Sprites control plane flips a sprite to "running" before its exec
 * endpoint can actually launch processes — we've seen `503: Process not ready
 * after 30s` for ~10–60s after wake. Polls a no-op `echo ready` until exit 0.
 *
 * Modeled on waitForServiceReady but probes the exec subsystem specifically.
 *
 * @param spriteName  - the sprite name
 * @param maxAttempts - max poll attempts (2s apart) — default 30 = 60s
 * @returns true if exec is ready, false on timeout
 */
export async function waitForExecReady(spriteName: string, maxAttempts = 30): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      // Pass skipWait=true so we don't infinitely recurse into ourselves.
      const { exitCode } = await execInSprite(spriteName, 'echo', ['ready'], 5, {}, true)
      if (exitCode === 0) {
        if (i > 0) console.log(`[sprites] Exec ready on ${spriteName} after ${i + 1} attempt(s)`)
        return true
      }
    } catch (err) {
      const msg = (err as Error).message
      // 503 "Process not ready" is the expected transient state — keep polling silently
      if (!msg.includes('503')) {
        console.warn(`[sprites] waitForExecReady probe error (attempt ${i + 1}/${maxAttempts}): ${msg.substring(0, 120)}`)
      }
    }
    await new Promise(r => setTimeout(r, 2000))
  }
  console.warn(`[sprites] waitForExecReady: ${spriteName} exec not ready within ${maxAttempts * 2}s — proceeding anyway`)
  return false
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
 * @param skipWait   - if true, skips the waitForExecReady() preflight (use for
 *                     internal calls from waitForExecReady itself, or when the
 *                     caller has already confirmed exec subsystem is up)
 */
export async function execInSprite(
  spriteName: string,
  cmd: string,
  args: string[] = [],
  timeoutSec = 30,
  env: Record<string, string> = {},
  skipWait = false,
): Promise<{ exitCode: number; output: string }> {
  if (!skipWait) {
    await waitForExecReady(spriteName)
  }
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
 * Build the bootstrap shell script that runs as the osborn service entry-point.
 *
 * The bootstrap is responsible for: env setup → ensure correct osborn version is
 * installed → exec osborn. It runs on every service start (first creation, warm
 * wake, cold wake, post-restore, manual stop+start).
 *
 * Marker-file based version tracking:
 *   - `WANT="X.Y.Z"` is baked into the cmd at PUT-time by the frontend.
 *   - `/home/sprite/.osborn-installed-version` is a marker file written by the
 *     bootstrap AFTER each successful install. It records what version was last
 *     installed via this mechanism. (Container-local — fs API and container fs
 *     are disjoint views, so this file is invisible to fs-API readers; both
 *     sides of the marker write/read happen inside the container.)
 *
 * Decision logic — install if ANY of these is true:
 *   1. Symlink at `lib/node_modules/osborn` (npm-link state, never a real install)
 *   2. `osborn` binary not found in PATH
 *   3. Marker file's version doesn't match WANT
 *
 * On install: `npm unlink + rm -rf + npm install --force` to handle every prior
 * state (symlink, partial install, wrong version). Marker is written on success.
 * On failure, `exec sleep infinity` keeps the sprite alive for post-mortem.
 *
 * To trigger an upgrade later, the frontend re-PUTs the bootstrap with a new WANT.
 * Marker mismatch → install runs.
 */
export function buildOsbornBootstrap(
  envVars: Record<string, string>,
  httpPort: number,
  targetVersion: string,
): string {
  const exportLines = Object.entries(envVars)
    .map(([k, v]) => `export ${k}='${v.replace(/'/g, "'\\''")}'`)
    .join('\n')

  return `set -e
# npm global bin must come first so command -v osborn finds the registry install
export PATH="$(npm prefix -g)/bin:/.sprite/bin:\${PATH:-/usr/local/bin:/usr/bin:/bin}"
${exportLines}
mkdir -p /home/sprite/workspace

# Marker-based upgrade detection. Frontend bakes WANT in via PUT; bootstrap writes
# marker after successful install. Future restarts skip install when marker matches.
WANT="${targetVersion}"
MARKER="/home/sprite/.osborn-installed-version"
NPM_PREFIX="$(npm prefix -g)"
INSTALLED="$(cat "$MARKER" 2>/dev/null | tr -d '[:space:]' || echo '')"

NEEDS_INSTALL=false
REASON=""

if [ -L "$NPM_PREFIX/lib/node_modules/osborn" ] || [ -L "$NPM_PREFIX/bin/osborn" ]; then
  NEEDS_INSTALL=true
  REASON="symlink detected (npm-link state)"
elif ! command -v osborn >/dev/null 2>&1; then
  NEEDS_INSTALL=true
  REASON="osborn binary missing"
elif [ "$INSTALLED" != "$WANT" ]; then
  NEEDS_INSTALL=true
  REASON="marker mismatch (have='$INSTALLED' want='$WANT')"
fi

echo "[osborn-bootstrap] WANT=$WANT marker='$INSTALLED' needs-install=$NEEDS_INSTALL reason='$REASON'"

if [ "$NEEDS_INSTALL" = "true" ]; then
  echo "[osborn-bootstrap] >>> force-installing osborn@$WANT from npm registry"

  # Nuke ALL traces — handles symlinks AND existing installs. --force survives conflicts.
  npm unlink -g osborn 2>/dev/null || true
  rm -rf "$NPM_PREFIX/lib/node_modules/osborn" 2>/dev/null || true
  rm -f "$NPM_PREFIX/bin/osborn" 2>/dev/null || true

  echo "[osborn-bootstrap] running npm install (verbose -> /tmp/npm-install.log)"
  npm install -g "osborn@$WANT" @anthropic-ai/claude-code --force --loglevel=verbose > /tmp/npm-install.log 2>&1 &
  NPM_PID=$!
  START=$SECONDS

  # Heartbeat loop emits progress so we know npm install is alive
  while kill -0 $NPM_PID 2>/dev/null; do
    sleep 10
    ELAPSED=$((SECONDS - START))
    LINES=$(wc -l < /tmp/npm-install.log 2>/dev/null || echo 0)
    LAST=$(tail -1 /tmp/npm-install.log 2>/dev/null | head -c 120 || echo "")
    echo "[osborn-bootstrap] install t=\${ELAPSED}s lines=\${LINES} last='\${LAST}'"
    if [ "$ELAPSED" -gt 600 ]; then
      echo "[osborn-bootstrap] STUCK > 10 min, killing npm install pid=\$NPM_PID"
      kill -9 $NPM_PID 2>/dev/null || true
      break
    fi
  done

  wait $NPM_PID 2>/dev/null || true
  INSTALL_EXIT=$?
  echo "[osborn-bootstrap] install finished exit=\$INSTALL_EXIT"

  if [ "$INSTALL_EXIT" -ne 0 ] || ! command -v osborn >/dev/null 2>&1; then
    echo "[osborn-bootstrap] INSTALL FAILED — keeping sprite alive for diagnosis"
    echo "[osborn-bootstrap] tail /tmp/npm-install.log:"
    tail -30 /tmp/npm-install.log 2>/dev/null
    exec sleep infinity
  fi

  # Write marker so next restart skips install (fast restart path)
  echo "$WANT" > "$MARKER"
  echo "[osborn-bootstrap] install OK — marker written: $WANT"
fi

# Layer-divergence diagnostic — surfaces the container's view of session JSONLs at
# boot. Sprites uses CRIU + an overlay-style /home, so the persistent disk (what the
# fs API reads) and the container view can diverge after restore cycles. If the
# counts here ever drop without user action between two boots, divergence is the
# first thing to suspect — cross-check against fs API count from the frontend.
echo "[osborn-bootstrap] Session inventory (container view):"
PROJECTS_DIR="/home/sprite/.claude/projects"
if [ -d "$PROJECTS_DIR" ]; then
  for proj in "$PROJECTS_DIR"/*/; do
    [ -d "$proj" ] || continue
    SLUG="$(basename "$proj")"
    JSONL_COUNT="$(find "$proj" -maxdepth 1 -name '*.jsonl' 2>/dev/null | wc -l | tr -d ' ')"
    BIG_COUNT="$(find "$proj" -maxdepth 1 -name '*.jsonl' -size +100k 2>/dev/null | wc -l | tr -d ' ')"
    TOTAL_BYTES="$(find "$proj" -maxdepth 1 -name '*.jsonl' -printf '%s\n' 2>/dev/null | awk '{s+=$1} END {print s+0}')"
    echo "[osborn-bootstrap]   project=$SLUG jsonl=$JSONL_COUNT (>=100k=$BIG_COUNT) bytes=$TOTAL_BYTES"
  done
else
  echo "[osborn-bootstrap]   (no projects dir at $PROJECTS_DIR — fresh sprite or first boot)"
fi

echo "[osborn-bootstrap] Starting osborn on port ${httpPort}..."
# No redirect — let osborn's stdout/stderr flow to the service's stdout pipe.
# That makes osborn's runtime output visible via Sprites' service-logs API
# (GET /v1/sprites/<name>/services/<name>/logs). The previous redirect to
# /tmp/osborn-sprite.log was on a filesystem layer that the Sprites fs API
# couldn't read — meaning osborn's output was invisible to every API surface.
exec osborn 2>&1
`.trim()
}

/**
 * Register the osborn service on a sprite using an inline bootstrap bash script.
 *
 * Bootstrap behavior is documented on `buildOsbornBootstrap`. Caller can either
 * pass a concrete `targetVersion` (e.g. "0.8.31") or omit it — in which case
 * we resolve the latest from the npm registry. Resolving is required because
 * the bootstrap compares WANT against a marker file that stores a concrete
 * version string; the literal "latest" never matches.
 *
 * On Sprites, PUT to an existing service silently no-ops on cmd updates. To
 * change the bootstrap (e.g. for an upgrade), call `updateOsborn()` which does
 * the stop+delete+PUT dance correctly. This function is for INITIAL registration
 * (createSandbox) and post-cold-wake re-registration (startSandbox).
 */
export async function registerService(
  spriteName: string,
  serviceName: string,
  httpPort: number,
  envVars: Record<string, string>,
  targetVersion?: string,
): Promise<boolean> {
  const version = targetVersion ?? (await resolveOsbornLatest().catch((err) => {
    console.warn(`[sprites] resolveOsbornLatest failed: ${(err as Error).message} — falling back to "latest" (marker comparison will always force install)`)
    return 'latest'
  }))
  const bootstrapScript = buildOsbornBootstrap(envVars, httpPort, version)

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

    // Bonus: if the sprite is already running and healthy, skip restore entirely.
    // Avoids triggering Sprites' auto-snapshot system (pre-restore-vN) when nothing
    // is actually broken.
    if (sprite.status === 'running' && previewUrl) {
      try {
        const h = await fetch(`${previewUrl}/health`, { signal: AbortSignal.timeout(3000) })
        if (h.ok) {
          console.log(`[sprites] ${sandboxId} already healthy — no restore needed`)
          return {
            id: sandboxId,
            status: 'running',
            previewUrl,
            userId,
            createdAt: new Date().toISOString(),
          }
        }
      } catch {
        // Not healthy — fall through to restore path
      }
    }

    // Step 2: Restore latest USER-BLESSED checkpoint — IF the existing service definition
    // does NOT already have marker-bootstrap logic. The marker bootstrap is self-healing:
    // it detects missing/symlink installs and re-installs from the registry on every cold
    // wake. Restoring an old checkpoint that pre-dates the install causes a re-install loop
    // (checkpoint → no marker → install → sprite hibernates → restore old checkpoint → repeat).
    //
    // We also filter out `pre-restore-vN` snapshots — Sprites auto-creates these before
    // every restore and they often capture mid-corruption states.
    let bootstrapHasMarker = false
    try {
      const existing = await api<{ args?: string[] }>('GET', `/v1/sprites/${sandboxId}/services/osborn`)
      bootstrapHasMarker = (existing.args?.[1] ?? '').includes('osborn-installed-version')
    } catch {
      // service may not be registered yet (cold sprite) — fall through to restore
    }

    if (bootstrapHasMarker) {
      console.log(`[sprites] Service has marker bootstrap — skip checkpoint restore (bootstrap will re-install if needed)`)
    } else {
      const checkpoints = await listCheckpoints(sandboxId)
      const userBlessed = checkpoints.filter(cp => !cp.id.startsWith('pre-restore-'))
      const latest = userBlessed[0] ?? null
      if (latest) {
        console.log(`[sprites] Restoring checkpoint ${latest.id} (created ${latest.create_time})...`)
        const restored = await restoreCheckpoint(sandboxId, latest.id)
        if (!restored) {
          console.warn(`[sprites] Checkpoint restore failed — proceeding with cold start`)
        } else {
          console.log(`[sprites] Checkpoint restored`)
        }
      } else if (checkpoints.length > 0) {
        console.warn(`[sprites] No clean (non-pre-restore) checkpoint for ${sandboxId} — proceeding with cold start (skipped ${checkpoints.length} pre-restore-* snapshot(s))`)
      } else {
        console.log(`[sprites] No restorable checkpoints — cold start without restore`)
      }
    }

    // Step 3: Wait for sprite to be ready for service registration
    // Sprite needs ~seconds after waking before the service endpoint accepts requests.
    await waitForServiceReady(sandboxId)

    // Step 4: Re-register the osborn service ONLY if needed.
    //
    // Why this guard: Railway runs multiple instances of the frontend during deploy.
    // If a still-running OLD instance of the frontend handles a startSandbox call
    // after a NEW instance has already registered the marker bootstrap, the OLD
    // instance overwrites the new bootstrap with the old one. Result: every cold
    // wake during a rolling deploy could regress the upgrade.
    //
    // Mitigation: before re-registering, check if the existing service definition
    // already has marker-based logic (signal: contains "osborn-installed-version")
    // AND the service is running healthy. If so, skip the re-register — the
    // service is already correctly configured.
    let needsRegister = true
    try {
      const existing = await api<{ args?: string[]; state?: { status?: string } }>(
        'GET',
        `/v1/sprites/${sandboxId}/services/osborn`,
      )
      const existingCmd = existing.args?.[1] ?? ''
      const hasMarkerLogic = existingCmd.includes('osborn-installed-version')
      const isRunning = existing.state?.status === 'running'
      if (hasMarkerLogic && isRunning) {
        // Probe /health to confirm the running service actually responds
        try {
          const h = await fetch(`${previewUrl}/health`, { signal: AbortSignal.timeout(3000) })
          if (h.ok) {
            console.log(`[sprites] ${sandboxId} service already has marker bootstrap and is healthy — skip re-register`)
            needsRegister = false
          }
        } catch {}
      }
    } catch {
      // 404 or fetch error — proceed with registration
    }

    if (needsRegister) {
      const envVars = getPlatformEnvVars(userId)
      console.log(`[sprites] Re-registering osborn service (install skipped if checkpoint marker matches WANT)...`)
      const registered = await registerService(sandboxId, 'osborn', OSBORN_HTTP_PORT, envVars)
      if (!registered) {
        console.warn(`[sprites] Service re-registration failed — health check may fail`)
      }
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
 * Upgrade osborn on a sprite to a target version.
 *
 * Why this is structured the way it is:
 *
 *   1. The Sprites exec API silently no-ops on warm/cold sprites — `npm install`
 *      via execInSprite reports exit=0 with zero output but doesn't actually run.
 *      So we cannot upgrade by exec'ing npm.
 *
 *   2. PUT to `/services/osborn` while the service is running silently rejects
 *      cmd updates ("Service already running with that command"). Have to do
 *      stop → DELETE → PUT to actually change the bootstrap.
 *
 *   3. Past sprites had osborn installed via `npm link` (symlink to local source
 *      at /home/sprite/workspace/osborn-src/agent). The bootstrap's old
 *      `command -v osborn` check was satisfied by the symlink and skipped install
 *      forever. New marker-based bootstrap (`buildOsbornBootstrap`) detects the
 *      symlink and force-installs from the npm registry.
 *
 * Flow:
 *   1. Resolve target version (npm registry → e.g. "0.8.31") unless caller passed one
 *   2. Get current sprite (preview URL)
 *   3. Reuse the user's platform env vars from `getPlatformEnvVars(userId)`
 *   4. Stop osborn service (graceful, 10s timeout)
 *   5. DELETE osborn service registration (REQUIRED — PUT alone won't update cmd)
 *   6. PUT new bootstrap with WANT=<targetVersion> (auto-starts service)
 *   7. Wait for /health to return 200 (up to 120s — install can take 60s+)
 *
 * Returns the actual installed version string on success (read from npm registry
 * resolution; not from inside the sprite, since `osborn --version` doesn't have
 * a real handler yet).
 *
 * @param sandboxId - the sprite name (e.g. "osborn-1b9d70e5-2a4")
 * @param userId    - user ID for `getPlatformEnvVars`
 * @param version   - optional target version. Omit to use npm registry latest.
 */
// Per-sprite in-flight lock for updateOsborn. Concurrent calls collide
// destructively because updateOsborn does stop → DELETE → PUT in sequence —
// if a second call's DELETE lands between the first call's PUT and its
// /health-poll completing, the second call wipes the just-registered service
// and the first call's poll fails with "service not found" / "manager dead".
// In production we saw this happen with two clicks 3 seconds apart, leaving
// the sprite in a degraded state until the marker bootstrap self-healed.
//
// The lock returns the in-flight call's promise to subsequent callers, so
// they get the same result instead of triggering parallel work. Per Next.js
// instance — for true cross-instance locking we'd need Redis or a Postgres
// advisory lock, but per-instance catches the multi-click and debounce
// gaps that cause most damage.
const updateInflight = new Map<string, Promise<{ success: boolean; version: string | null; log: string }>>()

export async function updateOsborn(
  sandboxId: string,
  userId: string,
  version?: string,
): Promise<{ success: boolean; version: string | null; log: string }> {
  // Serialize concurrent calls per sprite — if one is already in flight,
  // return its promise instead of starting a new one.
  const existing = updateInflight.get(sandboxId)
  if (existing) {
    console.log(`[sprites] updateOsborn: join in-flight call for ${sandboxId} (de-duped)`)
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

async function updateOsbornImpl(
  sandboxId: string,
  userId: string,
  version?: string,
): Promise<{ success: boolean; version: string | null; log: string }> {
  let targetVersion: string
  try {
    targetVersion = version ?? (await resolveOsbornLatest())
  } catch (err) {
    return { success: false, version: null, log: `Could not resolve target version: ${(err as Error).message}` }
  }

  console.log(`[sprites] updateOsborn: target=${targetVersion} on ${sandboxId}`)

  // Short-circuit: if the marker file already shows the target version AND osborn
  // is healthy, no work is needed. This handles the "user clicks Update twice in
  // a row" pattern — the second click sees the install already happened (marker
  // matches) and returns immediately instead of triggering another stop+delete+PUT.
  try {
    const installedNow = await readInstalledOsbornVersion(sandboxId)
    if (installedNow === targetVersion) {
      const sprite = await api<SpritesSprite>('GET', `/v1/sprites/${sandboxId}`)
      if (sprite.url) {
        try {
          const h = await fetch(`${sprite.url}/health`, { signal: AbortSignal.timeout(3000) })
          if (h.ok) {
            console.log(`[sprites] updateOsborn: marker already at ${targetVersion} and /health 200 — skipping (no-op)`)
            return { success: true, version: targetVersion, log: `Already at osborn@${targetVersion}` }
          }
        } catch {} // not healthy, fall through to full upgrade
      }
    }
  } catch (err) {
    // Could not read marker / sprite — fall through to full upgrade
    console.warn(`[sprites] updateOsborn: short-circuit check failed: ${(err as Error).message} — proceeding with full upgrade`)
  }

  let previewUrl: string
  try {
    const sprite = await api<SpritesSprite>('GET', `/v1/sprites/${sandboxId}`)
    previewUrl = sprite.url
  } catch (err) {
    return { success: false, version: null, log: `Could not fetch sprite metadata: ${(err as Error).message}` }
  }

  const envVars = getPlatformEnvVars(userId)
  const headers = { 'Authorization': `Bearer ${getApiToken()}`, 'Content-Type': 'application/json' }

  try {
    // Step 1: Stop the running service (graceful)
    console.log(`[sprites] updateOsborn: stopping current service`)
    const stopRes = await fetch(`${SPRITES_API_BASE}/v1/sprites/${sandboxId}/services/osborn/stop`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ timeout: 10 }),
    })
    if (stopRes.body) await consumeNdjsonStream(stopRes, 'updateOsborn:stop').catch(() => ({}))

    // Step 2: DELETE the registration — REQUIRED before PUT can change cmd
    console.log(`[sprites] updateOsborn: deleting service registration`)
    const delRes = await fetch(`${SPRITES_API_BASE}/v1/sprites/${sandboxId}/services/osborn`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${getApiToken()}` },
    })
    if (!delRes.ok && delRes.status !== 404) {
      console.warn(`[sprites] updateOsborn: DELETE returned ${delRes.status} (continuing anyway)`)
    }
    await delRes.text()

    // Step 3: PUT new bootstrap with target version baked in (auto-starts service)
    console.log(`[sprites] updateOsborn: PUT new bootstrap with WANT=${targetVersion}`)
    const bootstrap = buildOsbornBootstrap(envVars, OSBORN_HTTP_PORT, targetVersion)
    const putRes = await fetch(`${SPRITES_API_BASE}/v1/sprites/${sandboxId}/services/osborn`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ cmd: '/bin/bash', args: ['-c', bootstrap], needs: [], http_port: OSBORN_HTTP_PORT }),
    })
    if (!putRes.ok) {
      const text = await putRes.text()
      return { success: false, version: null, log: `PUT failed: ${putRes.status}: ${text.slice(0, 300)}` }
    }
    if (putRes.body) await consumeNdjsonStream(putRes, 'updateOsborn:put').catch(() => ({}))

    // Step 4: Poll /health (npm install can take 60s, so allow 120s budget)
    console.log(`[sprites] updateOsborn: polling ${previewUrl}/health (max 120s)`)
    const healthy = await waitForHealth(previewUrl, 60) // 60 × 2s = 120s
    if (!healthy) {
      return { success: false, version: null, log: 'Health check timed out after install (>120s)' }
    }

    // Step 5: Take a post-upgrade checkpoint so future cold-wake restores don't roll back
    // to a pre-upgrade state. Without this, `startSandbox` could restore an older clean
    // checkpoint on next wake — bringing back the symlink + marker file gone — forcing
    // the bootstrap to re-install on every wake (60s cost). Snapshot now.
    //
    // Failure to take the checkpoint is logged but not fatal — install itself succeeded.
    try {
      console.log(`[sprites] updateOsborn: taking post-upgrade checkpoint (so future wakes preserve the install)`)
      const ck = await createCheckpoint(sandboxId)
      if (!ck) console.warn(`[sprites] updateOsborn: post-upgrade checkpoint failed (install still succeeded)`)
    } catch (err) {
      console.warn(`[sprites] updateOsborn: post-upgrade checkpoint threw: ${(err as Error).message}`)
    }

    console.log(`[sprites] updateOsborn: success — osborn@${targetVersion} healthy on ${sandboxId}`)
    return { success: true, version: targetVersion, log: `Upgraded to osborn@${targetVersion}` }
  } catch (err) {
    const msg = (err as Error).message
    console.error(`[sprites] updateOsborn failed: ${msg}`)
    return { success: false, version: null, log: msg }
  }
}

/**
 * Restart the osborn service on a sprite.
 *
 * The Sprites Services API has no /restart endpoint — restart is implemented
 * as stop-then-start. The stop call may fail if the service is already
 * stopped; that's fine, we proceed to start anyway.
 *
 * Use this instead of asking osborn to restart itself (which fails when osborn is frozen).
 *
 * @param sandboxId - the sprite name (e.g. "osborn-abc123def456")
 */
export async function restartService(sandboxId: string): Promise<boolean> {
  try {
    // Stop first — may 404/4xx if service is already stopped, which is OK
    const stopRes = await fetch(`${SPRITES_API_BASE}/v1/sprites/${sandboxId}/services/osborn/stop`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${getApiToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ timeout: 10 }),
    })
    if (stopRes.body) {
      await consumeNdjsonStream(stopRes, 'restart-service:stop').catch(() => ({}))
    }
    if (!stopRes.ok && stopRes.status !== 404) {
      console.warn(`[sprites] restartService: stop returned ${stopRes.status} (continuing to start)`)
    }

    // Then start fresh
    const startRes = await fetch(`${SPRITES_API_BASE}/v1/sprites/${sandboxId}/services/osborn/start`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${getApiToken()}` },
    })
    if (!startRes.ok) {
      const text = await startRes.text()
      console.error(`[sprites] restartService start failed: ${startRes.status}: ${text.substring(0, 200)}`)
      return false
    }
    if (startRes.body) {
      await consumeNdjsonStream(startRes, 'restart-service:start').catch(() => ({}))
    }
    console.log(`[sprites] Service osborn restarted on ${sandboxId} (stop+start)`)
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

/**
 * List entries in a sprite directory via the fs API.
 * Returns null on error (network, auth) and empty array on 404 / not-a-dir.
 *
 * The fs API reads the **persistent disk** layer of the sprite — which is
 * physically distinct from the container's view of the same path. See
 * `checkSessionLayerConsistency` for why this matters.
 */
async function listSpriteDir(
  spriteName: string,
  dirPath: string,
): Promise<Array<{ name: string; type: 'file' | 'directory'; size?: number }> | null> {
  try {
    const res = await fetch(
      `${SPRITES_API_BASE}/v1/sprites/${spriteName}/fs/list?path=${encodeURIComponent(dirPath)}`,
      {
        headers: { 'Authorization': `Bearer ${getApiToken()}` },
        signal: AbortSignal.timeout(10000),
      },
    )
    if (!res.ok) {
      if (res.status === 404) return []
      return null
    }
    const data = (await res.json()) as { entries?: Array<{ name: string; type: 'file' | 'directory'; size?: number }> }
    return data.entries ?? []
  } catch {
    return null
  }
}

/**
 * Compare the sprite's persistent-disk session count (visible to the fs API)
 * against the container-visible session count (what osborn's /sessions
 * endpoint reports).
 *
 * BACKGROUND: Sprites uses CRIU + an overlay-style filesystem under /home/.
 * Two layers expose the SAME path string:
 *
 *   1. **Persistent disk** — read by the Sprites fs API (`/fs/list`, `/fs/read`).
 *      Holds whatever has been flushed to durable storage. Survives across
 *      checkpoint restores in theory.
 *   2. **Container view** — read by `readdirSync` from inside osborn. This is
 *      the CRIU snapshot's base + the current process's overlay writes.
 *      Reverts to the snapshot whenever a CRIU restore fires.
 *
 * The two can desync after rapid `STOP+DELETE+PUT` cycles or stale-checkpoint
 * restores — the persistent disk ends up with strictly MORE data than the
 * container can see (e.g. 4MB+ historical JSONLs that osborn's /sessions
 * endpoint omits because they aren't in its view of the directory).
 *
 * This check counts JSONLs >= 100KB (filters out trivially-short error sessions)
 * via fs API and returns enough metadata for the dashboard to surface a banner.
 * It does NOT trigger a restore — the user owns that decision because restore
 * is destructive to whatever's currently in the container.
 *
 * @param spriteName  — the sprite name (e.g. "osborn-1b9d70e5-2a4")
 * @param containerSessionCount — count from osborn's /sessions endpoint
 * @returns null if fs API unreachable; otherwise consistency report
 */
export interface SessionLayerConsistency {
  /** JSONLs >= 100KB seen on persistent disk via fs API */
  persistentSessionCount: number
  /** All JSONLs (any size) seen on persistent disk */
  persistentTotalJsonl: number
  /** Total bytes of JSONLs across all projects on persistent disk */
  persistentBytes: number
  /** From osborn's /sessions endpoint — what the running container sees */
  containerSessionCount: number
  /**
   * True if persistent disk has notably more sessions than the container.
   * Threshold is `persistentSessionCount > containerSessionCount + 1`
   * (the +1 absorbs the current session, which is in container-only until flushed).
   */
  mismatch: boolean
  /** Per-project breakdown for debugging */
  projects: Array<{ slug: string; jsonlCount: number; bigJsonlCount: number; totalBytes: number }>
}

export async function checkSessionLayerConsistency(
  spriteName: string,
  containerSessionCount: number,
): Promise<SessionLayerConsistency | null> {
  const projectsDir = '/home/sprite/.claude/projects'
  const projectEntries = await listSpriteDir(spriteName, projectsDir)
  if (projectEntries === null) return null // fs API unreachable

  let persistentSessionCount = 0
  let persistentTotalJsonl = 0
  let persistentBytes = 0
  const projects: SessionLayerConsistency['projects'] = []

  for (const entry of projectEntries) {
    if (entry.type !== 'directory') continue
    const slug = entry.name
    const projDirEntries = await listSpriteDir(spriteName, `${projectsDir}/${slug}`)
    if (!projDirEntries) continue

    let jsonlCount = 0
    let bigJsonlCount = 0
    let totalBytes = 0
    for (const f of projDirEntries) {
      if (f.type !== 'file' || !f.name.endsWith('.jsonl')) continue
      jsonlCount++
      const size = f.size ?? 0
      totalBytes += size
      if (size >= 100 * 1024) bigJsonlCount++
    }

    persistentTotalJsonl += jsonlCount
    persistentSessionCount += bigJsonlCount
    persistentBytes += totalBytes
    if (jsonlCount > 0) {
      projects.push({ slug, jsonlCount, bigJsonlCount, totalBytes })
    }
  }

  // The container is currently writing one session that hasn't flushed to
  // persistent disk yet — that asymmetry is normal. We only flag a mismatch
  // when persistent disk is meaningfully ahead of the container.
  const mismatch = persistentSessionCount > containerSessionCount + 1

  return {
    persistentSessionCount,
    persistentTotalJsonl,
    persistentBytes,
    containerSessionCount,
    mismatch,
    projects,
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
