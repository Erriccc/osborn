/**
 * daytona.ts — Daytona sandbox provisioning (server-side only)
 *
 * Manages per-user Osborn agent sandboxes via Daytona API.
 * Uses raw HTTP calls — the @daytonaio/sdk has compatibility issues with self-hosted.
 *
 * Requires: DAYTONA_API_KEY, DAYTONA_API_URL in frontend .env.local
 * Optional: DAYTONA_REGION (defaults to 'us' for self-hosted)
 *
 * Auth: Each user authenticates Claude Code via OAuth flow (claude-auth.ts).
 * Token persists in sandbox filesystem across stop/resume cycles.
 */

// ─────────────────────────────────────────
// Types
// ─────────────────────────────────────────

export interface SandboxInfo {
  id: string
  status: 'creating' | 'running' | 'stopped' | 'archived' | 'error'
  previewUrl?: string
  userId: string
  createdAt: string
  error?: string
}

interface DaytonaSandbox {
  id: string
  state: string
  labels?: Record<string, string>
  createdAt: string
  toolboxProxyUrl?: string
}

// ─────────────────────────────────────────
// Config
// ─────────────────────────────────────────

function getApiConfig() {
  const apiUrl = process.env.DAYTONA_API_URL || 'https://app.daytona.io'
  const apiKey = process.env.DAYTONA_API_KEY
  const region = process.env.DAYTONA_REGION || 'us'
  return { apiUrl, apiKey, region }
}

export function isDaytonaConfigured(): boolean {
  return !!process.env.DAYTONA_API_KEY
}

/** Build the public preview URL for a sandbox port */
function buildPreviewUrl(sandboxId: string, port: number): string {
  // DAYTONA_PROXY_DOMAIN takes precedence (e.g., daytona.voice-native.com → https)
  const proxyDomain = process.env.DAYTONA_PROXY_DOMAIN
  if (proxyDomain) {
    const protocol = proxyDomain.includes('localhost') ? 'http' : 'https'
    return `${protocol}://${port}-${sandboxId}.${proxyDomain}`
  }

  // Fallback: extract host from DAYTONA_API_URL and use sslip.io wildcard
  const { apiUrl } = getApiConfig()
  let host = 'localhost'
  try {
    host = new URL(apiUrl).hostname
  } catch {}
  return `http://${port}-${sandboxId}.${host}.sslip.io:4000`
}

/** Collect platform infrastructure env vars to inject into sandboxes */
function getPlatformEnvVars(): Record<string, string> {
  const envVars: Record<string, string> = {
    // Must match the dir we create + cd into when launching osborn (see createSandbox).
    // /root/workspace is unreadable by anyone but root and never gets created,
    // which causes the SDK's child_process.spawn to fail ENOENT on cwd —
    // surfaced as the misleading "Claude Code executable not found" error.
    OSBORN_CWD: '/home/daytona/workspace',
    NODE_ENV: 'production',
    HOST: '0.0.0.0',
  }
  // Platform infrastructure keys (NOT user auth)
  // Each user authenticates Claude separately via OAuth flow
  const forwardKeys = [
    'OPENAI_API_KEY', 'GOOGLE_API_KEY',
    'LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET',
    'DEEPGRAM_API_KEY',  // STT for pipeline mode — required
    'SMITHERY_API_KEY', 'RECALL_API_KEY',
  ]
  for (const key of forwardKeys) {
    if (process.env[key]) envVars[key] = process.env[key]!
  }
  return envVars
}

// ─────────────────────────────────────────
// Raw API helpers
// ─────────────────────────────────────────

async function api<T = any>(
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
  path: string,
  body?: any,
): Promise<T> {
  const { apiUrl, apiKey } = getApiConfig()
  if (!apiKey) throw new Error('DAYTONA_API_KEY not configured')

  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Daytona API ${method} ${path} → ${res.status}: ${text}`)
  }

  if (res.status === 204) return null as T
  return res.json()
}

/** Build the toolbox base URL: HTTPS uses /toolbox path, HTTP uses :4000 port */
function getToolboxBase(): string {
  const { apiUrl } = getApiConfig()
  // HTTPS Caddy setup: same domain, /toolbox path
  if (apiUrl.startsWith('https://')) return `${apiUrl}/toolbox`
  // HTTP IP-based: replace :3000 with :4000 + /toolbox
  return `${apiUrl.replace(/:\d+$/, ':4000')}/toolbox`
}

async function execInSandbox(sandboxId: string, command: string, timeoutSec = 30): Promise<{ exitCode: number; output: string }> {
  const { apiKey } = getApiConfig()
  const res = await fetch(`${getToolboxBase()}/${sandboxId}/process/execute`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ command, timeout: timeoutSec }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Sandbox exec failed: ${res.status}: ${text.substring(0, 200)}`)
  }

  const data = await res.json()
  return { exitCode: data.exitCode || 0, output: data.result || '' }
}

