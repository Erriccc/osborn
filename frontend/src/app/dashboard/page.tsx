'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import LiveClock from '@/components/LiveClock'
import { createSupabaseBrowser } from '@/lib/supabase-browser'
import type { User } from '@supabase/supabase-js'
import { useRouter } from 'next/navigation'

interface SessionInfo {
  sessionId: string
  timestamp: string
  lastMessage?: string
  messageCount?: number
  // SLUG-DERIVED cwd → resume routing. Forwarded to the agent as
  // `workingDirectory` so Claude Code's `--resume` finds the JSONL file
  // in the matching slug folder. Always points at the real on-disk
  // location, NOT the cwd the session originally recorded.
  cwd?: string
  // ORIGINAL cwd from the JSONL content → display / grouping. For
  // imported sessions this is the source machine's cwd (e.g. a
  // Codespaces path that doesn't exist on the current host) — the
  // dashboard uses it to organize history by where each session came
  // from, even after migration consolidates everything into one slug.
  projectPath?: string
}

// The dashboard no longer keeps a hardcoded list of base cwds — the agent
// broadcasts its own `baseCwd` (its working directory) in the `/sessions`
// response. We pass it into the grouping helpers so the model is:
//
//   session.cwd === baseCwd            → "Workspace" card  (the base)
//   session.cwd startsWith baseCwd/X   → project card named "X"
//   anything else                       → off-base / legacy, its own card
//
// When `baseCwd` is null (older agent that doesn't advertise it), we fall
// back to behaving like every session is at its own absolute cwd — no
// "Workspace" collapsing, no first-segment magic. The old agent's
// dashboard rendering still works, just less prettily.

interface ProjectGroup {
  name: string        // display name: "Workspace" for the base, or the
                      // first segment beneath the base for sub-projects
  cwd: string         // grouping key — slug-derived absolute path. Used
                      // for forwarding workingDirectory on resume.
  sessions: SessionInfo[]
  lastActive: string  // timestamp of most recent session
}

// Historical workspace cwds that should collapse into the current base
// alongside the live baseCwd. Sprites used `/home/sprite/workspace` as
// their default cwd — sessions started there were the equivalent of fly's
// "Workspace" base, so post-migration they belong in the same card.
// Hardcoded for now; can be removed once those sessions age out, or moved
// to a server-broadcast `legacyBases` field if more hosts join the mix.
const LEGACY_BASE_CWDS = ['/home/sprite/workspace']

function projectKeyFromCwd(projectPath: string, baseCwd: string | null): string {
  const clean = projectPath.replace(/\/+$/, '')

  // Without a known base, every cwd is its own card. Older agent versions
  // that don't broadcast baseCwd land here — no grouping magic.
  if (!baseCwd) return clean
  const cleanBase = baseCwd.replace(/\/+$/, '')

  // Base-equivalent: the live baseCwd, plus historical workspace cwds.
  // All collapse into the single "Workspace" card.
  if (clean === cleanBase) return cleanBase
  if (LEGACY_BASE_CWDS.includes(clean)) return cleanBase

  // Native sub-project under the live base: `${base}/instagram/api` and
  // `${base}/instagram` both key to `${base}/instagram` → "instagram" card.
  if (clean.startsWith(cleanBase + '/')) {
    const rest = clean.slice(cleanBase.length + 1)
    const firstSegment = rest.split('/')[0]
    return `${cleanBase}/${firstSegment}`
  }

  // Off-base. This is the imported-from-elsewhere case: a session whose
  // original cwd was a Codespace, a Mac local dir, etc. We treat each
  // distinct off-base cwd as its own project card, named after the
  // path's leaf segment.
  //
  // For deeper paths like `/Users/foo/Desktop/Developer/osborn`, the leaf
  // ("osborn") is the user-facing project name. For `/workspaces/codespaces-blank`
  // the leaf is "codespaces-blank". This matches how imported sessions
  // were ORGANIZED on their source host, not where they physically live
  // on this host after migration.
  return clean
}

function groupByProject(sessions: SessionInfo[], baseCwd: string | null): ProjectGroup[] {
  const map = new Map<string, SessionInfo[]>()
  for (const s of sessions) {
    // Display key = projectPath (original cwd from JSONL). Falls back to
    // cwd (slug-derived) when projectPath is missing — the dashboard
    // still groups correctly, just under the slug-derived path.
    const display = s.projectPath || s.cwd || baseCwd || '/workspace'
    const key = projectKeyFromCwd(display, baseCwd)
    map.set(key, [...(map.get(key) || []), s])
  }
  const cleanBase = baseCwd?.replace(/\/+$/, '') ?? null
  return Array.from(map.entries())
    .map(([cwd, sessions]) => {
      const isBase = cleanBase !== null && cwd === cleanBase
      const segments = cwd.replace(/\/$/, '').split('/')
      const name = isBase ? 'Workspace' : (segments[segments.length - 1] || 'Workspace')
      return { name, cwd, sessions, lastActive: sessions[0]?.timestamp || '' }
    })
    .sort((a, b) => {
      const aBase = cleanBase !== null && a.cwd === cleanBase ? 0 : 1
      const bBase = cleanBase !== null && b.cwd === cleanBase ? 0 : 1
      if (aBase !== bBase) return aBase - bBase
      return new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime()
    })
}

type Provider = 'gemini' | 'openai'
type VoiceArch = 'pipeline' | 'direct' | 'realtime'

