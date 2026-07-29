import { NextResponse } from 'next/server'
import { createSupabaseServer } from '@/lib/supabase-server'
// Provider switched via CLOUD_PROVIDER env var: 'sprites' (default) or 'machines'.
// See lib/cloud.ts — thin wrapper that re-exports from the active backend.
// To flip backends in Railway: set CLOUD_PROVIDER=machines, redeploy. No code change.
import {
  isSpritesConfigured,
  createSandbox,
  findUserSandbox,
  startSandbox,
  stopSandbox,
  keepAliveSandbox,
  deleteSandbox,
  assignFromPoolOrCreate,
  restartService,
  updateOsborn,
  checkOsbornHealth,
  waitForHealth,
  execInSprite,
  resolveOsbornLatest,
  readInstalledOsbornVersion,
  checkSessionLayerConsistency,
  getLastUpdateResult,
} from '@/lib/cloud'

/**
 * GET /api/sandbox — get current user's sandbox status
 *
 * Returns:
 *   { available: false } — Daytona not configured, local-only mode
 *   { available: true, sandbox: null } — no sandbox yet, can provision
 *   { available: true, sandbox: { id, status, previewUrl, ... } } — has sandbox
 */
export async function GET() {
  if (!isSpritesConfigured()) {
    return NextResponse.json({ available: false })
  }

  const supabase = await createSupabaseServer()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  // Check DB first (faster than Daytona API)
  const { data: instance } = await supabase
    .from('instances')
    .select('sandbox_id, sandbox_url, sandbox_status')
    .eq('user_id', user.id)
    .single()

  // Source of truth for the user's current sprite name is Supabase
  // (instance.sandbox_id), since each createSandbox now generates a unique
  // timestamped name (see generateUniqueSpriteName). Fall back to deterministic
  // name only when Supabase has no record (legacy users / first-time provision lookup).
  const sandbox = await findUserSandbox(user.id, instance?.sandbox_id ?? undefined)

  if (sandbox) {
    // Sync DB if it differs (handles label-found-but-DB-stale case)
    if (instance?.sandbox_id !== sandbox.id) {
      await supabase.from('instances').upsert({
        user_id: user.id,
        server_url: sandbox.previewUrl || 'http://localhost:8741',
        instance_type: 'cloud',
        status: sandbox.status,
        sandbox_id: sandbox.id,
        sandbox_url: sandbox.previewUrl,
        sandbox_status: sandbox.status,
        livekit_room: `osborn-${user.id.substring(0, 8)}`,
        last_seen: new Date().toISOString(),
      }, { onConflict: 'user_id' })
    }
    return NextResponse.json({ available: true, sandbox })
  }

  // No sandbox in Daytona — clear stale DB record if any
  if (instance?.sandbox_id) {
    console.log(`🧹 Clearing stale sandbox reference for user ${user.id}`)
    await supabase.from('instances').update({
      sandbox_id: null,
      sandbox_url: null,
      sandbox_status: 'none',
      server_url: 'http://localhost:8741',
      instance_type: 'local',
    }).eq('user_id', user.id)
  }

  return NextResponse.json({ available: true, sandbox: null })
}

/**
 * POST /api/sandbox — create, start, stop, or keepalive a sandbox
 *
 * Body: { action: 'create' | 'start' | 'stop' | 'keepalive', sandboxId?: string }
 */