/**
 * Poll the toolbox proxy until it can route to the container.
 *
 * Daytona's metadata API (`GET /api/sandbox/{id}`) flips the `state` field to
 * `started` BEFORE its toolbox reverse-proxy has resolved the container's IP.
 * If you immediately call `process/execute` after seeing `state: started`, the
 * toolbox returns `400 "failed to resolve container IP after 3 attempts: no IP
 * address found. Is the Sandbox started?"` and `execInSandbox()` throws. The
 * race window is typically 2–6 seconds wide on a warm runner.
 *
 * Without this poll, every `startSandbox()` call would run the supervisor exec
 * in that race window and silently fail: Daytona reports `running` but the
 * exec never landed, leaving the container empty on port 8741 and the user
 * facing 502 Bad Gateway when they try to connect. This was the root cause
 * behind dashboard Resume appearing to "work" (state flips to running) while
 * the chat page hangs on /room-code with 502.
 *
 * The helper sends `echo ready` until it succeeds. If the toolbox is already
 * routing, the first attempt returns immediately (~200ms total). If we're
 * mid-race, it waits up to `maxAttempts * 2s` for the proxy to come online.
 */
async function waitForToolboxReady(sandboxId: string, maxAttempts = 15): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const r = await execInSandbox(sandboxId, 'echo ready', 5)
      if (r.exitCode === 0 && r.output.includes('ready')) return true
    } catch {
      // Expected during the race window — execInSandbox throws on the toolbox 400.
      // Any other unexpected error also retries; the loop bounds the total wait.
    }
    await new Promise(r => setTimeout(r, 2000))
  }
  return false
}

// ─────────────────────────────────────────
// Public API
// ─────────────────────────────────────────

/**
 * Create a new sandbox for a user.
 */