export default function Dashboard() {
  const router = useRouter()
  const supabase = createSupabaseBrowser()
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  // The agent's working directory (BASE LAYER) as reported by `/sessions`.
  // Null until we've successfully fetched the session list once. Used by
  // groupByProject to know which sessions are "Workspace" sessions vs
  // project-card sessions. See the comment block above groupByProject.
  const [baseCwd, setBaseCwd] = useState<string | null>(null)
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [agentUrl, setAgentUrl] = useState('http://localhost:8741')
  const [agentOnline, setAgentOnline] = useState<boolean | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  // Skills + named agents from the agent's HTTP API (GET /skills, GET /agents)
  // — the dashboard has no LiveKit data channel, so these come over HTTP.
  const [dashSkills, setDashSkills] = useState<{ name: string; description: string; folder?: string }[]>([])
  const [dashAgents, setDashAgents] = useState<{ name: string; description: string; model: string; tools: string[] }[]>([])
  // Mobile ⋯ overflow menu — which project's action menu is open
  const [openProjectMenu, setOpenProjectMenu] = useState<string | null>(null)
  const [installedVersion, setInstalledVersion] = useState<string | null>(null)
  const [latestVersion, setLatestVersion] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<{ text: string; type: 'success' | 'error' | 'info' } | null>(null)

  // Session-layer consistency report. When the sprite's persistent disk has
  // notably more sessions than the running container can see, we surface a
  // warning banner so the user knows recovery may be available — without
  // auto-restoring (which would clobber the current session). See
  // checkSessionLayerConsistency in lib/sprites.ts for layer details.
  type LayerReport = {
    persistentSessionCount: number
    persistentTotalJsonl: number
    persistentBytes: number
    containerSessionCount: number
    mismatch: boolean
    projects: Array<{ slug: string; jsonlCount: number; bigJsonlCount: number; totalBytes: number }>
  }
  const [layerReport, setLayerReport] = useState<LayerReport | null>(null)

  // Unified operation state. Only ONE long-running agent operation can run
  // at a time — restart or update. They share state because the UI can only
  // show one progress message anyway, and running them concurrently would
  // race the same Sprites service registration.
  //
  // Lifecycle:
  //   null                       → idle, agent operations enabled
  //   { kind, stage, startedAt } → in flight, button disabled, phase shown
  //
  // `targetVersion` is set during update so the version badge can show the
  // transition ("v0.8.32 → v0.8.33") instead of going blank or reverting.
  type Operation = {
    kind: 'restart' | 'update'
    stage: 'starting' | 'installing' | 'verifying' | 'snapshotting'
    startedAt: number
    targetVersion?: string
  }
  const [operation, setOperation] = useState<Operation | null>(null)
  const [opElapsed, setOpElapsed] = useState(0) // seconds since op started

  // Tick elapsed time for the operation banner. Only ticks while operation is set.
  useEffect(() => {
    if (!operation) { setOpElapsed(0); return }
    const id = setInterval(() => setOpElapsed(Math.floor((Date.now() - operation.startedAt) / 1000)), 1000)
    return () => clearInterval(id)
  }, [operation])

  // Convenience flags so existing render code reads naturally.
  const restarting = operation?.kind === 'restart'
  const updating = operation?.kind === 'update'
  const [sandboxAvailable, setSandboxAvailable] = useState(false)
  const [sandboxStatus, setSandboxStatus] = useState<string | null>(null)
  const [sandboxId, setSandboxId] = useState<string | null>(null)
  const [provisioning, setProvisioning] = useState(false)
  const [localAgentUrl] = useState('http://localhost:8741')
  // Cloud is the DEFAULT (2026-07-31): most users run the hosted machine; local
  // is the opt-in dev lane. A saved explicit preference always wins.
  const [connectionMode, setConnectionMode] = useState<'local' | 'cloud'>('cloud')
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set())
  const [expandedSessionLists, setExpandedSessionLists] = useState<Set<string>>(new Set())
  const [newProjectName, setNewProjectName] = useState('')
  const [showNewProject, setShowNewProject] = useState(false)
  const [importingProject, setImportingProject] = useState<string | null>(null)
  const [deletingProject, setDeletingProject] = useState<string | null>(null)   // cwd being deleted
  const [armedProjectDelete, setArmedProjectDelete] = useState<string | null>(null) // cwd armed for delete

  // Prefs
  const [provider, setProvider] = useState<Provider>('gemini')
  const [voiceArch, setVoiceArch] = useState<VoiceArch>('pipeline')

  // Auth check
  useEffect(() => {
    const timeout = setTimeout(() => setLoading(false), 3000)
    supabase.auth.getUser().then(({ data: { user } }) => {
      clearTimeout(timeout)
      setUser(user)
      setLoading(false)
    }).catch(() => { clearTimeout(timeout); setLoading(false) })
  }, [])

  // Load prefs
  useEffect(() => {
    const u = localStorage.getItem('osborn-agent-url')
    const p = localStorage.getItem('osborn-provider') as Provider | null
    const v = localStorage.getItem('osborn-voice-arch') as VoiceArch | null
    const m = localStorage.getItem('osborn-connection-mode') as 'local' | 'cloud' | null
    if (u) setAgentUrl(u)
    if (p) setProvider(p)
    if (v) setVoiceArch(v)
    // Saved explicit preference wins; otherwise the useState default ('cloud')
    // stands. (Historical: default used to be 'local' with a sandbox-probe
    // auto-detect to rescue signed-in cloud users from a logged-out-looking
    // "Local (offline)" dashboard — 2026-07-29. Cloud-by-default supersedes it.)
    if (m) setConnectionMode(m)
  }, [])

  // Fetch skills + named agents from the agent's HTTP API when settings open.
  // Older agents (<0.9.96) 404 these — sections just stay empty/hidden.
  useEffect(() => {
    if (!showSettings || !agentUrl) return
    const base = agentUrl.replace(/\/$/, '')
    fetch(`${base}/skills`).then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (Array.isArray(d?.skills)) setDashSkills(d.skills) })
      .catch(() => {})
    fetch(`${base}/agents`).then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (Array.isArray(d?.agents)) setDashAgents(d.agents) })
      .catch(() => {})
  }, [showSettings, agentUrl])

  // Persist prefs
  useEffect(() => {
    localStorage.setItem('osborn-agent-url', agentUrl)
    localStorage.setItem('osborn-connection-mode', connectionMode)
    localStorage.setItem('osborn-provider', provider)
    localStorage.setItem('osborn-voice-arch', voiceArch)
  }, [agentUrl, connectionMode, provider, voiceArch])

  // Mixed-content guard: a deployed HTTPS frontend cannot fetch http://localhost from
  // the browser — Chrome blocks it AND flags the entire page "Not Secure". Skip the fetch
  // entirely in that case so we don't pollute the page with mixed-content warnings.
  // Returns true when the (frontend protocol, agent protocol) pair is reachable.
  const canFetchAgent = useCallback(() => {
    if (typeof window === 'undefined') return false
    if (!agentUrl) return false
    if (window.location.protocol === 'https:' && agentUrl.startsWith('http://')) return false
    // In cloud mode the agent lives on a remote sprite, not on the localhost
    // fallback URL that `agentUrl` holds when the user hasn't configured one.
    // Pinging localhost:8741 in cloud mode just spams ERR_CONNECTION_REFUSED
    // every 15s. The cloud sandbox's health is tracked via sandboxStatus
    // (polled from /api/sandbox) — not by hitting the agent URL directly.
    if (connectionMode === 'cloud' && agentUrl.startsWith('http://localhost')) return false
    return true
  }, [agentUrl, connectionMode])

  // Fetch sessions
  const fetchSessions = useCallback(async () => {
    if (!canFetchAgent()) { setAgentOnline(false); setSessions([]); setBaseCwd(null); return }
    setSessionsLoading(true)
    try {
      const r = await fetch(`${agentUrl}/sessions`)
      const data = await r.json()
      setSessions(data.sessions || [])
      // baseCwd is included by 0.9.25+. Older agents omit it; null fallback
      // makes groupByProject behave like the pre-base-aware version (each
      // cwd is its own card) — no rendering crash, just less prettily.
      setBaseCwd(typeof data.baseCwd === 'string' && data.baseCwd ? data.baseCwd : null)
      setAgentOnline(true)
    } catch {
      setAgentOnline(false)
      setSessions([])
      setBaseCwd(null)
    } finally {
      setSessionsLoading(false)
    }
  }, [agentUrl, canFetchAgent])

  useEffect(() => { if (!loading) fetchSessions() }, [loading, fetchSessions])

  // Status polling — branches on connection mode:
  //   local:  hit the agent's /health directly (fast, local network)
  //   cloud:  poll /api/sandbox for sandboxStatus (cold/warm/running/stopped
  //           are rich states the sprite API reports; /health can't
  //           distinguish between them and the sprite's localhost:8741
  //           wouldn't even resolve from the browser anyway).
  //
  // In cloud mode agentOnline is derived as (sandboxStatus === 'running')
  // so the existing "offline" indicator only shows when the sprite is
  // genuinely not running. Everything else (cold, warm, stopped, creating)
  // displays the raw state on the badge so the user can see what's happening.
  useEffect(() => {
    if (loading) return
    if (!user) return

    let cancelled = false

    const check = async () => {
      if (cancelled) return

      if (connectionMode === 'cloud') {
        // Cloud: poll sandbox API
        try {
          const r = await fetch('/api/sandbox')
          const d = await r.json()
          if (cancelled) return
          setSandboxAvailable(d.available || false)
          if (d.sandbox) {
            setSandboxId(d.sandbox.id)
            setSandboxStatus(d.sandbox.status)
            if (d.sandbox.previewUrl) setAgentUrl(d.sandbox.previewUrl)
            setAgentOnline(d.sandbox.status === 'running')
          } else {
            setSandboxStatus(null)
            setAgentOnline(false)
          }
        } catch {
          if (cancelled) return
          setSandboxAvailable(false)
          setAgentOnline(false)
        }
        return
      }

      // Local: ping agent /health directly
      if (!canFetchAgent()) {
        setAgentOnline(false)
        return
      }
      try {
        await fetch(`${agentUrl}/health`, { signal: AbortSignal.timeout(4000) })
        if (!cancelled) setAgentOnline(true)
      } catch {
        if (!cancelled) setAgentOnline(false)
      }
    }

    check()
    const i = setInterval(check, 15000)
    return () => {
      cancelled = true
      clearInterval(i)
    }
  }, [agentUrl, loading, user, connectionMode, canFetchAgent])

  // One-time sandbox discovery on mount: if the user has a saved cloud
  // preference AND a sandbox already exists, adopt its previewUrl as the
  // agentUrl so the polling loop picks up the right target.
  useEffect(() => {
    if (loading || !user) return
    fetch('/api/sandbox').then(r => r.json())
      .then(d => {
        setSandboxAvailable(d.available || false)
        if (d.sandbox) {
          setSandboxId(d.sandbox.id)
          setSandboxStatus(d.sandbox.status)
          // Cloud default: no saved preference counts as cloud; only an
          // explicit 'local' choice opts out.
          const savedMode = localStorage.getItem('osborn-connection-mode')
          if (savedMode !== 'local' && d.sandbox.previewUrl) {
            setConnectionMode('cloud')
            setAgentUrl(d.sandbox.previewUrl)
          }
        }
      })
      .catch(() => setSandboxAvailable(false))
    fetch('/api/instance')
      .then(r => r.json())
      .then(d => { if (d.instance?.sync_token) setSyncToken(d.instance.sync_token) })
      .catch(() => {})
  }, [user, loading])

  const isCloud = connectionMode === 'cloud'

  // Check installed vs latest osborn version whenever we have a cloud sandbox.
  // The new check-version handler reads:
  //   - latest:    https://registry.npmjs.org/osborn/latest (no sprite involvement)
  //   - installed: marker file via Sprites fs API (works on warm/cold sprites)
  // So this works regardless of whether the agent process is running.
  useEffect(() => {
    if (isCloud && sandboxId) {
      checkVersion()
      // Don't bother on `creating` — the sandbox doesn't exist yet, so the
      // fs API call would 404. After it transitions to running/warm/cold the
      // status-dep change re-fires this effect.
      if (sandboxStatus && sandboxStatus !== 'creating') {
        checkLayerConsistency()
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCloud, sandboxId, sandboxStatus])

  // ── Actions ──

  const handleProvisionSandbox = async () => {
    if (!user) return
    setProvisioning(true)
    setSandboxStatus('creating')
    try {
      const r = await fetch('/api/sandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create' }),
      })
      const data = await r.json()
      if (data.status === 'running' && data.previewUrl) {
        setSandboxId(data.id)
        setSandboxStatus('running')
        setAgentUrl(data.previewUrl)
        setConnectionMode('cloud')
      } else {
        setSandboxStatus('error')
      }
    } catch {
      setSandboxStatus('error')
    } finally {
      setProvisioning(false)
    }
  }

  const handleStopSandbox = async () => {
    if (!sandboxId) return
    try {
      await fetch('/api/sandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop', sandboxId }),
      })
      setSandboxStatus('stopped')
    } catch {}
  }

  const handleStartSandbox = async () => {
    if (!sandboxId) return
    setProvisioning(true)
    try {
      const r = await fetch('/api/sandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', sandboxId }),
      })
      const data = await r.json()
      if (data.previewUrl) {
        setSandboxStatus('running')
        setAgentUrl(data.previewUrl)
        setConnectionMode('cloud')
      }
    } catch {} finally {
      setProvisioning(false)
    }
  }

  const handleCopySyncToken = async () => {
    if (!syncToken) return
    await navigator.clipboard.writeText(syncToken)
    setSyncCopied(true)
    setTimeout(() => setSyncCopied(false), 2000)
  }

  // Two-click delete: first click arms the button (text+color change), second
  // click within 4s actually deletes. Sprites does NOT soft-delete — once gone,
  // overlay + persistent disk + checkpoints are unrecoverable. We learned this
  // the hard way; the modal-equivalent friction is worth it.
  const [syncToken, setSyncToken] = useState<string | null>(null)
  const [syncCopied, setSyncCopied] = useState(false)
  const [skillCopied, setSkillCopied] = useState(false)
  const [globalSyncCopied, setGlobalSyncCopied] = useState(false)
  const [deleteArmed, setDeleteArmed] = useState(false)
  const deleteArmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleDeleteSandbox = async () => {
    if (!sandboxId) return
    if (!deleteArmed) {
      setDeleteArmed(true)
      if (deleteArmTimer.current) clearTimeout(deleteArmTimer.current)
      deleteArmTimer.current = setTimeout(() => setDeleteArmed(false), 4000)
      return
    }
    if (deleteArmTimer.current) clearTimeout(deleteArmTimer.current)
    setDeleteArmed(false)
    try { await fetch('/api/sandbox', { method: 'DELETE' }) } catch {}
    setSandboxId(null)
    setSandboxStatus(null)
    setConnectionMode('local')
    setAgentUrl(localAgentUrl)
  }

  const handleRestart = async () => {
    if (operation) return // already running an op
    setStatusMessage(null)
    setOperation({ kind: 'restart', stage: 'starting', startedAt: Date.now() })

    // Begin: server-side restart-service does stop+start internally.
    // Phase advances after request is fired.
    try {
      const restartPromise = fetch('/api/sandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'restart-service', sandboxId }),
      }).then(r => r.json()).catch((e) => ({ success: false, error: String(e) }))

      // Move to "verifying" phase ~3s in (server-side stop usually finishes by then)
      const phaseTimer = setTimeout(() => {
        setOperation((op) => op?.kind === 'restart' ? { ...op, stage: 'verifying' } : op)
      }, 3000)

      const result = await restartPromise
      clearTimeout(phaseTimer)

      if (result.success === false) {
        setOperation(null)
        setStatusMessage({ text: result.error || 'Restart failed', type: 'error' })
        return
      }

      // Server returned success → poll /health to confirm the agent is reachable
      // from the browser too (caches Sprites' DNS, mixed-content guard, etc).
      setOperation({ kind: 'restart', stage: 'verifying', startedAt: Date.now() })
      const deadline = Date.now() + 60000
      while (Date.now() < deadline) {
        try {
          const r = await fetch(`${agentUrl}/health`, { signal: AbortSignal.timeout(2000) })
          if (r.ok) {
            setOperation(null)
            setAgentOnline(true)
            setStatusMessage({ text: 'Agent is back online', type: 'success' })
            // Refresh version display in case install state changed.
            // Safe to call here because no upgrade is in flight.
            checkVersion()
            setTimeout(() => setStatusMessage(null), 4000)
            return
          }
        } catch {}
        await new Promise(r => setTimeout(r, 2000))
      }
      // Health didn't return within 60s — stop spinner, show error
      setOperation(null)
      setStatusMessage({ text: 'Agent restart timed out (60s)', type: 'error' })
    } catch (err) {
      setOperation(null)
      setStatusMessage({ text: `Restart error: ${(err as Error).message}`, type: 'error' })
    }
  }

  const handleUpdate = async () => {
    if (!sandboxId) return
    if (operation) return // already running an op
    setStatusMessage(null)

    // Capture target version up-front so the badge can show the transition
    // ("v0.8.32 → v0.8.33") instead of going blank during the install.
    const target = latestVersion ?? null
    setOperation({
      kind: 'update',
      stage: 'starting',
      startedAt: Date.now(),
      targetVersion: target ?? undefined,
    })

    // Phase machine: stage advances on a timeline so the user knows what's
    // happening even though the server returns one big response at the end.
    // Real timings on a typical install: stop ~2s, install ~50-70s, health ~5s,
    // checkpoint ~10s. Total ~70-90s.
    const phaseTimers = [
      setTimeout(() => setOperation((op) => op?.kind === 'update' ? { ...op, stage: 'installing' } : op), 3000),
      setTimeout(() => setOperation((op) => op?.kind === 'update' ? { ...op, stage: 'verifying' } : op), 60000),
      setTimeout(() => setOperation((op) => op?.kind === 'update' ? { ...op, stage: 'snapshotting' } : op), 80000),
    ]

    // Helper: poll `verify-update` until the server-side update result lands
    // OR the multi-signal state proves the update outcome on its own.
    //
    // This runs whenever the held-open POST drops (mobile Safari kills idle
    // fetches at ~30-60s, but updateOsborn runs ~90s) OR when the POST
    // returns `success: false` (which can still be a real failure — we need
    // to distinguish "server gave up partway" from "actually broken"). The
    // server stores its final result in `getLastUpdateResult(sandboxId)`, so
    // we ask for it directly instead of inferring from version probes alone.
    //
    // Three exit conditions:
    //   1. Authoritative: `lastUpdate.status === 'success'` or `'error'` →
    //      use its installedVersion + error message verbatim
    //   2. Inferred success: machine `started` AND `installedVersion === target` AND
    //      `lastUpdate.status` is null/missing (frontend pod restarted) → trust signals
    //   3. Timeout after 3 minutes → declare error using best-available info
    const verifyUpdate = async (targetVersion: string | null): Promise<
      { success: true; version: string | null } | { success: false; error: string }
    > => {
      const deadline = Date.now() + 3 * 60_000
      let lastSignals: { machineState?: string | null; installedVersion?: string | null } = {}
      while (Date.now() < deadline) {
        try {
          const r = await fetch('/api/sandbox', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'verify-update', sandboxId }),
          })
          if (r.ok) {
            const data = await r.json()
            lastSignals = { machineState: data.machineState, installedVersion: data.installedVersion }
            // (1) Authoritative — server-side updateOsborn finished. But only
            // trust it when the stored outcome is for THIS target version.
            // Previously we accepted any prior success in lastUpdate, which let
            // a stale "v0.9.35 update succeeded" entry mask a failed current
            // attempt to v0.9.36 — dashboard showed "Update complete" while
            // /health still reported 0.9.35.
            const lastTargetMatches =
              data.lastUpdate?.targetVersion && targetVersion
                ? data.lastUpdate.targetVersion === targetVersion
                : true
            if (data.lastUpdate?.status === 'success' && lastTargetMatches) {
              // Belt-and-suspenders: also require installedVersion to match
              // the target before declaring success. updateOsborn could have
              // marked success based on a stale signal; the live probe is
              // authoritative.
              if (
                !targetVersion ||
                (data.installedVersion && data.installedVersion === targetVersion)
              ) {
                return { success: true, version: data.lastUpdate.installedVersion ?? null }
              }
            }
            if (data.lastUpdate?.status === 'error' && lastTargetMatches) {
              return { success: false, error: data.lastUpdate.error ?? 'Update failed' }
            }
            // (2) Inferred — pod restarted, lastUpdate gone, but signals agree.
            if (
              data.machineState === 'running' &&
              data.installedVersion &&
              targetVersion &&
              data.installedVersion === targetVersion
            ) {
              return { success: true, version: data.installedVersion }
            }
            // Otherwise still in-progress — keep polling.
          }
        } catch {
          // Network error during poll — keep retrying until the deadline.
        }
        await new Promise((resolve) => setTimeout(resolve, 4000))
      }
      // (3) Timeout. Build the most informative error we can from the last
      // signals we saw, so the user knows whether it almost-worked or never
      // got off the ground.
      if (lastSignals.installedVersion === targetVersion) {
        return { success: true, version: lastSignals.installedVersion ?? null }
      }
      const detail = lastSignals.machineState
        ? ` (machine=${lastSignals.machineState}, installed=${lastSignals.installedVersion ?? 'unknown'})`
        : ''
      return { success: false, error: `Verification timed out after 3 min${detail}` }
    }

    try {
      // Primary path: hold the POST open. If Safari survives the whole ~90s
      // it returns the authoritative result here. If not (mobile fetch
      // timeout, sleep-then-resume, etc.) the catch triggers and we hand
      // off to verifyUpdate, which reads the server-side result store.
      const result = await fetch('/api/sandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update-osborn', sandboxId }),
      }).then(r => r.json()).catch((e) => ({ __droppedFetch: true, error: String(e) }))

      // Clear all phase timers regardless of outcome
      phaseTimers.forEach(clearTimeout)

      // Branch A: the POST never made it back (Safari fetch dropped). The
      // server may have finished, may still be running. Fall through to
      // verifyUpdate which polls the result store + signals.
      if (result.__droppedFetch) {
        setOperation((op) => op?.kind === 'update' ? { ...op, stage: 'verifying' } : op)
        const verified = await verifyUpdate(target)
        setOperation(null)
        if (verified.success) {
          if (verified.version) setInstalledVersion(verified.version)
          setAgentOnline(true)
          setStatusMessage({
            text: verified.version ? `Updated to v${verified.version}` : 'Update complete',
            type: 'success',
          })
          setTimeout(() => setStatusMessage(null), 4000)
        } else {
          setStatusMessage({ text: `Update failed: ${verified.error}`, type: 'error' })
        }
        return
      }

      // Branch B: server explicitly returned success=false. This might be a
      // real failure OR it might be a partial/race where updateOsborn returned
      // an error but a follow-up probe shows the version actually flipped.
      // Verify before declaring failure.
      if (result.success === false) {
        setOperation((op) => op?.kind === 'update' ? { ...op, stage: 'verifying' } : op)
        const verified = await verifyUpdate(target)
        setOperation(null)
        if (verified.success) {
          if (verified.version) setInstalledVersion(verified.version)
          setAgentOnline(true)
          setStatusMessage({
            text: verified.version ? `Updated to v${verified.version}` : 'Update complete',
            type: 'success',
          })
          setTimeout(() => setStatusMessage(null), 4000)
        } else {
          // Prefer the original server error message when present — it has
          // more detail than the verify timeout fallback ("Verification
          // timed out after 3 min" tells the user nothing useful).
          const errMsg = result.error || verified.error
          setStatusMessage({ text: `Update failed: ${errMsg}`, type: 'error' })
        }
        return
      }

      // Branch C: happy path — POST returned success in time. Trust it.
      const newVersion = result.version as string | null
      if (newVersion) setInstalledVersion(newVersion)
      setOperation(null)
      setAgentOnline(true)
      setStatusMessage({
        text: newVersion ? `Updated to v${newVersion}` : 'Update complete',
        type: 'success',
      })
      setTimeout(() => setStatusMessage(null), 4000)
    } catch (err) {
      // Reached only if even the fetch().then() chain threw synchronously
      // — extremely rare. Still try to verify before giving up.
      phaseTimers.forEach(clearTimeout)
      setOperation((op) => op?.kind === 'update' ? { ...op, stage: 'verifying' } : op)
      const verified = await verifyUpdate(target)
      setOperation(null)
      if (verified.success) {
        if (verified.version) setInstalledVersion(verified.version)
        setAgentOnline(true)
        setStatusMessage({
          text: verified.version ? `Updated to v${verified.version}` : 'Update complete',
          type: 'success',
        })
        setTimeout(() => setStatusMessage(null), 4000)
      } else {
        setStatusMessage({
          text: `Update error: ${(err as Error).message} (verify: ${verified.error})`,
          type: 'error',
        })
      }
    }
  }

  const checkVersion = async () => {
    if (!sandboxId) return
    try {
      const r = await fetch('/api/sandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'check-version' }),
      })
      if (!r.ok) return
      const data = await r.json()
      setInstalledVersion(data.installed ?? null)
      setLatestVersion(data.latest ?? null)
    } catch {}
  }

  // Persistent-disk vs container-view consistency check. Called alongside
  // checkVersion on cloud sandbox status changes. Cheap (one fs/list per
  // project dir, ~200ms total) and read-only — never triggers recovery.
  const checkLayerConsistency = async () => {
    if (!sandboxId) return
    try {
      const r = await fetch('/api/sandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'consistency-check' }),
      })
      if (!r.ok) { setLayerReport(null); return }
      setLayerReport(await r.json())
    } catch {
      setLayerReport(null)
    }
  }

  const signOut = async () => {
    await supabase.auth.signOut()
    window.location.href = '/'
  }

  const startChat = (sessionId?: string, sessionCwd?: string) => {
    const params = new URLSearchParams({ provider, voiceArch, agent: 'claude', agentUrl })
    if (sessionId) params.set('session', sessionId)
    // Forward the session's original cwd so the agent boots with the matching directory.
    // Without this the agent falls through to OSBORN_CWD or process.cwd(), which produces
    // the wrong project slug and a "Session not found" error on resume.
    if (sessionCwd) params.set('workingDirectory', sessionCwd)
    router.push(`/chat?${params.toString()}`)
  }

  const formatDate = (ts: string) => {
    const d = new Date(ts)
    const diff = Date.now() - d.getTime()
    if (diff < 60000) return 'Just now'
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
    if (diff < 604800000) return d.toLocaleDateString('en', { weekday: 'short' })
    return d.toLocaleDateString('en', { month: 'short', day: 'numeric' })
  }

  const toggleProject = (cwd: string) => {
    setExpandedProjects(prev => {
      const next = new Set(prev)
      if (next.has(cwd)) next.delete(cwd)
      else next.add(cwd)
      return next
    })
  }

  const handleDownload = async (cwd: string) => {
    try {
      const headers: HeadersInit = {}
      if (syncToken) headers['Authorization'] = `Bearer ${syncToken}`
      const r = await fetch(`${agentUrl}/sessions/export?workDir=${encodeURIComponent(cwd)}`, { headers })
      const blob = await r.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `sessions-${cwd.split('/').pop() || 'export'}.tar.gz`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      console.error('Export failed', e)
    }
  }

  const handleImport = async (cwd: string, file: File) => {
    setImportingProject(cwd)
    try {
      const r = await fetch(`${agentUrl}/sessions/import?targetWorkDir=${encodeURIComponent(cwd)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          ...(syncToken ? { 'Authorization': `Bearer ${syncToken}` } : {}),
        },
        body: file,
      })
      const data = await r.json()
      if (data.ok) {
        await fetchSessions()  // refresh session list
      }
    } finally {
      setImportingProject(null)
    }
  }

  const handleDeleteProject = async (project: ProjectGroup) => {
    const cwd = project.cwd
    // First click arms the button (4s window). Second click within that window confirms.
    if (armedProjectDelete !== cwd) {
      setArmedProjectDelete(cwd)
      setTimeout(() => setArmedProjectDelete(a => a === cwd ? null : a), 4000)
      return
    }
    // Confirmed — proceed with delete
    setArmedProjectDelete(null)
    setDeletingProject(cwd)
    try {
      const slug = project.cwd.replace(/\//g, '-')  // cwd → slug
      const headers: Record<string, string> = {}
      if (syncToken) headers['Authorization'] = `Bearer ${syncToken}`
      const r = await fetch(
        `${agentUrl}/sessions/project?slug=${encodeURIComponent(slug)}`,
        { method: 'DELETE', headers }
      )
      const data = await r.json()
      if (r.ok && data.success) {
        await fetchSessions()  // refresh list — project disappears
      } else {
        console.error('Delete project failed:', data.error)
      }
    } finally {
      setDeletingProject(null)
    }
  }

  const handleCopyGlobalSyncInfo = async () => {
    const skillUrl = `${window.location.origin}/api/sync-skill`
    // Include a ready-to-paste install instruction so the user just
    // pastes once into Claude Code and it installs + stores credentials.
    const info = [
      `Install the Voice Native sync skill globally (works in all Claude Code sessions):`,
      `mkdir -p ~/.claude/skills/voice-native-sync`,
      `curl -sS ${skillUrl} -o ~/.claude/skills/voice-native-sync/SKILL.md`,
      `printf 'CLOUD_URL=${agentUrl}\\nTOKEN=${syncToken || '(no token)'}\\n' > ~/.claude/skills/voice-native-sync/config`,
      ``,
      `After this, say "upload to voice native" or "download from voice native" in any Claude Code session.`,
    ].join('\n')
    await navigator.clipboard.writeText(info)
    setGlobalSyncCopied(true)
    setTimeout(() => setGlobalSyncCopied(false), 2000)
  }

  const handleCopySyncInfo = async (project: ProjectGroup) => {
    const skillUrl = `${window.location.origin}/api/sync-skill`
    const info = [
      `Install the Voice Native sync skill globally (works in all Claude Code sessions):`,
      `mkdir -p ~/.claude/skills/voice-native-sync`,
      `curl -sS ${skillUrl} -o ~/.claude/skills/voice-native-sync/SKILL.md`,
      `printf 'CLOUD_URL=${agentUrl}\\nTOKEN=${syncToken ?? ''}\\n' > ~/.claude/skills/voice-native-sync/config`,
      ``,
      `After this, say "upload to voice native" or "download from voice native" in any Claude Code session.`,
    ].join('\n')
    await navigator.clipboard.writeText(info)
    setSkillCopied(true)
    setTimeout(() => setSkillCopied(false), 2000)
  }

  const handleCreateProject = () => {
    const name = newProjectName.trim().toLowerCase().replace(/\s+/g, '-')
    if (!name) return
    const projectPath = `/home/sprite/workspace/${name}`
    setShowNewProject(false)
    setNewProjectName('')
    startChat(undefined, projectPath)
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-[var(--background)] flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-[var(--border)] border-t-[var(--accent)] rounded-full animate-spin" />
      </main>
    )
  }

  return (
    <>
      <style>{`
        @keyframes enter { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
      `}</style>
      <main className="min-h-screen bg-[var(--background)] flex flex-col">
        {/* ── Header ──────────────────────────────── */}
        <header className="sticky top-0 z-40 border-b border-[var(--border-subtle)] bg-[var(--background)]/80 backdrop-blur-md">
          <div className="max-w-2xl mx-auto px-4 h-14 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-7 h-7 rounded-full flex items-center justify-center"
                style={{ background: 'linear-gradient(135deg, var(--accent) 0%, var(--accent-dim) 100%)' }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--background)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                </svg>
              </div>
              <span className="text-[var(--text-primary)] font-semibold text-[15px] tracking-tight">Osborn</span>
            </div>

            <div className="flex items-center gap-1.5">
              {/* Live clock — date/time/timezone so screenshots carry when */}
              <LiveClock showDate />

              {/* Connection badge — in cloud mode shows the rich sandbox
                  state (cold/warm/running/stopped) from /api/sandbox; in
                  local mode shows agent /health reachability. */}
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[var(--surface)] border border-[var(--border-subtle)]">
                <div className={`w-1.5 h-1.5 rounded-full transition-colors ${
                  isCloud
                    ? sandboxStatus === 'running' ? 'bg-emerald-400'
                      : sandboxStatus === 'warm' ? 'bg-amber-400'
                      : sandboxStatus === 'cold' ? 'bg-sky-400'
                      : sandboxStatus === 'stopped' ? 'bg-orange-400'
                      : sandboxStatus === 'creating' ? 'bg-amber-400 animate-pulse'
                      : sandboxStatus === 'error' ? 'bg-red-400'
                      : 'bg-[var(--text-muted)]'
                    : agentOnline ? 'bg-emerald-400' : agentOnline === false ? 'bg-red-400' : 'bg-[var(--text-muted)]'
                }`} />
                <span className="text-[11px] text-[var(--text-muted)]">
                  {isCloud
                    ? sandboxStatus ? `Cloud (${sandboxStatus})` : 'Cloud'
                    : agentOnline ? 'Local' : agentOnline === false ? 'Local (offline)' : 'Local'
                  }
                </span>
              </div>

              {/* Copy sync info */}
              <button
                onClick={handleCopyGlobalSyncInfo}
                title="Copy sync info"
                className={`p-2 rounded-lg transition-all ${
                  globalSyncCopied
                    ? 'text-emerald-400'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface)]'
                }`}>
                {globalSyncCopied ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"/>
                  </svg>
                )}
              </button>

              {/* Settings gear */}
              <button onClick={() => setShowSettings(s => !s)}
                className={`p-2 rounded-lg transition-all ${
                  showSettings
                    ? 'text-[var(--accent)] bg-[var(--accent-dim)]/20'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface)]'
                }`}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                </svg>
              </button>

              {/* Avatar */}
              <button onClick={signOut} title="Sign out"
                className="p-1 rounded-lg hover:bg-[var(--surface)] transition-all">
                {user?.user_metadata?.avatar_url ? (
                  <img src={user.user_metadata.avatar_url} alt="" className="w-7 h-7 rounded-full ring-1 ring-[var(--border)]" />
                ) : (
                  <div className="w-7 h-7 rounded-full bg-[var(--accent-dim)] flex items-center justify-center text-[11px] font-semibold text-[var(--background)]">
                    {(user?.email?.[0] || '?').toUpperCase()}
                  </div>
                )}
              </button>
            </div>
          </div>
        </header>

        {/* ── Settings panel ──────────────────────── */}
        <div className="overflow-hidden transition-all duration-300 ease-out"
          style={{ maxHeight: showSettings ? 420 : 0, opacity: showSettings ? 1 : 0 }}>
          <div className="border-b border-[var(--border-subtle)]">
            <div className="max-w-2xl mx-auto px-4 py-5 space-y-5">

              {/* ── Environment ── */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-[var(--text-muted)] text-[11px] font-medium uppercase tracking-widest">Environment</span>
                  <div className="flex items-center gap-2">
                  {/* Restart agent — visible whenever we have a cloud sandbox, regardless
                      of agentOnline. The dashboard's browser-side /health poll can fail
                      to see a healthy agent during warm-wake (server-side health passes
                      but browser polling races the warm thaw), which used to hide this
                      button exactly when the user needs it most — to force a clean
                      service restart out of a warm-stuck loop. */}
                  {isCloud && sandboxId && !operation && (
                    <button onClick={handleRestart}
                      className="text-[11px] text-[var(--text-muted)] hover:text-red-400 transition-colors">
                      Restart agent
                    </button>
                  )}

                  {/* Version badge + Update button: shown whenever we're in cloud
                      mode and have a sandbox. Source: server-side check-version
                      reads marker file via fs API + npm registry HTTP — both work
                      regardless of whether the agent process is running. So these
                      remain visible (and accurate) on warm/cold sprites. */}
                  {isCloud && sandboxId && !operation && (
                    <div className="flex items-center gap-2">
                      {installedVersion && (
                        <span className={`inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full font-mono ${
                          latestVersion && installedVersion !== latestVersion
                            ? 'bg-amber-400/15 text-amber-400'
                            : 'bg-[var(--surface)] text-[var(--text-muted)]'
                        }`}>
                          {latestVersion && installedVersion !== latestVersion && (
                            <span className="text-amber-400 text-[9px]">▲</span>
                          )}
                          v{installedVersion}
                        </span>
                      )}
                      <button onClick={handleUpdate}
                        className="text-[11px] text-[var(--text-muted)] hover:text-sky-400 transition-colors">
                        {latestVersion && installedVersion && latestVersion !== installedVersion
                          ? `Update to v${latestVersion}`
                          : 'Update Osborn'}
                      </button>
                    </div>
                  )}

                  {/* Update in flight — show transition badge + phased status */}
                  {updating && operation && (
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full font-mono bg-sky-400/15 text-sky-400">
                        v{installedVersion ?? '?'}
                        <span className="opacity-60">→</span>
                        v{operation.targetVersion ?? latestVersion ?? '?'}
                      </span>
                      <span className="text-[11px] text-sky-400 animate-pulse">
                        {operation.stage === 'starting'      && 'Stopping service...'}
                        {operation.stage === 'installing'    && `Installing v${operation.targetVersion ?? latestVersion ?? 'latest'}...`}
                        {operation.stage === 'verifying'     && 'Verifying agent...'}
                        {operation.stage === 'snapshotting'  && 'Saving snapshot...'}
                        {' '}({opElapsed}s)
                      </span>
                    </div>
                  )}

                  {/* Restart in flight */}
                  {restarting && operation && (
                    <span className="text-[11px] text-amber-400 animate-pulse">
                      {operation.stage === 'starting'  && 'Restarting service...'}
                      {operation.stage === 'verifying' && 'Waiting for agent to come back...'}
                      {' '}({opElapsed}s)
                    </span>
                  )}

                  {/* Final status (success/error) — only shows when no op in flight */}
                  {statusMessage && !operation && (
                    <p className={`text-[11px] ${statusMessage.type === 'success' ? 'text-green-400' : statusMessage.type === 'error' ? 'text-red-400' : 'text-sky-400'}`}>
                      {statusMessage.text}
                    </p>
                  )}
                </div>
                </div>

                {/* Data-layer mismatch warning. Surfaces when persistent disk
                    has notably more session data than the running container —
                    a sign that a CRIU restore left the container with a stale
                    /home view. Read-only signal; recovery is manual via the
                    Sprites checkpoint API (intentional — restore destroys the
                    current session). See checkSessionLayerConsistency for
                    layer-divergence background. */}
                {layerReport && layerReport.mismatch && (
                  <div className="rounded-lg border border-amber-400/30 bg-amber-400/[0.06] px-3 py-2.5 text-[11.5px] text-amber-100 leading-relaxed">
                    <div className="flex items-start gap-2">
                      <span className="text-amber-400 text-[13px] leading-none mt-px">⚠</span>
                      <div className="flex-1 space-y-1">
                        <div className="font-medium text-amber-300">
                          Older session data on disk isn't visible to the running agent
                        </div>
                        <div className="text-amber-100/80">
                          Persistent disk has{' '}
                          <span className="font-mono">{layerReport.persistentSessionCount}</span>{' '}
                          large session{layerReport.persistentSessionCount === 1 ? '' : 's'}{' '}
                          ({(layerReport.persistentBytes / 1024 / 1024).toFixed(1)} MB total).
                          Agent only sees{' '}
                          <span className="font-mono">{layerReport.containerSessionCount}</span>.
                          This usually means a checkpoint restore rolled back the container
                          view. Data isn't lost — it's recoverable from a Sprites checkpoint
                          (destructive to current session).
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Segmented control: Local / Cloud */}
                <div className="flex rounded-xl bg-[var(--surface)] border border-[var(--border-subtle)] p-1 gap-1">
                  {/* Local option */}
                  <button
                    onClick={() => { setConnectionMode('local'); setAgentUrl(localAgentUrl) }}
                    className={`flex-1 flex items-center justify-center gap-2 py-2.5 px-3 rounded-lg text-[13px] font-medium transition-all ${
                      !isCloud
                        ? 'bg-[var(--background)] text-[var(--text-primary)] shadow-sm border border-[var(--border-subtle)]'
                        : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                    }`}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
                    </svg>
                    Local
                  </button>

                  {/* Cloud option */}
                  <button
                    onClick={() => {
                      if (sandboxId && sandboxStatus === 'running') {
                        setConnectionMode('cloud')
                      } else if (sandboxId && sandboxStatus === 'stopped') {
                        handleStartSandbox()
                      } else if (sandboxAvailable) {
                        handleProvisionSandbox()
                      }
                    }}
                    disabled={provisioning || (!sandboxAvailable && !sandboxId)}
                    className={`flex-1 flex items-center justify-center gap-2 py-2.5 px-3 rounded-lg text-[13px] font-medium transition-all disabled:opacity-30 ${
                      isCloud
                        ? 'bg-[var(--background)] text-[var(--text-primary)] shadow-sm border border-[var(--border-subtle)]'
                        : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                    }`}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>
                    </svg>
                    {provisioning ? 'Setting up...' : 'Cloud'}
                  </button>
                </div>

                {/* Context info below the toggle */}
                {!isCloud && (
                  <input type="text" value={agentUrl}
                    onChange={e => setAgentUrl(e.target.value)}
                    placeholder="http://localhost:8741"
                    className="w-full h-9 bg-[var(--surface)] border border-[var(--border-subtle)] rounded-xl text-[var(--text-secondary)] text-[12px] px-3 font-mono outline-none focus:border-[var(--accent)]/50 transition-colors placeholder:text-[var(--text-muted)]/40" />
                )}

                {isCloud && sandboxId && (
                  <div className="flex flex-col bg-[var(--surface)] rounded-xl px-3 py-2.5 border border-[var(--border-subtle)] gap-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        <div className={`w-2 h-2 rounded-full ${
                          sandboxStatus === 'running' ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.4)]'
                          : sandboxStatus === 'warm' ? 'bg-amber-400'
                          : sandboxStatus === 'cold' ? 'bg-sky-400'
                          : sandboxStatus === 'stopped' ? 'bg-orange-400'
                          : sandboxStatus === 'creating' ? 'bg-amber-400 animate-pulse'
                          : 'bg-gray-500'
                        }`} />
                        <span className="text-[12px] text-[var(--text-secondary)] font-mono">{sandboxId.substring(0, 8)}</span>
                        <span className="text-[11px] text-[var(--text-muted)] capitalize">{sandboxStatus}</span>
                      </div>
                      <div className="flex items-center gap-1">
                        {(sandboxStatus === 'stopped' || sandboxStatus === 'warm' || sandboxStatus === 'cold') && (
                          <button onClick={handleStartSandbox} disabled={provisioning}
                            className="text-[11px] text-emerald-400 hover:text-emerald-300 px-2 py-1 rounded-lg hover:bg-emerald-400/10 transition-all disabled:opacity-50">
                            Resume
                          </button>
                        )}
                        {sandboxStatus === 'running' && (
                          <button onClick={handleStopSandbox}
                            className="text-[11px] text-[var(--text-muted)] hover:text-orange-400 px-2 py-1 rounded-lg hover:bg-orange-400/10 transition-all">
                            Stop
                          </button>
                        )}
                        <button
                          onClick={handleDeleteSandbox}
                          className={`text-[11px] px-2 py-1 rounded-lg transition-all ${
                            deleteArmed
                              ? 'bg-red-500 text-white font-medium hover:bg-red-600 ring-2 ring-red-400/40'
                              : 'text-[var(--text-muted)] hover:text-red-400 hover:bg-red-400/10'
                          }`}
                          title={deleteArmed
                            ? 'Click again to PERMANENTLY delete (no recovery — Sprites does not soft-delete)'
                            : 'Delete sandbox and switch to local'}>
                          {deleteArmed ? (
                            <span className="inline-flex items-center gap-1">
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                              </svg>
                              Confirm delete?
                            </span>
                          ) : (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                            </svg>
                          )}
                        </button>
                      </div>
                    </div>
                    {syncToken && (
                      <div className="flex items-center gap-2 border-t border-[var(--border-subtle)] pt-2">
                        <span className="text-[11px] text-[var(--text-muted)] font-mono flex-1 truncate">
                          Sync token: {syncToken.substring(0, 8)}...
                        </span>
                        <button
                          onClick={handleCopySyncToken}
                          className="text-[11px] px-2 py-1 rounded-lg bg-[var(--surface-raised)] hover:bg-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors shrink-0"
                        >
                          {syncCopied ? '✓ Copied' : 'Copy token'}
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* Provisioning progress */}
                {provisioning && (
                  <div className="h-1 rounded-full overflow-hidden bg-[var(--surface)]">
                    <div className="h-full rounded-full" style={{
                      background: 'linear-gradient(90deg, transparent, var(--accent), transparent)',
                      backgroundSize: '200% 100%',
                      animation: 'shimmer 1.5s ease-in-out infinite',
                    }} />
                  </div>
                )}
              </div>

              {/* ── Voice & Provider ── */}
              <div className="flex gap-6">
                <ToggleCompact label="Voice" options={[['pipeline','Pipeline'],['direct','Direct'],['realtime','Realtime']]}
                  value={voiceArch} onChange={v => setVoiceArch(v as VoiceArch)} />
                <ToggleCompact label="Provider" options={[['gemini','Gemini'],['openai','OpenAI']]}
                  value={provider} onChange={v => setProvider(v as Provider)} />
              </div>

              {/* ── Skills & Named Agents (from the agent's HTTP API) ── */}
              {(dashSkills.length > 0 || dashAgents.length > 0) && (
                <div className="flex flex-col gap-3 pt-1 border-t border-[var(--border-subtle)]">
                  {dashAgents.length > 0 && (
                    <div>
                      <span className="text-[var(--text-muted)] text-[11px] font-medium uppercase tracking-widest">Agents ({dashAgents.length})</span>
                      <div className="mt-2 grid gap-2">
                        {dashAgents.map((a) => {
                          const glyph = a.name === 'researcher' ? '🔍' : a.name === 'reasoner' ? '🧠' : a.name === 'writer' ? '✍️' : '🤖'
                          return (
                            <div key={a.name} className="flex gap-3 p-3 rounded-xl bg-[var(--surface)] border border-[var(--border-subtle)] hover:border-[var(--accent-dim)]/40 transition-colors">
                              <div className="w-9 h-9 rounded-lg bg-gradient-to-b from-[var(--surface-2)] to-[var(--surface)] border border-[var(--border-subtle)] flex items-center justify-center text-base flex-shrink-0">
                                {glyph}
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-[13px] text-[var(--text-primary)] capitalize font-semibold tracking-tight">{a.name}</span>
                                  <span className="flex items-center gap-1.5 flex-shrink-0">
                                    <span className="px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-[var(--accent)] font-bold rounded-full bg-[var(--accent-dim)]/15 border border-[var(--accent-dim)]/25">{a.model}</span>
                                    <span className="text-[10px] text-[var(--text-muted)] font-mono">{a.tools.length}⚒</span>
                                  </span>
                                </div>
                                <p className="mt-0.5 text-[11px] leading-snug text-[var(--text-muted)] line-clamp-2">{a.description}</p>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}
                  {dashSkills.length > 0 && (
                    <div>
                      <span className="text-[var(--text-muted)] text-[11px] font-medium uppercase tracking-widest">Skills ({dashSkills.length})</span>
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {dashSkills.map((s) => (
                          <span key={s.folder || s.name} title={s.description}
                            className="px-2 py-0.5 text-[10px] rounded-full bg-[var(--surface)] border border-[var(--border-subtle)] text-[var(--text-secondary)]">
                            {s.name.length > 34 ? s.name.slice(0, 32) + '…' : s.name}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* ── Account ── */}
              {user && (
                <div className="flex items-center justify-between pt-1 border-t border-[var(--border-subtle)]">
                  <span className="text-[var(--text-muted)] text-[11px]">
                    {user.email}
                  </span>
                  <button onClick={signOut} className="text-[11px] text-[var(--text-muted)] hover:text-red-400 transition-colors">
                    Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── Content ──────────────────────────────── */}
        <div className="flex-1 max-w-2xl mx-auto w-full px-4 py-6">

          {/* New chat button */}
          <button onClick={() => startChat()}
            className="w-full h-14 rounded-2xl font-semibold text-[15px] tracking-[-0.01em] transition-all duration-150 active:scale-[0.98] mb-6 flex items-center justify-center gap-2.5"
            style={{
              background: 'linear-gradient(135deg, var(--accent) 0%, var(--accent-dim) 100%)',
              color: 'var(--background)',
              boxShadow: '0 2px 8px var(--accent-glow), inset 0 1px 0 rgba(255,255,255,0.1)',
            }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
              <line x1="12" y1="19" x2="12" y2="23"/>
            </svg>
            New conversation
          </button>

          {/* Agent offline states */}
          {agentOnline === false && isCloud && provisioning && (
            <div className="text-center py-12" style={{ animation: 'fadeIn 0.3s ease both' }}>
              <div className="w-10 h-10 rounded-full bg-[var(--accent-dim)]/20 flex items-center justify-center mx-auto mb-3">
                <div className="w-4 h-4 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
              </div>
              <p className="text-[var(--accent)] text-sm">Setting up your cloud workspace</p>
              <p className="text-[var(--text-muted)] text-xs mt-1 opacity-60">
                Installing osborn + claude-code (~60s on first launch)
              </p>
            </div>
          )}

          {agentOnline === false && !provisioning && (
            <div className="text-center py-12" style={{ animation: 'fadeIn 0.3s ease both' }}>
              <div className="w-10 h-10 rounded-full bg-[var(--surface)] flex items-center justify-center mx-auto mb-3">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/>
                </svg>
              </div>
              <p className="text-[var(--text-muted)] text-sm">
                {isCloud
                  ? sandboxStatus === 'stopped' ? 'Cloud workspace is stopped' : 'Cloud workspace is offline'
                  : 'Local agent is offline'}
              </p>
              <p className="text-[var(--text-muted)] text-xs mt-1 opacity-60">
                {isCloud
                  ? sandboxStatus === 'stopped'
                    ? 'Open Settings → Resume to start it again'
                    : 'Open Settings to manage your workspace'
                  : `Check that your agent is running at ${agentUrl}`}
              </p>
            </div>
          )}

          {/* Projects section — only shown when agent is reachable */}
          {agentOnline !== false && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-[var(--text-secondary)] text-xs font-medium uppercase tracking-wider">Projects</h2>
                {sessionsLoading && (
                  <div className="w-3 h-3 border border-[var(--border)] border-t-[var(--accent)] rounded-full animate-spin" />
                )}
              </div>

              {/* New Project */}
              <div className="mb-4">
                {showNewProject ? (
                  <div className="flex gap-2">
                    <input
                      autoFocus
                      className="flex-1 rounded-xl bg-[var(--surface)] px-4 py-3 text-sm outline-none"
                      placeholder="Project name"
                      value={newProjectName}
                      onChange={e => setNewProjectName(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleCreateProject()
                        if (e.key === 'Escape') { setShowNewProject(false); setNewProjectName('') }
                      }}
                    />
                    <button
                      onClick={handleCreateProject}
                      className="rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-medium text-white"
                    >
                      Start
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setShowNewProject(true)}
                    className="w-full rounded-2xl bg-[var(--surface)] px-4 py-3.5 text-left text-sm font-medium hover:opacity-80 transition-opacity"
                  >
                    + New project
                  </button>
                )}
              </div>

              {/* Project list */}
              {sessionsLoading ? (
                <div className="flex justify-center py-8">
                  <div className="w-5 h-5 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
                </div>
              ) : sessions.length === 0 && agentOnline ? (
                <p className="px-4 text-sm text-[var(--muted)]">No conversations yet</p>
              ) : (
                <div className="space-y-2">
                  {groupByProject(sessions, baseCwd).map(project => (
                    <div key={project.cwd} className="rounded-2xl bg-[var(--surface)] overflow-hidden">
                      {/* Project header row */}
                      <div className="flex items-center gap-3 px-4 py-3.5">
                        <button
                          className="flex-1 flex items-center gap-3 text-left min-w-0"
                          onClick={() => toggleProject(project.cwd)}
                        >
                          <div className="w-9 h-9 rounded-xl bg-[var(--surface-2)] flex items-center justify-center flex-shrink-0 text-base">
                            {project.name === 'General' ? '📁' : '🗂️'}
                          </div>
                          <div className="min-w-0">
                            <div className="text-sm font-medium capitalize truncate">{project.name}</div>
                            <div className="text-xs text-[var(--muted)]">
                              {project.sessions.length} session{project.sessions.length !== 1 ? 's' : ''} · {formatDate(project.lastActive)}
                            </div>
                          </div>
                          <svg
                            className={`w-4 h-4 text-[var(--muted)] flex-shrink-0 transition-transform ${expandedProjects.has(project.cwd) ? 'rotate-90' : ''}`}
                            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                          </svg>
                        </button>
                        {/* Per-project actions — primary (+) always visible; the
                            rest live inline on ≥sm and collapse into a ⋯ menu on
                            mobile so the project NAME keeps its space. */}
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <button
                            onClick={() => startChat(undefined, project.cwd)}
                            title="New conversation in this project"
                            className="p-2 rounded-lg hover:bg-[var(--surface-2)] active:scale-95 transition-all text-[var(--muted)] hover:text-[var(--accent)]"
                          >
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                            </svg>
                          </button>
                          <div className="hidden sm:flex items-center gap-1">
                            <button
                              onClick={() => handleDownload(project.cwd)}
                              title="Export project"
                              className="p-2 rounded-lg hover:bg-[var(--surface-2)] transition-colors text-[var(--muted)] hover:text-[var(--text)]"
                            >
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                              </svg>
                            </button>
                            <label
                              title="Import sessions"
                              className={`p-2 rounded-lg hover:bg-[var(--surface-2)] transition-colors cursor-pointer ${importingProject === project.cwd ? 'opacity-50' : 'text-[var(--muted)] hover:text-[var(--text)]'}`}
                            >
                              {importingProject === project.cwd ? (
                                <div className="w-4 h-4 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
                              ) : (
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l4-4m0 0l4 4m-4-4v12" />
                                </svg>
                              )}
                              <input
                                type="file"
                                accept=".tar.gz,.tgz"
                                className="hidden"
                                onChange={e => {
                                  const f = e.target.files?.[0]
                                  if (f) handleImport(project.cwd, f)
                                  e.target.value = ''
                                }}
                              />
                            </label>
                            <button
                              onClick={() => handleCopySyncInfo(project)}
                              title="Copy sync info"
                              className={`p-2 rounded-lg hover:bg-[var(--surface-2)] transition-colors ${skillCopied ? 'text-emerald-400' : 'text-[var(--muted)] hover:text-[var(--text)]'}`}
                            >
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                              </svg>
                            </button>
                            {/* Delete project — arms on first click, confirms on second within 4s */}
                            <button
                              onClick={() => handleDeleteProject(project)}
                              title={armedProjectDelete === project.cwd ? 'Click again to confirm delete' : 'Delete project sessions'}
                              className={`p-2 rounded-lg transition-colors ${
                                deletingProject === project.cwd
                                  ? 'opacity-50 cursor-not-allowed text-[var(--muted)]'
                                  : armedProjectDelete === project.cwd
                                  ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
                                  : 'hover:bg-[var(--surface-2)] text-[var(--muted)] hover:text-red-400'
                              }`}
                              disabled={deletingProject === project.cwd}
                            >
                              {deletingProject === project.cwd ? (
                                <div className="w-4 h-4 border-2 border-red-400 border-t-transparent rounded-full animate-spin" />
                              ) : (
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
                              )}
                            </button>
                          </div>
                          {/* Mobile ⋯ overflow menu */}
                          <div className="relative sm:hidden">
                            <button
                              onClick={() => setOpenProjectMenu(openProjectMenu === project.cwd ? null : project.cwd)}
                              title="Project actions"
                              className={`p-2 rounded-lg transition-colors ${openProjectMenu === project.cwd ? 'bg-[var(--surface-2)] text-[var(--text)]' : 'text-[var(--muted)] hover:bg-[var(--surface-2)]'}`}
                            >
                              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                                <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
                              </svg>
                            </button>
                            {openProjectMenu === project.cwd && (
                              <>
                                <div className="fixed inset-0 z-40" onClick={() => setOpenProjectMenu(null)} />
                                <div className="absolute right-0 top-full mt-1 z-50 w-44 rounded-xl bg-[var(--surface-2)] border border-[var(--border-subtle)] shadow-2xl overflow-hidden py-1">
                                  <button onClick={() => { handleDownload(project.cwd); setOpenProjectMenu(null) }}
                                    className="w-full px-3 py-2.5 text-left text-[13px] text-[var(--text-secondary)] hover:bg-[var(--surface)] transition-colors">
                                    Export project
                                  </button>
                                  <label className="block w-full px-3 py-2.5 text-left text-[13px] text-[var(--text-secondary)] hover:bg-[var(--surface)] transition-colors cursor-pointer">
                                    {importingProject === project.cwd ? 'Importing…' : 'Import sessions'}
                                    <input type="file" accept=".tar.gz,.tgz" className="hidden"
                                      onChange={e => { const f = e.target.files?.[0]; if (f) handleImport(project.cwd, f); e.target.value = ''; setOpenProjectMenu(null) }} />
                                  </label>
                                  <button onClick={() => { handleCopySyncInfo(project); setOpenProjectMenu(null) }}
                                    className="w-full px-3 py-2.5 text-left text-[13px] text-[var(--text-secondary)] hover:bg-[var(--surface)] transition-colors">
                                    Copy sync info
                                  </button>
                                  <div className="h-px bg-[var(--border-subtle)] mx-2 my-1" />
                                  <button onClick={() => handleDeleteProject(project)}
                                    className={`w-full px-3 py-2.5 text-left text-[13px] transition-colors ${armedProjectDelete === project.cwd ? 'text-red-400 font-semibold bg-red-500/10' : 'text-red-400/80 hover:bg-[var(--surface)]'}`}>
                                    {armedProjectDelete === project.cwd ? 'Tap again to confirm' : 'Delete project'}
                                  </button>
                                </div>
                              </>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Expanded session list */}
                      {expandedProjects.has(project.cwd) && (
                        <div className="border-t border-[var(--border)] divide-y divide-[var(--border)]">
                          {(expandedSessionLists.has(project.cwd)
                            ? project.sessions
                            : project.sessions.slice(0, 15)
                          ).map(s => (
                            <button
                              key={s.sessionId}
                              onClick={() => startChat(s.sessionId, s.cwd)}
                              className="w-full px-4 py-3 text-left hover:bg-[var(--surface-2)] transition-colors"
                            >
                              <div className="text-sm text-[var(--text)] line-clamp-1">
                                {s.lastMessage || 'New conversation'}
                              </div>
                              <div className="text-xs text-[var(--muted)] mt-0.5 flex items-center gap-2">
                                <span>{formatDate(s.timestamp)}</span>
                                {s.messageCount ? <span>{s.messageCount} messages</span> : null}
                              </div>
                            </button>
                          ))}
                          {project.sessions.length > 15 && !expandedSessionLists.has(project.cwd) && (
                            <button
                              onClick={() => setExpandedSessionLists(s => { const n = new Set(s); n.add(project.cwd); return n })}
                              className="w-full px-4 py-2 text-xs text-[var(--accent)] hover:bg-[var(--surface-2)] transition-colors text-left"
                            >
                              +{project.sessions.length - 15} more — show all
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </main>
    </>
  )
}

function ToggleCompact({ label, options, value, onChange }: {
  label: string; options: [string, string][]; value: string; onChange: (v: string) => void
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[var(--text-muted)] text-[11px] font-medium uppercase tracking-widest">{label}</span>
      <div className="inline-flex rounded-xl bg-[var(--surface)] border border-[var(--border-subtle)] p-0.5 gap-0.5">
        {options.map(([v, l]) => (
          <button key={v} onClick={() => onChange(v)}
            className={`px-3 py-1.5 text-[11px] rounded-lg transition-all ${
              value === v
                ? 'bg-[var(--accent)] text-[var(--background)] font-semibold shadow-sm'
                : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
            }`}>
            {l}
          </button>
        ))}
      </div>
    </div>
  )
}