export async function POST(request: Request) {
  if (!isSpritesConfigured()) {
    return NextResponse.json({ error: 'Daytona not configured' }, { status: 503 })
  }

  const supabase = await createSupabaseServer()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const body = await request.json()
  const { action, sandboxId } = body

  // Helper: get the user's current sandbox_id from Supabase. Source of truth
  // since `generateUniqueSpriteName` makes each new sprite get a fresh
  // timestamped name. findUserSandbox falls back to deterministic name when
  // this returns null (legacy users provisioned before the naming change).
  const getKnownSandboxId = async (): Promise<string | undefined> => {
    const { data } = await supabase
      .from('instances')
      .select('sandbox_id')
      .eq('user_id', user.id)
      .single()
    return data?.sandbox_id ?? undefined
  }

  // Helper: read the user's sync_token for forwarding to sprites as OSBORN_SYNC_TOKEN.
  // If no token exists yet, generate one, persist it, and return the new value.
  const getSyncToken = async (): Promise<string | undefined> => {
    const { data } = await supabase
      .from('instances')
      .select('sync_token')
      .eq('user_id', user.id)
      .single()

    if (data?.sync_token) return data.sync_token as string

    // Generate a new token and persist it for this user
    const newToken = crypto.randomUUID() + '-' + crypto.randomUUID()
    await supabase
      .from('instances')
      .update({ sync_token: newToken })
      .eq('user_id', user.id)

    return newToken
  }

  switch (action) {
    case 'create': {
      const syncToken = await getSyncToken()
      // Provider-dispatched call: sprites' createSandbox expects (userId, syncToken: string),
      // machines' expects (userId, options: { sourceSnapshotId?, autostopMode? }).
      // Pre-existing signature mismatch — see cloud.ts re-export. We pass the right shape
      // per provider so neither backend ignores the arg.
      //
      // For machines: when FLY_GOLDEN_SNAPSHOT_ID is set on Railway env, provision the
      // user's volume from that snapshot → first boot drops from ~60-90s to ~15-20s.
      // When unset, the volume is created empty (existing behavior).
      const provider = process.env.CLOUD_PROVIDER === 'machines' ? 'machines' : 'sprites'
      const info = provider === 'machines'
        ? await (createSandbox as unknown as (userId: string, opts: { sourceSnapshotId?: string }) => ReturnType<typeof createSandbox>)(
            user.id,
            { sourceSnapshotId: process.env.FLY_GOLDEN_SNAPSHOT_ID || undefined },
          )
        : await createSandbox(user.id, syncToken)

      if (info.status === 'running' && info.previewUrl) {
        // Save to DB — this becomes the user's agent URL
        await supabase.from('instances').upsert({
          user_id: user.id,
          server_url: info.previewUrl,
          instance_type: 'cloud',
          status: 'running',
          sandbox_id: info.id,
          sandbox_url: info.previewUrl,
          sandbox_status: 'running',
          livekit_room: `osborn-${user.id.substring(0, 8)}`,
          last_seen: new Date().toISOString(),
        }, { onConflict: 'user_id' })
      }

      return NextResponse.json(info, {
        status: info.status === 'error' ? 500 : 200,
      })
    }

    case 'start': {
      if (!sandboxId) {
        return NextResponse.json({ error: 'sandboxId required' }, { status: 400 })
      }
      const startSyncToken = await getSyncToken()
      const info = await startSandbox(sandboxId, user.id, startSyncToken)
      if (info?.previewUrl) {
        await supabase.from('instances').update({
          server_url: info.previewUrl,
          sandbox_url: info.previewUrl,
          sandbox_status: 'running',
          status: 'running',
          last_seen: new Date().toISOString(),
        }).eq('user_id', user.id)
      }
      return NextResponse.json(info || { error: 'Failed to start' }, {
        status: info ? 200 : 500,
      })
    }

    case 'stop': {
      if (!sandboxId) {
        return NextResponse.json({ error: 'sandboxId required' }, { status: 400 })
      }
      const ok = await stopSandbox(sandboxId)
      if (ok) {
        await supabase.from('instances').update({
          sandbox_status: 'stopped',
          status: 'stopped',
        }).eq('user_id', user.id)
      }
      return NextResponse.json({ success: ok })
    }

    case 'keepalive': {
      if (!sandboxId) {
        return NextResponse.json({ error: 'sandboxId required' }, { status: 400 })
      }
      const ok = await keepAliveSandbox(sandboxId)
      return NextResponse.json({ success: ok })
    }

    case 'delete': {
      if (!sandboxId) {
        return NextResponse.json({ error: 'sandboxId required' }, { status: 400 })
      }
      // Delete the sprite, then clear DB record
      await deleteSandbox(sandboxId).catch(() => {})
      await supabase.from('instances').update({
        sandbox_id: null,
        sandbox_url: null,
        sandbox_status: 'none',
        server_url: 'http://localhost:8741',
        instance_type: 'local',
      }).eq('user_id', user.id)
      return NextResponse.json({ success: true })
    }

    case 'room-code': {
      // Get the sandbox for this user
      const sb = await findUserSandbox(user.id, await getKnownSandboxId())
      if (!sb?.previewUrl) {
        return NextResponse.json({ error: 'No sandbox found' }, { status: 404 })
      }

      // If sandbox isn't running (warm/cold/stopped/error), start it first
      if (sb.status !== 'running') {
        console.log(`[sandbox] room-code: sandbox is ${sb.status}, starting...`)
        const roomCodeSyncToken = await getSyncToken()
        const woken = await startSandbox(sb.id, user.id, roomCodeSyncToken)
        if (!woken || woken.status !== 'running') {
          return NextResponse.json({ error: 'Failed to wake sandbox' }, { status: 503 })
        }
      }

      // Health check: if osborn isn't responding, restart the service via Sprites API
      // (asking osborn to restart itself fails when it is frozen)
      const previewUrl = sb.previewUrl
      const healthy = await checkOsbornHealth(previewUrl)
      if (!healthy) {
        console.log(`[sandbox] room-code: osborn health check failed, restarting service...`)
        await restartService(sb.id)
        await waitForHealth(previewUrl, 15)
      }

      // Fetch room-code from the sprite (server-side — no CORS issues)
      // Retry up to 5 times in case the sprite just woke and needs a moment
      let roomCode: string | null = null
      for (let i = 0; i < 5; i++) {
        try {
          const r = await fetch(`${sb.previewUrl}/room-code`, {
            signal: AbortSignal.timeout(5000),
          })
          if (r.ok) {
            const d = await r.json() as { roomCode?: string }
            roomCode = d.roomCode ?? null
            break
          }
        } catch {
          // sprite not ready yet
        }
        await new Promise(res => setTimeout(res, 2000))
      }

      if (!roomCode) {
        return NextResponse.json({ error: 'Agent not ready' }, { status: 503 })
      }

      return NextResponse.json({ roomCode, agentUrl: sb.previewUrl })
    }

    case 'connect-room': {
      // Tell the agent to (re)join its LiveKit room for an incoming user. The
      // agent leaves the room whenever no user is present (idle/alone timer or
      // explicit leave); this brings it back. Idempotent on the agent side
      // (no-op if already connected). Server-side fetch — no CORS.
      const sbCR = await findUserSandbox(user.id, await getKnownSandboxId())
      if (!sbCR?.previewUrl) {
        return NextResponse.json({ error: 'No sandbox found' }, { status: 404 })
      }
      try {
        const r = await fetch(`${sbCR.previewUrl}/connect-room`, {
          method: 'POST',
          signal: AbortSignal.timeout(6000),
        })
        // Forward the roomName the agent returns (0.9.83+ temporary rooms) so
        // the client mints its token for the room the agent actually joined.
        const body = r.ok ? await r.json().catch(() => ({})) : {}
        return NextResponse.json({ success: r.ok, roomName: (body as any)?.roomName ?? null })
      } catch {
        return NextResponse.json({ success: false })
      }
    }

    case 'leave-room': {
      // Tell the agent to leave its LiveKit room immediately (user clicked
      // leave / went idle). Stops connection-minute burn without stopping the
      // machine. No-op if the sandbox isn't running (already in no room).
      // Server-side fetch — no CORS.
      const sbLR = await findUserSandbox(user.id, await getKnownSandboxId())
      if (!sbLR?.previewUrl || sbLR.status !== 'running') {
        return NextResponse.json({ success: true })
      }
      try {
        const r = await fetch(`${sbLR.previewUrl}/leave-room`, {
          method: 'POST',
          signal: AbortSignal.timeout(5000),
        })
        return NextResponse.json({ success: r.ok })
      } catch {
        return NextResponse.json({ success: false })
      }
    }

    case 'persist-auth': {
      // Persist an OAuth token to the sprite's host-persistent filesystem.
      // Credentials written inside the service container's ephemeral overlay
      // are lost on every service restart (warm→running re-registration). By
      // writing to the host layer via the Sprites /fs/write API, the token
      // survives across container lifecycle events and is picked up by
      // ensureClaudeAuth()'s Check 0 (.oauth-token) and Check 2 (.credentials.json).
      const token = body.token as string | undefined
      if (!token || !token.startsWith('sk-ant-')) {
        return NextResponse.json({ error: 'Invalid token' }, { status: 400 })
      }

      const sb = await findUserSandbox(user.id, await getKnownSandboxId())
      if (!sb) {
        return NextResponse.json({ error: 'No sandbox found' }, { status: 404 })
      }

      const SPRITES_TOKEN = process.env.SPRITES_API_TOKEN
      if (!SPRITES_TOKEN) {
        return NextResponse.json({ error: 'Sprites API not configured' }, { status: 500 })
      }

      const hdr = { Authorization: `Bearer ${SPRITES_TOKEN}`, 'Content-Type': 'application/octet-stream' }

      // Write both files that ensureClaudeAuth() checks:
      // 1. .oauth-token — simple plaintext, checked first (Check 0)
      // 2. .credentials.json — JSON with claudeAiOauth.accessToken (Check 2)
      try {
        const tokenPath = '/home/sprite/.claude/.oauth-token'
        const credsPath = '/home/sprite/.claude/.credentials.json'
        const credsJson = JSON.stringify({ claudeAiOauth: { accessToken: token } })

        await Promise.all([
          fetch(`https://api.sprites.dev/v1/sprites/${sb.id}/fs/write?path=${encodeURIComponent(tokenPath)}`, {
            method: 'PUT', headers: hdr, body: token,
          }),
          fetch(`https://api.sprites.dev/v1/sprites/${sb.id}/fs/write?path=${encodeURIComponent(credsPath)}`, {
            method: 'PUT', headers: hdr, body: credsJson,
          }),
        ])

        console.log(`[sandbox] persist-auth: wrote OAuth token to sprite ${sb.id} host layer`)
        return NextResponse.json({ success: true })
      } catch (err) {
        console.error('[sandbox] persist-auth failed:', err)
        return NextResponse.json({ error: 'Failed to persist token' }, { status: 500 })
      }
    }

    case 'restart-service': {
      if (!sandboxId) {
        return NextResponse.json({ error: 'sandboxId required' }, { status: 400 })
      }
      // Get sandbox from Supabase to confirm ownership
      const { data: instance } = await supabase
        .from('instances')
        .select('sandbox_id, sandbox_url')
        .eq('user_id', user.id)
        .single()
      if (!instance?.sandbox_id || instance.sandbox_id !== sandboxId) {
        return NextResponse.json({ error: 'Sandbox not found' }, { status: 404 })
      }
      const restartOk = await restartService(sandboxId)
      if (!restartOk) {
        return NextResponse.json({ error: 'Failed to restart service' }, { status: 503 })
      }
      const rsPreviewUrl = instance.sandbox_url as string
      const rsHealthy = await waitForHealth(rsPreviewUrl, 30) // 30 × 2s = 60s
      return NextResponse.json({ success: rsHealthy })
    }

    case 'update-osborn': {
      if (!sandboxId) {
        return NextResponse.json({ error: 'sandboxId required' }, { status: 400 })
      }
      // Confirm ownership via Supabase (same pattern as restart-service)
      const { data: updateInstance } = await supabase
        .from('instances')
        .select('sandbox_id, sandbox_url')
        .eq('user_id', user.id)
        .single()
      if (!updateInstance?.sandbox_id || updateInstance.sandbox_id !== sandboxId) {
        return NextResponse.json({ error: 'Sandbox not found' }, { status: 404 })
      }
      // updateOsborn now handles the full upgrade flow internally:
      //   resolve target version → stop → DELETE registration → PUT new bootstrap
      //   (auto-starts) → wait for /health
      // Returns the actual installed version so the dashboard can display it.
      const updateSyncToken = await getSyncToken()
      const updateResult = await updateOsborn(sandboxId, user.id, undefined, updateSyncToken)
      if (!updateResult.success) {
        return NextResponse.json(
          { error: 'Update failed', log: updateResult.log },
          { status: 500 },
        )
      }
      return NextResponse.json({ success: true, version: updateResult.version })
    }

    case 'fetch-log': {
      // Confirm the user has a sandbox (ownership check)
      const { data: fetchLogInstance } = await supabase
        .from('instances')
        .select('sandbox_id')
        .eq('user_id', user.id)
        .single()
      if (!fetchLogInstance?.sandbox_id) {
        return NextResponse.json({ error: 'No sandbox found' }, { status: 404 })
      }
      // Use sandboxId from body if provided, otherwise fall back to the DB record
      const targetId = (sandboxId as string | undefined) || fetchLogInstance.sandbox_id
      if (targetId !== fetchLogInstance.sandbox_id) {
        return NextResponse.json({ error: 'Sandbox not found' }, { status: 404 })
      }
      const logResult = await execInSprite(
        targetId,
        'sh',
        ['-c', 'tail -500 /tmp/osborn-sprite.log 2>/dev/null || echo "Log not available"'],
        15,
      )
      return NextResponse.json({ log: logResult.output })
    }

    case 'save-log': {
      const { spriteName, logContent, sessionId } = body as {
        spriteName: string
        logContent: string
        sessionId?: string
      }
      if (!spriteName || typeof logContent !== 'string') {
        return NextResponse.json({ error: 'spriteName and logContent required' }, { status: 400 })
      }
      // Verify ownership: the spriteName must match this user's sandbox
      const { data: saveLogInstance } = await supabase
        .from('instances')
        .select('sandbox_id')
        .eq('user_id', user.id)
        .single()
      if (!saveLogInstance?.sandbox_id || saveLogInstance.sandbox_id !== spriteName) {
        return NextResponse.json({ error: 'Sandbox not found' }, { status: 404 })
      }
      const timestamp = new Date().toISOString().replace(/:/g, '-')
      const sessionSuffix = sessionId ? `_${sessionId}` : ''
      const storagePath = `logs/${spriteName}/${timestamp}${sessionSuffix}.log`
      const { error: uploadError } = await supabase.storage
        .from('osborn-storage')
        .upload(storagePath, logContent, {
          contentType: 'text/plain',
          upsert: false,
        })
      if (uploadError) {
        console.error('[sandbox] save-log: upload failed', uploadError)
        return NextResponse.json({ error: 'Failed to upload log' }, { status: 500 })
      }
      return NextResponse.json({ path: storagePath })
    }

    case 'submit-bug-report': {
      // Receives a bug report or feature request originally filed by the
      // bug-reporter skill on the workspace agent and forwarded here through
      // the LiveKit data channel. We do the actual Supabase work (the agent
      // never holds Supabase credentials): upload a log tail to Storage and
      // INSERT a row into bug_reports.
      const { reportId, payload, context, sessionId: bugSessionId } = body as {
        reportId?: string
        payload?: {
          type: 'bug' | 'feature'
          severity: 'low' | 'medium' | 'high' | 'critical'
          title: string
          description: string
          reproduction_notes?: string
          tags?: string[]
        }
        context?: {
          voice_mode?: string
          sandbox_id?: string
          osborn_version?: string
        }
        sessionId?: string | null
      }
      if (!reportId || !payload?.type || !payload?.title || !payload?.description) {
        return NextResponse.json(
          { error: 'reportId, payload.type, payload.title, payload.description required' },
          { status: 400 },
        )
      }

      // Find the user's sandbox so we can pull the log tail from the right machine
      const { data: bugInstance } = await supabase
        .from('instances')
        .select('sandbox_id')
        .eq('user_id', user.id)
        .single()
      const targetSandboxId = bugInstance?.sandbox_id || context?.sandbox_id || null

      // Pull log tail (best-effort — bug report still files if exec fails)
      let logUrl: string | null = null
      if (targetSandboxId) {
        try {
          const logResult = await execInSprite(
            targetSandboxId,
            'sh',
            ['-c', 'tail -500 /workspace/osborn.log 2>/dev/null || echo "log unavailable"'],
            15,
          )
          if (logResult.output && logResult.output.length > 0) {
            const storagePath = `bug-logs/${reportId}.log`
            const { error: upErr } = await supabase.storage
              .from('osborn-storage')
              .upload(storagePath, logResult.output, {
                contentType: 'text/plain',
                upsert: false,
              })
            if (!upErr) {
              logUrl = storagePath
            } else {
              console.error('[bug-report] log upload failed', upErr)
            }
          }
        } catch (e) {
          console.error('[bug-report] exec to fetch log failed:', e)
        }
      }

      // Insert the row
      const { data: inserted, error: insertErr } = await supabase
        .from('bug_reports')
        .insert({
          id: reportId,
          type: payload.type,
          severity: payload.severity || 'medium',
          status: 'open',
          reporter_user_id: user.id,
          reporter_email: user.email ?? null,
          title: payload.title,
          description: payload.description,
          reproduction_notes: payload.reproduction_notes ?? null,
          osborn_version: context?.osborn_version ?? 'unknown',
          voice_mode: context?.voice_mode ?? null,
          session_id: bugSessionId ?? null,
          sandbox_id: targetSandboxId,
          log_url: logUrl,
          tags: Array.isArray(payload.tags) ? payload.tags : [],
          metadata: {},
        })
        .select('id, type, severity, title, created_at')
        .single()

      if (insertErr) {
        console.error('[bug-report] insert failed', insertErr)
        return NextResponse.json(
          { error: 'Failed to write report', details: insertErr.message },
          { status: 500 },
        )
      }
      console.log(`[bug-report] filed ${inserted?.id.slice(0, 8)} (${inserted?.type}/${inserted?.severity}): ${inserted?.title}`)
      return NextResponse.json({ success: true, report: inserted, logUrl })
    }

    case 'check-version': {
      // Find sandbox for this user
      const cvSandbox = await findUserSandbox(user.id, await getKnownSandboxId())
      if (!cvSandbox) {
        return NextResponse.json({ error: 'No sandbox found' }, { status: 404 })
      }

      // Both version checks bypass the Sprites exec API entirely. The exec
      // endpoint silently no-ops on warm sprites (returns exit=0 with no output)
      // which made the previous npm-based checks always return null. Instead:
      //   - latest: HTTP fetch from npm registry (no sprite involvement)
      //   - installed: read the marker file written by buildOsbornBootstrap
      //     after each successful install, with fallback to reading the actual
      //     installed package.json. Both via the Sprites fs API which works.
      const [latestResult, installedResult] = await Promise.allSettled([
        resolveOsbornLatest(),
        readInstalledOsbornVersion(cvSandbox.id),
      ])

      const latest = latestResult.status === 'fulfilled' ? latestResult.value : null
      const installed = installedResult.status === 'fulfilled' ? installedResult.value : null

      const updateAvailable = !!(latest && installed && latest !== installed)

      return NextResponse.json({ installed, latest, updateAvailable })
    }

    case 'verify-update': {
      // Multi-signal verification used by the dashboard when the long-held
      // `update-osborn` POST drops (mobile Safari fetch timeout, network
      // blip, user navigates away). Combines three independent truths:
      //
      //   1. Machine state from Fly (`started`?) — proves the runtime is up
      //   2. /health + readInstalledOsbornVersion — proves it's on the
      //      target version AND responding
      //   3. Server-side getLastUpdateResult — the exact final outcome of
      //      the most recent updateOsborn call on this Node process, even
      //      if its HTTP response never reached the browser
      //
      // Signal #3 is authoritative when present: it includes the specific
      // error message that updateOsborn would have returned. When the
      // frontend pod restarts mid-update or the result expires, #3 is null
      // and the dashboard falls back to interpreting #1 + #2 itself.
      const { data: vuInstance } = await supabase
        .from('instances')
        .select('sandbox_id')
        .eq('user_id', user.id)
        .single()
      if (!vuInstance?.sandbox_id || vuInstance.sandbox_id !== sandboxId) {
        return NextResponse.json({ error: 'Sandbox not found' }, { status: 404 })
      }

      const vuSandbox = await findUserSandbox(user.id, sandboxId)
      // Run version + last-result probes in parallel — they're independent
      // and we want the freshest snapshot of all three signals at the same
      // wall-clock instant.
      const [installedResult] = await Promise.allSettled([
        readInstalledOsbornVersion(sandboxId),
      ])
      const installed = installedResult.status === 'fulfilled' ? installedResult.value : null
      const lastResult = getLastUpdateResult(sandboxId)

      return NextResponse.json({
        machineState: vuSandbox?.status ?? null,       // signal #1
        installedVersion: installed,                    // signal #2 (a)
        healthOk: installed !== null,                   // signal #2 (b) — /health responded
        lastUpdate: lastResult,                         // signal #4 — null when unavailable
      })
    }

    case 'consistency-check': {
      // Detect divergence between the sprite's persistent-disk layer (fs API)
      // and the container view (osborn's /sessions endpoint).
      //
      // Why this matters: Sprites' CRIU + overlay-fs setup can leave older
      // session JSONLs invisible to the running container even though they
      // still exist on persistent disk. Surfacing the mismatch lets the user
      // recover (via a checkpoint restore) before assuming data is lost.
      //
      // This is read-only — no restore is triggered. The dashboard shows a
      // banner; the user explicitly chooses recovery.
      const ccSandbox = await findUserSandbox(user.id, await getKnownSandboxId())
      if (!ccSandbox) {
        return NextResponse.json({ error: 'No sandbox found' }, { status: 404 })
      }

      // Fetch container-visible session count from osborn /sessions. If the
      // sprite is warm/cold or osborn is down, we still proceed with 0 — the
      // persistent count is what tells us whether divergence happened.
      let containerSessionCount = 0
      const previewUrl = ccSandbox.previewUrl
      if (previewUrl) {
        try {
          const r = await fetch(`${previewUrl}/sessions?limit=200`, {
            signal: AbortSignal.timeout(5000),
          })
          if (r.ok) {
            const data = (await r.json()) as { sessions?: Array<unknown>; total?: number }
            containerSessionCount = data.total ?? data.sessions?.length ?? 0
          }
        } catch {
          // /sessions unreachable — leave containerSessionCount at 0 and let
          // the persistent-side numbers tell the story.
        }
      }

      const report = await checkSessionLayerConsistency(ccSandbox.id, containerSessionCount)
      if (!report) {
        return NextResponse.json({ error: 'fs API unreachable' }, { status: 502 })
      }

      return NextResponse.json(report)
    }

    default:
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  }
}

/**
 * DELETE /api/sandbox — delete user's sandbox and reset to local
 */
export async function DELETE() {
  if (!isSpritesConfigured()) {
    return NextResponse.json({ error: 'Daytona not configured' }, { status: 503 })
  }

  const supabase = await createSupabaseServer()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  // Get sandbox ID from DB
  const { data: instance } = await supabase
    .from('instances')
    .select('sandbox_id')
    .eq('user_id', user.id)
    .single()

  if (instance?.sandbox_id) {
    await deleteSandbox(instance.sandbox_id).catch(() => {})
  }

  // Clear sandbox fields in DB
  await supabase.from('instances').update({
    sandbox_id: null,
    sandbox_url: null,
    sandbox_status: 'none',
    server_url: 'http://localhost:8741',
    instance_type: 'local',
  }).eq('user_id', user.id)

  return NextResponse.json({ success: true })
}