export async function createSandbox(userId: string): Promise<SandboxInfo> {
  if (!isDaytonaConfigured()) {
    return {
      id: '', status: 'error', userId,
      createdAt: new Date().toISOString(),
      error: 'Daytona not configured. Set DAYTONA_API_KEY in .env.local',
    }
  }

  console.log(`🏗️ Creating sandbox for user ${userId}...`)

  try {
    const { region } = getApiConfig()
    // Step 1: Create sandbox with env vars (note: field is `env`, not `envVars`)
    const sandbox = await api<DaytonaSandbox>('POST', '/api/sandbox', {
      image: 'node:22',
      env: getPlatformEnvVars(),  // ← persisted, available in shells
      labels: { userId, app: 'osborn' },
      public: true,
      target: region,              // ← `target`, not `region`
      autoStopInterval: 15,
      autoArchiveInterval: 10080,
    })
    console.log(`📦 Sandbox created: ${sandbox.id}, waiting for state=started...`)

    // Step 2: Poll for started state
    let state = sandbox.state
    let attempts = 0
    while (state !== 'started' && attempts < 60) {
      await new Promise(r => setTimeout(r, 2000))
      const updated = await api<DaytonaSandbox>('GET', `/api/sandbox/${sandbox.id}`)
      state = updated.state
      attempts++
    }
    if (state !== 'started') {
      throw new Error(`Sandbox stuck in state=${state} after 120s`)
    }
    console.log(`✅ Sandbox started`)

    // Bridge the toolbox-proxy race: metadata says `started` ~3-6s before the
    // reverse-proxy can route. Without this, the install exec below would fail
    // with `400 failed to resolve container IP`. See `waitForToolboxReady` doc.
    const toolboxReady = await waitForToolboxReady(sandbox.id)
    if (!toolboxReady) {
      throw new Error(`Toolbox proxy never became reachable after sandbox start`)
    }

    // Step 3: Install osborn + claude-code globally
    // Note: sudo strips PATH, so we explicitly preserve it via `sudo env PATH=...`
    // This is needed because nvm's node/npm aren't in root's default PATH
    console.log(`📥 Installing osborn + claude-code (~60s)...`)
    const installResult = await execInSandbox(
      sandbox.id,
      'sudo env PATH=/usr/local/nvm/versions/node/v22.14.0/bin:$PATH npm install -g osborn@latest @anthropic-ai/claude-code 2>&1 | tail -5',
      300,
    )
    if (installResult.exitCode !== 0) {
      throw new Error(`npm install failed: ${installResult.output}`)
    }
    // Verify the binary is actually on disk
    const verify = await execInSandbox(sandbox.id, 'which osborn && which claude', 5)
    if (verify.exitCode !== 0) {
      throw new Error(`osborn/claude not found after install: ${verify.output}`)
    }
    console.log(`✅ Packages installed and verified`)

    // Step 3b: Symlink node + osborn + claude into /usr/local/bin so they're in every user's PATH.
    // Convenience for interactive shells and any subprocess that does PATH-based lookup of `node`,
    // `osborn`, or `claude` without inheriting nvm's bin dir.
    console.log(`🔗 Symlinking node/osborn/claude to /usr/local/bin...`)
    await execInSandbox(
      sandbox.id,
      'sudo ln -sf /usr/local/nvm/versions/node/v22.14.0/bin/node /usr/local/bin/node && ' +
      'sudo ln -sf /usr/local/nvm/versions/node/v22.14.0/bin/osborn /usr/local/bin/osborn && ' +
      'sudo ln -sf /usr/local/nvm/versions/node/v22.14.0/bin/claude /usr/local/bin/claude && ' +
      'sudo -i which node && sudo -i which osborn && sudo -i which claude',
      10,
    )

    // Step 4: Start the agent as a daemon via systemd-style nohup with disowned process,
    // wrapped in a bash supervisor loop so it self-restarts on exit.
    //
    // Why the supervisor loop: osborn has an internal "restart requested via HTTP" path
    // that deliberately calls process.exit(), expecting a process manager (systemd, pm2)
    // to bring it back. Daytona sandboxes have no process manager — a plain `nohup osborn`
    // would die on first restart request and leave the sandbox responding 502 Bad Gateway
    // until manually rescued. The `while true` wrapper is the poor-man's supervisor that
    // catches every exit and restarts osborn after a 2-second cooldown.
    //
    // Why sudo -E: preserves env vars (LIVEKIT_*, OPENAI_*, DEEPGRAM_*) from the sandbox
    // `env` field. OSBORN_CWD is overridden inline to defeat any stale value that old
    // sandboxes may have baked into their persisted env field (existing sandboxes were
    // provisioned with /root/workspace which doesn't exist — see memory/cloud_sandboxes_v8.md).
    // HOME=/home/daytona keeps OAuth token persistence in the same place across user/root.
    //
    // Log is APPENDED (>>) not truncated so supervisor restart history is preserved.
    console.log(`🚀 Starting osborn agent (as root, supervised)...`)
    await execInSandbox(
      sandbox.id,
      `mkdir -p /home/daytona/workspace && cd /home/daytona/workspace && sudo -E setsid nohup bash -c 'while true; do env HOME=/home/daytona OSBORN_CWD=/home/daytona/workspace PATH=/usr/local/nvm/versions/node/v22.14.0/bin:$PATH osborn >>/tmp/osborn.log 2>&1; echo "[supervisor] osborn exited $?, restart in 2s" >> /tmp/osborn.log; sleep 2; done' </dev/null & disown; sleep 1; echo started`,
      15,
    )

    // Wait for agent to bind port 8741 (gives it time to do auth/init)
    let agentReady = false
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000))
      const check = await execInSandbox(sandbox.id, 'curl -s -o /dev/null -w "%{http_code}" http://localhost:8741/health 2>/dev/null || echo 000', 5)
      if (check.output.trim().endsWith('200')) { agentReady = true; break }
    }
    if (!agentReady) {
      // Show logs to help debug
      const logs = await execInSandbox(sandbox.id, 'tail -30 /tmp/osborn.log 2>/dev/null', 5)
      console.warn(`⚠️ Agent didn't bind port 8741 in 60s. Logs:\n${logs.output}`)
    } else {
      console.log(`✅ Agent listening on port 8741`)
    }

    const previewUrl = buildPreviewUrl(sandbox.id, 8741)
    console.log(`🌐 Sandbox URL: ${previewUrl}`)

    return {
      id: sandbox.id,
      status: 'running',
      previewUrl,
      userId,
      createdAt: new Date().toISOString(),
    }
  } catch (err) {
    const msg = (err as Error).message
    console.error('❌ Sandbox creation failed:', msg)
    return {
      id: '', status: 'error', userId,
      createdAt: new Date().toISOString(),
      error: msg,
    }
  }
}

/**
 * Find an existing sandbox for a user by label.
 */
export async function findUserSandbox(userId: string): Promise<SandboxInfo | null> {
  try {
    const data = await api<any>('GET', '/api/sandbox')
    const sandboxes: DaytonaSandbox[] = Array.isArray(data) ? data : (data.items || [])

    const match = sandboxes.find((s) =>
      s.labels?.userId === userId && s.labels?.app === 'osborn',
    )
    if (!match) return null

    const previewUrl = match.state === 'started' ? buildPreviewUrl(match.id, 8741) : undefined

    return {
      id: match.id,
      status: match.state === 'started' ? 'running' : (match.state as any),
      previewUrl,
      userId,
      createdAt: match.createdAt,
    }
  } catch (err) {
    console.error('❌ Failed to find sandbox:', (err as Error).message)
    return null
  }
}

/**
 * Start a stopped sandbox and restart the agent.
 */
export async function startSandbox(sandboxId: string): Promise<SandboxInfo | null> {
  try {
    await api('POST', `/api/sandbox/${sandboxId}/start`)

    // Wait for started state
    let state = 'starting'
    for (let i = 0; i < 30 && state !== 'started'; i++) {
      await new Promise(r => setTimeout(r, 2000))
      const sb = await api<DaytonaSandbox>('GET', `/api/sandbox/${sandboxId}`)
      state = sb.state
    }
    if (state !== 'started') return null

    // Bridge the toolbox-proxy race: metadata says `started` ~3-6s before the
    // reverse-proxy can route. Without this, the supervisor exec below races
    // and throws with `400 failed to resolve container IP`, which startSandbox
    // catches and converts to `return null` → the route returns 500, the
    // dashboard handler silently ignores it (no `data.previewUrl` to set),
    // and the user is left with a "running" sandbox that has nothing on port
    // 8741. This was the actual cause of the symptoms: stop/resume appearing
    // to "work" while connecting to chat 502s. See `waitForToolboxReady` doc.
    const toolboxReady = await waitForToolboxReady(sandboxId)
    if (!toolboxReady) {
      console.error(`❌ Toolbox proxy never became reachable for sandbox ${sandboxId}`)
      return null
    }

    // Restart agent as root, wrapped in a bash supervisor loop (see createSandbox for why).
    // The supervisor loop catches osborn's "Restart requested via HTTP" self-exits and
    // brings it back up automatically — without this, a single restart request leaves the
    // sandbox dead with no process listening on 8741 and nothing to bring it back.
    await execInSandbox(
      sandboxId,
      `mkdir -p /home/daytona/workspace && cd /home/daytona/workspace && sudo -E setsid nohup bash -c 'while true; do env HOME=/home/daytona OSBORN_CWD=/home/daytona/workspace PATH=/usr/local/nvm/versions/node/v22.14.0/bin:$PATH osborn >>/tmp/osborn.log 2>&1; echo "[supervisor] osborn exited $?, restart in 2s" >> /tmp/osborn.log; sleep 2; done' </dev/null & disown; sleep 1; echo started`,
      15,
    )

    // Wait for port
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 2000))
      const check = await execInSandbox(sandboxId, 'curl -s -o /dev/null -w "%{http_code}" http://localhost:8741/health || echo down', 5)
      if (check.output.trim() === '200') break
    }

    const sb = await api<DaytonaSandbox>('GET', `/api/sandbox/${sandboxId}`)
    return {
      id: sb.id,
      status: 'running',
      previewUrl: buildPreviewUrl(sb.id, 8741),
      userId: sb.labels?.userId || '',
      createdAt: sb.createdAt,
    }
  } catch (err) {
    console.error('❌ Failed to start sandbox:', (err as Error).message)
    return null
  }
}

/**
 * Stop a sandbox (preserves filesystem, $0 compute).
 */
export async function stopSandbox(sandboxId: string): Promise<boolean> {
  try {
    await api('POST', `/api/sandbox/${sandboxId}/stop`)
    return true
  } catch (err) {
    console.error('❌ Failed to stop sandbox:', (err as Error).message)
    return false
  }
}

/**
 * Send keepalive to prevent auto-stop while user is connected.
 * Updates the sandbox's "last activity" timestamp.
 */
export async function keepAliveSandbox(sandboxId: string): Promise<boolean> {
  try {
    // Just touching any endpoint resets the activity timer
    await api('GET', `/api/sandbox/${sandboxId}`)
    return true
  } catch {
    return false
  }
}

/**
 * Delete a sandbox permanently.
 */
export async function deleteSandbox(sandboxId: string): Promise<boolean> {
  try {
    await api('DELETE', `/api/sandbox/${sandboxId}`)
    return true
  } catch (err) {
    console.error('❌ Failed to delete sandbox:', (err as Error).message)
    return false
  }
}
