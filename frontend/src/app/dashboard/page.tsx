'use client'

import { useState, useEffect, useCallback, useRef } from 'react'

// Fly region code → city, so "Cloud · Chicago" reads human. Unknown codes
// fall back to the uppercased code (still tells you WHERE-ish).
const FLY_REGION_CITIES: Record<string, string> = {
  ord: 'Chicago', iad: 'Ashburn, VA', ewr: 'New Jersey', dfw: 'Dallas',
  sjc: 'San Jose', lax: 'Los Angeles', sea: 'Seattle', den: 'Denver',
  mia: 'Miami', atl: 'Atlanta', phx: 'Phoenix', bos: 'Boston',
  yyz: 'Toronto', yul: 'Montreal', lhr: 'London', ams: 'Amsterdam',
  cdg: 'Paris', fra: 'Frankfurt', mad: 'Madrid', gru: 'São Paulo',
  nrt: 'Tokyo', sin: 'Singapore', syd: 'Sydney', bom: 'Mumbai', jnb: 'Johannesburg',
}
import LiveClock from '@/components/LiveClock'
import { createSupabaseBrowser } from '@/lib/supabase-browser'
import { shareSession, listSharedWithMe, importSharedSession, type SharedSession } from '@/lib/session-sharing'
import type { User } from '@supabase/supabase-js'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

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

  // Legacy sub-project: sessions from `/home/sprite/workspace/X` are the
  // same logical project as `/workspace/X` — merge them into one card.
  for (const legacyBase of LEGACY_BASE_CWDS) {
    if (clean.startsWith(legacyBase + '/')) {
      const rest = clean.slice(legacyBase.length + 1)
      const firstSegment = rest.split('/')[0]
      return `${cleanBase}/${firstSegment}`
    }
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

// Turn a raw session preview into something presentable. The JSONL first line
// is frequently a `[MEETING — <botId>]:` transcript dump or a
// `<task-notification>` blob — both read as gibberish in a list. Classify it
// and return a clean label + text so the card can show a badge instead.
type SessionKind = 'meeting' | 'task' | 'chat'
function prettySessionPreview(raw?: string): { kind: SessionKind; label: string; text: string } {
  const s = (raw || '').trim()
  if (!s) return { kind: 'chat', label: 'Chat', text: 'New conversation' }
  const mt = s.match(/^\[MEETING[^\]]*\]:?\s*([\s\S]*)$/i)
  if (mt) {
    const body = mt[1].replace(/^\s*[\w .'-]+:\s*/, '').replace(/\s+/g, ' ').trim()
    return { kind: 'meeting', label: 'Meeting', text: body || 'Meeting notes' }
  }
  // [SYSTEM] "You are now in a meeting (Recall bot ID: …)" is a meeting session;
  // other [SYSTEM] lines are plumbing — strip the tag rather than show it raw.
  const sys = s.match(/^\[SYSTEM\]\s*([\s\S]*)$/i)
  if (sys) {
    if (/in a meeting/i.test(sys[1])) return { kind: 'meeting', label: 'Meeting', text: 'Meeting started' }
    return { kind: 'chat', label: 'Chat', text: sys[1].replace(/\(Recall bot ID:[^)]*\)/i, '').replace(/\s+/g, ' ').trim() || 'Session' }
  }
  if (/^<task-notification>/i.test(s) || /<task-id>/i.test(s)) {
    return { kind: 'task', label: 'Task', text: 'Background task run' }
  }
  return { kind: 'chat', label: 'Chat', text: s.replace(/\s+/g, ' ').trim() }
}

type Provider = 'gemini' | 'openai'
type VoiceArch = 'pipeline'

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
  const [showProfileMenu, setShowProfileMenu] = useState(false) // avatar dropdown (the universal profile-menu anchor): Settings · Library · Sign out

  // Session sharing (0.9.123) — Share modal + "Shared with me".
  const [shareTarget, setShareTarget] = useState<{ sessionId: string; title: string } | null>(null)
  const [shareEmail, setShareEmail] = useState('')
  const [shareBusy, setShareBusy] = useState(false)
  const [shareMsg, setShareMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [sharedWithMe, setSharedWithMe] = useState<SharedSession[]>([])
  const [importingId, setImportingId] = useState<string | null>(null)
  const [importMsg, setImportMsg] = useState<string | null>(null)
  const doShare = async () => {
    if (!shareTarget) return
    setShareBusy(true); setShareMsg(null)
    const res = await shareSession({ agentUrl, sessionId: shareTarget.sessionId, title: shareTarget.title, recipientEmail: shareEmail })
    setShareBusy(false)
    if (res.ok) { setShareMsg({ ok: true, text: `Shared with ${shareEmail.trim()} — it's in their "Shared with me".` }); setShareEmail('') }
    else setShareMsg({ ok: false, text: res.error })
  }
  const refreshSharedWithMe = useCallback(() => { listSharedWithMe().then(setSharedWithMe).catch(() => {}) }, [])
  useEffect(() => { refreshSharedWithMe() }, [refreshSharedWithMe])
  const doImport = async (share: SharedSession) => {
    setImportingId(share.id); setImportMsg(null)
    const res = await importSharedSession({ share, agentUrl })
    setImportingId(null)
    if (res.ok) {
      setSharedWithMe(prev => prev.filter(s => s.id !== share.id))
      setImportMsg(`Added "${share.session_title.slice(0, 40)}" — it's now in your sessions below.`)
    } else setImportMsg(res.error)
  }
  // Skills + named agents from the agent's HTTP API (GET /skills, GET /agents)
  // — the dashboard has no LiveKit data channel, so these come over HTTP.
  const [dashSkills, setDashSkills] = useState<{ name: string; description: string; folder?: string }[]>([])
  const [dashAgents, setDashAgents] = useState<{ name: string; description: string; model: string; tools: string[] }[]>([])
  // Per-user sync token — authorises calls to the agent's authed endpoints
  // (session import/export + /secrets). Declared here (before the settings
  // effect that depends on it) to avoid a TDZ reference.
  const [syncToken, setSyncToken] = useState<string | null>(null)
  // User-manageable API keys (agent /secrets) — status only, values never fetched.
  const [dashSecrets, setDashSecrets] = useState<{ key: string; set: boolean; secret: boolean; masked: string; source: 'store' | 'env' | 'none' }[]>([])
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({})
  const [savingSecret, setSavingSecret] = useState<string | null>(null)
  // Mobile ⋯ overflow menu — which project's action menu is open
  const [openProjectMenu, setOpenProjectMenu] = useState<string | null>(null)
  // Machine's physical location (Fly region from agent /health) — the user
  // wants to see WHERE the machine runs (city), not just their own clock.
  const [machineRegion, setMachineRegion] = useState<string | null>(() => {
    try { return typeof window !== 'undefined' ? localStorage.getItem('osborn-machine-region') : null } catch { return null }
  })
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
  // Turbo mode: per-user preference stored on instances.turbo. Only shown to
  // authenticated users. Reads on mount from /api/instance; writes via upsert.
  const [turbo, setTurbo] = useState(false)
  const [turboSaving, setTurboSaving] = useState(false)

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
    if (v === 'pipeline') setVoiceArch(v)  // ignore legacy 'direct'/'realtime' values
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
    // Connected API keys — status only (agent never returns raw values).
    // Requires the per-user sync token; older agents (<0.9.224) 404 and the
    // section just stays hidden.
    if (syncToken) {
      fetch(`${base}/secrets`, { headers: { 'Authorization': `Bearer ${syncToken}` } })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (Array.isArray(d?.secrets)) setDashSecrets(d.secrets) })
        .catch(() => {})
    }
  }, [showSettings, agentUrl, syncToken])

  // Machine location (agent /health region, 0.9.100+) — fetched whenever the
  // agent URL resolves, shown in the Cloud badge + machine card.
  useEffect(() => {
    // Only clear the region in genuine LOCAL mode. During cloud resolution the
    // agentUrl is transiently 'localhost' before the sandbox URL lands — don't
    // wipe the last-known city then (that flashed "Cloud" on mobile).
    if (connectionMode === 'local') { setMachineRegion(null); return }
    if (!agentUrl || agentUrl.startsWith('http://localhost')) return
    fetch(`${agentUrl.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(8000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.region) {
          const city = FLY_REGION_CITIES[d.region] || String(d.region).toUpperCase()
          setMachineRegion(city)
          try { localStorage.setItem('osborn-machine-region', city) } catch {}
        }
      })
      .catch(() => {})
  }, [agentUrl, connectionMode])

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

  const SESSIONS_CACHE_KEY = `osborn-sessions-cache-${agentUrl}`
  const SESSIONS_CACHE_TTL = 45_000  // 45s — fresh enough, avoids crawl on every tab open

  // Fetch sessions, with a localStorage TTL cache to skip the JSONL crawl on repeat loads.
  // Pass force=true to bypass the cache (after import/delete operations).
  const fetchSessions = useCallback(async (force = false) => {
    if (!canFetchAgent()) { setAgentOnline(false); setSessions([]); setBaseCwd(null); return }

    // Serve from cache if fresh and not forced
    if (!force) {
      try {
        const raw = localStorage.getItem(SESSIONS_CACHE_KEY)
        if (raw) {
          const { data, ts } = JSON.parse(raw)
          if (Date.now() - ts < SESSIONS_CACHE_TTL) {
            setSessions(data.sessions || [])
            setBaseCwd(typeof data.baseCwd === 'string' && data.baseCwd ? data.baseCwd : null)
            setAgentOnline(true)
            setSessionsLoading(false)
            return
          }
        }
      } catch {}
    }

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
      try { localStorage.setItem(SESSIONS_CACHE_KEY, JSON.stringify({ data, ts: Date.now() })) } catch {}
    } catch {
      setAgentOnline(false)
      setSessions([])
      setBaseCwd(null)
    } finally {
      setSessionsLoading(false)
    }
  }, [agentUrl, canFetchAgent, SESSIONS_CACHE_KEY, SESSIONS_CACHE_TTL])

  useEffect(() => { if (!loading) fetchSessions() }, [loading, fetchSessions])

  // Re-fetch sessions when machine transitions to running (auto-start from idle).
  // Without this, sessions stay empty if the initial fetch fires while the
  // machine is still stopped and the auto-start hasn't completed yet.
  const prevSandboxStatusRef = useRef<string | null>(null)
  useEffect(() => {
    if (sandboxStatus === 'running' && prevSandboxStatusRef.current !== 'running') {
      fetchSessions(true)
    }
    prevSandboxStatusRef.current = sandboxStatus
  }, [sandboxStatus, fetchSessions])

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
  //
  // AUTO-PROVISION: a fresh account (cloud available, no sandbox yet) gets a
  // machine assigned automatically (warm pool first, cold create fallback) —
  // unless the user explicitly chose Local. autoProvisionFiredRef guards
  // strict-mode double effects; the server's create is idempotent per user
  // (returns the existing sandbox / joins an in-flight create) for re-mounts
  // and multiple tabs.
  const autoProvisionFiredRef = useRef(false)
  useEffect(() => {
    if (loading || !user) return
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    const discover = (attempt: number) => {
      fetch('/api/sandbox').then(async r => {
        // Right after signup the auth cookie can lag the client session —
        // retry the first 401 once instead of leaving a blank dashboard.
        if (r.status === 401 && attempt === 0) {
          if (!cancelled) retryTimer = setTimeout(() => discover(1), 1500)
          return null
        }
        return r.json()
      })
      .then(d => {
        if (!d || cancelled) return
        setSandboxAvailable(d.available || false)
        if (d.available && !d.sandbox) {
          let explicitLocal = false
          try { explicitLocal = localStorage.getItem('osborn-connection-mode') === 'local' } catch {}
          if (!explicitLocal && !autoProvisionFiredRef.current) {
            autoProvisionFiredRef.current = true
            handleProvisionSandbox()
          }
        }
        if (d.sandbox) {
          setSandboxId(d.sandbox.id)
          setSandboxStatus(d.sandbox.status)
          // WARM-ON-LOAD (0.9.266): if the machine is idle-stopped, start warming
          // it the instant the dashboard loads — so by the time the user picks a
          // session, the ~24s cold boot is already overlapping their browsing.
          // Fire-and-forget; Fly's /start is idempotent so the chat-page connect
          // can't double-start, and the agent's 15-min idle self-exit reclaims it
          // if no session is opened.
          if (d.sandbox.id && d.sandbox.status && d.sandbox.status !== 'running') {
            fetch('/api/sandbox', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'start', sandboxId: d.sandbox.id }),
            }).catch(() => {})
          }
          // If a cloud sandbox exists, always switch to cloud — even if the
          // user previously clicked Local. Local mode is meaningless when a
          // Fly machine is provisioned (no local agent runs on the user's
          // device). Without this, a user who clicks Local to troubleshoot
          // gets permanently stuck: sandbox discovery sees 'local' in
          // localStorage and never overrides it.
          if (d.sandbox.previewUrl) {
            setConnectionMode('cloud')
            setAgentUrl(d.sandbox.previewUrl)
          }
        }
      })
      .catch(() => { if (!cancelled) setSandboxAvailable(false) })
    }
    discover(0)
    fetch('/api/instance')
      .then(r => r.json())
      .then(d => {
        if (d.instance?.sync_token) setSyncToken(d.instance.sync_token)
        if (typeof d.instance?.turbo === 'boolean') setTurbo(d.instance.turbo)
      })
      .catch(() => {})
    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // A sandbox is being created → the dashboard targets the cloud, not the
    // localhost default (shows the "Setting up your cloud workspace" spinner).
    setConnectionMode('cloud')
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
      } else if (data.id && data.status && data.status !== 'error') {
        // Idempotent create returned an existing, not-running machine — start it.
        setSandboxId(data.id)
        setSandboxStatus(data.status)
        if (data.previewUrl) setAgentUrl(data.previewUrl)
        const sr = await fetch('/api/sandbox', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'start', sandboxId: data.id }),
        })
        const started = await sr.json().catch(() => null)
        if (started?.previewUrl) {
          setSandboxStatus('running')
          setAgentUrl(started.previewUrl)
        }
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
  const [syncCopied, setSyncCopied] = useState(false)
  const [skillCopied, setSkillCopied] = useState(false)
  const [globalSyncCopied, setGlobalSyncCopied] = useState(false)
  const [deleteArmed, setDeleteArmed] = useState(false)
  const deleteArmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Toggle turbo mode: upsert instances.turbo for the current user.
  // Mirrors the user_agents upsert pattern (Supabase browser client + getUser).
  const handleTurboToggle = async () => {
    if (!user) return
    const next = !turbo
    setTurbo(next)
    setTurboSaving(true)
    try {
      await supabase.from('instances').update({ turbo: next }).eq('user_id', user.id)
    } catch {
      // revert on error
      setTurbo(!next)
    } finally {
      setTurboSaving(false)
    }
  }

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
    try { await supabase.auth.signOut() } catch {}
    // "Connect without account" users have NO Supabase session — the osborn-*
    // localStorage flags are what keep them connected, so signOut() alone is a
    // no-op and redirecting just bounces them straight back in. Clear the local
    // connection state so sign-out actually signs them out.
    try {
      ['osborn-setup-completed', 'osborn-agent-url', 'osborn-provider',
       'osborn-voice-arch', 'osborn-coding-agent', 'osborn-room-code']
        .forEach(k => localStorage.removeItem(k))
    } catch {}
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
        await fetchSessions(true)  // force-refresh after import — bypass cache
      }
    } finally {
      setImportingProject(null)
    }
  }

  // Refresh connected-key status from the agent (status only, no values).
  const refreshSecrets = async () => {
    if (!agentUrl || !syncToken) return
    try {
      const r = await fetch(`${agentUrl.replace(/\/$/, '')}/secrets`, {
        headers: { 'Authorization': `Bearer ${syncToken}` },
      })
      if (r.ok) {
        const d = await r.json()
        if (Array.isArray(d?.secrets)) setDashSecrets(d.secrets)
      }
    } catch { /* ignore */ }
  }

  // Set/rotate one user key. Writes the machine's volume store + live process.env
  // (takes effect on the agent's next read — no reboot). Empty value deletes.
  const handleSaveSecret = async (key: string) => {
    if (!agentUrl || !syncToken) return
    const value = (secretDrafts[key] ?? '').trim()
    setSavingSecret(key)
    try {
      const r = await fetch(`${agentUrl.replace(/\/$/, '')}/secrets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${syncToken}` },
        body: JSON.stringify({ [key]: value }),
      })
      if (r.ok) {
        const d = await r.json()
        if (Array.isArray(d?.secrets)) setDashSecrets(d.secrets)
        setSecretDrafts((prev) => { const next = { ...prev }; delete next[key]; return next })
      }
    } finally {
      setSavingSecret(null)
    }
  }

  const handleDeleteSecret = async (key: string) => {
    if (!agentUrl || !syncToken) return
    setSavingSecret(key)
    try {
      const r = await fetch(`${agentUrl.replace(/\/$/, '')}/secrets?key=${encodeURIComponent(key)}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${syncToken}` },
      })
      if (r.ok) {
        const d = await r.json()
        if (Array.isArray(d?.secrets)) setDashSecrets(d.secrets)
      } else {
        await refreshSecrets()
      }
    } finally {
      setSavingSecret(null)
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
        await fetchSessions(true)  // force-refresh after delete — bypass cache
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
    const base = (baseCwd || '/workspace').replace(/\/+$/, '')
    const projectPath = `${base}/${name}`
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
        <header className="sticky top-0 z-40 border-b border-[var(--border-subtle)] bg-[var(--background)]/80 backdrop-blur-md pt-[env(safe-area-inset-top)]">
          <div className="max-w-3xl lg:max-w-6xl mx-auto px-4 h-12 flex items-center justify-between">
            {/* Logo → home (voice-native.com). Clickable from the dashboard back to root. */}
            <Link href="/" title="Home" className="flex items-center gap-3 rounded-lg -mx-1 px-1 py-0.5 hover:opacity-80 transition-opacity">
              <div className="w-7 h-7 rounded-full flex items-center justify-center"
                style={{ background: 'linear-gradient(135deg, var(--accent) 0%, var(--accent-dim) 100%)' }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--background)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                </svg>
              </div>
              <span className="hidden sm:inline font-display text-[var(--text-primary)] font-semibold text-[16px] tracking-tight">Voice Native</span>
            </Link>

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
                {/* Mobile: one word (dot carries the state); desktop: full detail
                    incl. the machine's physical city (user ask 2026-08-01). */}
                <span className="text-[11px] text-[var(--text-muted)] whitespace-nowrap">
                  <span className="sm:hidden">{isCloud ? (machineRegion || 'Cloud') : 'Local'}</span>
                  <span className="hidden sm:inline">
                    {isCloud
                      ? `${sandboxStatus ? `Cloud (${sandboxStatus})` : 'Cloud'}${machineRegion ? ` · ${machineRegion}` : ''}`
                      : agentOnline ? 'Local' : agentOnline === false ? 'Local (offline)' : 'Local'
                    }
                  </span>
                </span>
              </div>

              {/* Copy sync info — desktop only (mobile: in project ⋯ menus) */}
              <button
                onClick={handleCopyGlobalSyncInfo}
                title="Copy sync info"
                className={`hidden sm:block p-2 rounded-lg transition-all ${
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

              {/* Avatar → profile dropdown — the universal top-right anchor
                  (Google/Claude/ChatGPT). One glance, zero learning curve:
                  Settings · Library · Sign out. Replaces the old behavior where
                  the avatar dumped the whole settings sheet. */}
              <div className="relative shrink-0">
                <button onClick={() => setShowProfileMenu(s => !s)} title="Account"
                  aria-haspopup="menu" aria-expanded={showProfileMenu}
                  className={`shrink-0 p-1 rounded-full transition-all ${showProfileMenu ? 'bg-[var(--accent-dim)]/20 ring-1 ring-[var(--accent)]/50' : 'hover:bg-[var(--surface)]'}`}>
                  {user?.user_metadata?.avatar_url ? (
                    <img src={user.user_metadata.avatar_url} alt="" className={`w-7 h-7 rounded-full object-cover shrink-0 ring-1 ${showProfileMenu ? 'ring-[var(--accent)]' : 'ring-[var(--border)]'}`} />
                  ) : user?.email ? (
                    <div className="w-7 h-7 rounded-full bg-[var(--accent-dim)] flex items-center justify-center text-[11px] font-semibold text-[var(--background)]">
                      {user.email[0].toUpperCase()}
                    </div>
                  ) : (
                    <div className="w-7 h-7 rounded-full bg-[var(--surface-2)] flex items-center justify-center text-[var(--text-muted)]">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
                    </div>
                  )}
                </button>
                {showProfileMenu && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setShowProfileMenu(false)} />
                    <div role="menu"
                      className="absolute right-0 top-full mt-2 z-50 w-56 rounded-xl bg-[var(--surface)] border border-[var(--border-subtle)] shadow-2xl overflow-hidden origin-top-right"
                      style={{ animation: 'fadeSlideIn .12s ease both' }}>
                      <div className="px-3.5 py-2.5 border-b border-[var(--border-subtle)]">
                        <p className="text-[11px] text-[var(--text-muted)] uppercase tracking-wider">{user?.email ? 'Signed in' : 'Guest session'}</p>
                        <p className="text-sm text-[var(--text-primary)] truncate">{user?.email || 'No account connected'}</p>
                      </div>
                      <button role="menuitem"
                        onClick={() => { setShowProfileMenu(false); router.push('/settings') }}
                        className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] transition-colors">
                        <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                        Settings
                      </button>
                      <Link role="menuitem" href="/library"
                        onClick={() => setShowProfileMenu(false)}
                        className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] transition-colors">
                        <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" /></svg>
                        Library
                      </Link>
                      <div className="h-px bg-[var(--border-subtle)] mx-2 my-1" />
                      <button role="menuitem"
                        onClick={() => { setShowProfileMenu(false); signOut() }}
                        className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left text-sm text-red-400 hover:bg-red-500/10 transition-colors">
                        <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
                        {user?.email ? 'Sign out' : 'Exit guest session'}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </header>


        {/* ── Content ──────────────────────────────────
            Desktop (lg+): a two-region workspace — a sticky LEFT SIDEBAR nav
            rail (projects + shared) beside a MAIN column (greeting, continue,
            CTA, action cards). The overall grid spans ~max-w-7xl so the sides
            aren't empty, while the main content stays readable (~max-w-3xl).
            Mobile/tablet (<lg): the grid collapses to a single column and
            `order-*` restores the original top-to-bottom flow
            (greeting → continue → new conversation → projects). Same data,
            same handlers — layout only. */}
        <div className="flex-1 w-full max-w-3xl lg:max-w-6xl mx-auto px-4 py-6 lg:grid lg:grid-cols-[320px_minmax(0,1fr)] lg:gap-8 lg:items-start lg:py-8">

          {/* ── MAIN column (desktop) / primary stack (mobile) ── */}
          <div className="order-1 lg:order-2 w-full lg:max-w-3xl lg:mx-auto">

          {/* Serif greeting — only in the empty state. Once there's a Continue
              card (sessions exist), the greeting is redundant with it, so we
              drop it and let Continue be the single orienting header. */}
          {!(agentOnline !== false && sessions.length > 0) && (
            <div className="mb-4 mt-1" style={{ animation: 'fadeSlideIn .4s ease both' }}>
              <h1 className="font-display text-[26px] sm:text-3xl font-medium text-[var(--text-primary)] leading-tight">
                {(() => { const h = new Date().getHours(); return h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening' })()}
                {user?.user_metadata?.full_name ? `, ${String(user.user_metadata.full_name).split(' ')[0]}` : ''}.
              </h1>
              <p className="mt-1 text-[13px] text-[var(--text-secondary)]">What should we look into?</p>
            </div>
          )}

          {/* Continue where you left off — featured resume of the most-recent
              session (agenda-card idiom: one clear primary action using real
              data, surfaced above the full list). */}
          {agentOnline !== false && sessions.length > 0 && (() => {
            const recent = [...sessions].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0]
            if (!recent) return null
            const pv = prettySessionPreview(recent.lastMessage)
            return (
              <button onClick={() => startChat(recent.sessionId, recent.cwd)}
                className="w-full mb-3 flex items-center gap-3.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] px-4 py-3.5 text-left hover:border-[var(--accent-dim)]/50 hover:bg-[var(--surface-2)]/40 transition-all group"
                style={{ animation: 'fadeSlideIn .45s ease both' }}>
                <div className="w-10 h-10 rounded-xl bg-[var(--accent-dim)]/20 flex items-center justify-center shrink-0 text-[var(--accent)]">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" /><path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--accent)]">Continue</span>
                    <span className="text-[11px] text-[var(--text-muted)]">{formatDate(recent.timestamp)}</span>
                  </div>
                  <div className="text-sm font-medium text-[var(--text-primary)] truncate mt-0.5">{pv.text}</div>
                </div>
                <svg className="w-5 h-5 shrink-0 text-[var(--text-muted)] group-hover:text-[var(--accent)] group-hover:translate-x-0.5 transition-all" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
              </button>
            )
          })()}

          {/* New chat button — primary amber CTA (both mobile + desktop) */}
          <button onClick={() => startChat()}
            className="w-full h-11 rounded-lg font-semibold text-[14px] tracking-[-0.01em] transition-all duration-150 active:scale-[0.99] mb-5 flex items-center justify-center gap-2"
            style={{
              background: 'var(--accent)',
              color: 'var(--background)',
            }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
              <line x1="12" y1="19" x2="12" y2="23"/>
            </svg>
            New conversation
          </button>

          {/* Agenda-card action stack — DESKTOP ONLY (lg+). Keeps ≤3 primary
              actions visible: the amber CTA above + these two. Each is a single
              clear action in the icon + title + description + arrow idiom.
              Hidden on mobile so the phone flow stays the lean single column. */}
          {agentOnline !== false && (
            <div className="hidden lg:flex lg:flex-col gap-2.5 mb-6" style={{ animation: 'fadeSlideIn .5s ease both' }}>
              {/* Resume a session — jumps straight into the most-recent session
                  if one exists; otherwise falls back to a fresh conversation. */}
              <button
                onClick={() => {
                  const recent = [...sessions].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0]
                  if (recent) startChat(recent.sessionId, recent.cwd)
                  else startChat()
                }}
                className="group w-full flex items-center gap-3.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] px-4 py-3.5 text-left hover:border-[var(--accent-dim)]/50 hover:bg-[var(--surface-2)]/40 transition-all"
              >
                <div className="w-9 h-9 rounded-lg bg-[var(--surface-2)] flex items-center justify-center shrink-0 text-[var(--text-secondary)] group-hover:text-[var(--accent)] transition-colors">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M3 10h11M9 21V3m-6 7l4-4m-4 4l4 4" /><path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-9-9" /></svg>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-[var(--text-primary)]">Resume a session</div>
                  <div className="text-[12px] text-[var(--text-muted)] truncate">{sessions.length > 0 ? 'Pick up your most recent conversation' : 'Start a fresh conversation'}</div>
                </div>
                <svg className="w-5 h-5 shrink-0 text-[var(--text-muted)] group-hover:text-[var(--accent)] group-hover:translate-x-0.5 transition-all" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
              </button>

              {/* Browse your library → /library */}
              <Link
                href="/library"
                className="group w-full flex items-center gap-3.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] px-4 py-3.5 text-left hover:border-[var(--accent-dim)]/50 hover:bg-[var(--surface-2)]/40 transition-all"
              >
                <div className="w-9 h-9 rounded-lg bg-[var(--surface-2)] flex items-center justify-center shrink-0 text-[var(--text-secondary)] group-hover:text-[var(--accent)] transition-colors">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" /></svg>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-[var(--text-primary)]">Browse your library</div>
                  <div className="text-[12px] text-[var(--text-muted)] truncate">Saved outputs, documents, and references</div>
                </div>
                <svg className="w-5 h-5 shrink-0 text-[var(--text-muted)] group-hover:text-[var(--accent)] group-hover:translate-x-0.5 transition-all" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
              </Link>
            </div>
          )}

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

          </div>{/* ── end MAIN column ── */}

          {/* ── LEFT SIDEBAR (desktop) / projects stack (mobile) ──
              The projects nav rail. On lg+ it becomes a sticky, bordered left
              rail (`order-1`, its own subtle surface) filling the left real
              estate; below lg it's `order-2` with no chrome — the plain
              single-column projects list that shipped before. Same markup,
              same handlers; CSS/grid decides where it lives. */}
          <aside className="order-2 lg:order-1 w-full lg:sticky lg:top-[4.5rem] lg:self-start lg:max-h-[calc(100dvh-5.5rem)] lg:overflow-y-auto lg:rounded-2xl lg:border lg:border-[var(--border-subtle)] lg:bg-[var(--surface)]/40 lg:p-3 mt-6 lg:mt-0">

          {/* Projects section — only shown when agent is reachable */}
          {agentOnline !== false && (
            <div>
              <div className="flex items-center justify-between mb-2 lg:px-1">
                <h2 className="text-[var(--text-secondary)] text-xs font-medium uppercase tracking-wider">Projects</h2>
                <div className="flex items-center gap-2">
                  {sessionsLoading && (
                    <div className="w-3 h-3 border border-[var(--border)] border-t-[var(--accent)] rounded-full animate-spin" />
                  )}
                  {!showNewProject && (
                    <button
                      onClick={() => setShowNewProject(true)}
                      className="text-xs font-medium text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors px-1.5 py-0.5 rounded"
                    >
                      + New project
                    </button>
                  )}
                </div>
              </div>

              {/* New Project input — shown only while naming (the trigger lives in the section header) */}
              {showNewProject && (
              <div className="mb-3">
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
                ) : null}
              </div>
              )}

              {/* Shared with me (0.9.123) */}
              {(sharedWithMe.length > 0 || importMsg) && (
                <div className="mb-3 rounded-2xl border border-[var(--accent-dim)]/30 bg-[var(--accent-dim)]/[0.06] p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <svg className="w-4 h-4 text-[var(--accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" /></svg>
                    <span className="text-sm font-semibold text-[var(--text-primary)]">Shared with me</span>
                  </div>
                  {importMsg && <p className="text-xs text-[var(--text-muted)] mb-2">{importMsg}</p>}
                  <div className="space-y-1.5">
                    {sharedWithMe.map((share) => (
                      <div key={share.id} className="flex items-center justify-between gap-3 p-2.5 rounded-xl bg-[var(--surface-2)]/60">
                        <div className="min-w-0">
                          <p className="text-sm text-[var(--text-primary)] truncate">{share.session_title}</p>
                          <p className="text-[11px] text-[var(--text-muted)]">from {share.owner_email}</p>
                        </div>
                        <button
                          onClick={() => doImport(share)}
                          disabled={importingId === share.id || !agentOnline}
                          title={!agentOnline ? 'Connect your machine first' : 'Add to my sessions'}
                          className="shrink-0 px-3 py-1.5 text-xs bg-[var(--accent-dim)]/25 text-[var(--accent)] rounded-lg hover:bg-[var(--accent-dim)]/40 disabled:opacity-50 transition-colors"
                        >
                          {importingId === share.id ? 'Adding…' : 'Add to my sessions'}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Share modal (0.9.123) */}
              {shareTarget && (
                <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 p-4" onClick={() => !shareBusy && setShareTarget(null)}>
                  <div className="w-full max-w-sm bg-[var(--surface)] border border-[var(--border)] rounded-2xl shadow-2xl p-5" onClick={(e) => e.stopPropagation()}>
                    <h3 className="text-lg font-semibold text-[var(--text-primary)] mb-1">Share session</h3>
                    <p className="text-sm text-[var(--text-muted)] mb-4 line-clamp-2">{shareTarget.title}</p>
                    <label className="block text-xs font-medium text-[var(--text-muted)] mb-1.5">Recipient email</label>
                    <input
                      type="email"
                      autoFocus
                      value={shareEmail}
                      onChange={(e) => setShareEmail(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && !shareBusy && shareEmail.trim()) doShare() }}
                      placeholder="person@example.com"
                      className="w-full px-3 py-2 text-sm bg-[var(--surface-2)] border border-[var(--border-subtle)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
                    />
                    {shareMsg && <p className={`mt-2 text-sm ${shareMsg.ok ? 'text-emerald-400' : 'text-red-400'}`}>{shareMsg.text}</p>}
                    <div className="flex items-center justify-end gap-2 mt-4">
                      <button onClick={() => setShareTarget(null)} disabled={shareBusy} className="px-3 py-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-50">Close</button>
                      <button onClick={doShare} disabled={shareBusy || !shareEmail.trim()} className="px-4 py-1.5 text-sm bg-[var(--accent)] text-[var(--background)] font-medium rounded-lg hover:opacity-90 disabled:opacity-50 transition-opacity">{shareBusy ? 'Sharing…' : 'Share'}</button>
                    </div>
                    <p className="mt-3 text-[11px] text-[var(--text-muted)] leading-relaxed">They get their own copy under &ldquo;Shared with me&rdquo; — it becomes an independent session on their account.</p>
                  </div>
                </div>
              )}

              {/* Project list */}
              {sessionsLoading ? (
                <div className="flex justify-center py-8">
                  <div className="w-5 h-5 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
                </div>
              ) : sessions.length === 0 && agentOnline ? (
                <p className="px-4 text-sm text-[var(--muted)]">No conversations yet</p>
              ) : (
                <div className="rounded-xl border border-[var(--border-subtle)]/60 bg-[var(--surface)] divide-y divide-[var(--border-subtle)]/40">{/* Slack-style flush list: one bordered container, rows divided by hairlines — replaces the old per-project bubble cards (space-y-2 + rounded-2xl each) */}
                  {groupByProject(sessions, baseCwd).map(project => (
                    <div key={project.cwd} className={`relative transition-colors first:rounded-t-xl last:rounded-b-xl ${openProjectMenu === project.cwd ? 'z-30' : 'z-0'} ${expandedProjects.has(project.cwd) ? 'bg-[var(--surface-2)]/30' : 'hover:bg-[var(--surface-2)]/40'}`}>{/* relative + z-30 when its ⋯ menu is open so the dropdown floats ABOVE sibling rows (was ghosting through them). no overflow-hidden — it clipped the dropdown */}
                      {/* Project header row */}
                      <div className={`relative flex items-center gap-3 px-3 py-2.5 ${openProjectMenu === project.cwd ? 'z-40' : ''}`}>
                        <button
                          className="flex-1 flex items-center gap-3 text-left min-w-0 group/proj"
                          onClick={() => toggleProject(project.cwd)}
                        >
                          <div className="w-8 h-8 rounded-lg bg-[var(--surface-2)] flex items-center justify-center flex-shrink-0 text-sm transition-all">
                            {project.name === 'General' ? '📁' : '🗂️'}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-semibold capitalize truncate text-[var(--text-primary)]">{project.name}</div>
                            <div className="text-xs text-[var(--muted)] mt-0.5 flex items-center gap-1.5">
                              <span className="px-1.5 py-px rounded-full bg-[var(--surface-2)] text-[var(--text-secondary)] font-medium text-[10px]">{project.sessions.length} session{project.sessions.length !== 1 ? 's' : ''}</span>
                              <span className="opacity-40">·</span>
                              <span>{formatDate(project.lastActive)}</span>
                            </div>
                          </div>
                          <svg
                            className={`w-4 h-4 flex-shrink-0 transition-transform ${expandedProjects.has(project.cwd) ? 'rotate-90 text-[var(--accent)]' : 'text-[var(--muted)]'}`}
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
                          <div className="hidden">
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
                          {/* ⋯ overflow menu — labeled actions (Export / Import /
                              Copy sync / Delete), on all widths so the header row
                              stays clean (just + and expand) instead of a crowded
                              strip of unlabeled icons. */}
                          <div className="relative">
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

                      {/* Expanded session list — cards with staggered reveal */}
                      {expandedProjects.has(project.cwd) && (
                        <div className="border-t border-[var(--border-subtle)]/40 py-1">{/* flat nested rows (Slack-style) — no per-session bubble cards, no stagger/lift animation */}
                          {(expandedSessionLists.has(project.cwd)
                            ? project.sessions
                            : project.sessions.slice(0, 15)
                          ).map((s) => { const pv = prettySessionPreview(s.lastMessage); return (
                            <div
                              key={s.sessionId}
                              className="relative hover:bg-[var(--surface-2)]/50 transition-colors group/sess"
                            >
                              <button
                                onClick={() => startChat(s.sessionId, s.cwd)}
                                className="w-full pl-[44px] pr-3 py-2 text-left"
                              >
                                <div className="flex items-start gap-2.5 pr-9">
                                  <div className={`mt-0.5 w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0 transition-colors ${pv.kind === 'meeting' ? 'bg-[var(--accent-dim)]/20 text-[var(--accent)]' : pv.kind === 'task' ? 'bg-[var(--surface-2)] text-[var(--text-muted)]' : 'bg-[var(--surface-2)] text-[var(--text-secondary)] group-hover/sess:text-[var(--accent)]'}`}>
                                    {pv.kind === 'meeting' ? (
                                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                                    ) : pv.kind === 'task' ? (
                                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                                    ) : (
                                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4-.84L3 20l1.16-3.48A7.9 7.9 0 013 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
                                    )}
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <div className="text-[13px] font-medium text-[var(--text-primary)] line-clamp-1">
                                      {pv.text}
                                    </div>
                                    <div className="text-[11px] text-[var(--text-muted)] mt-0.5 flex items-center gap-1.5">
                                      {pv.kind !== 'chat' && (
                                        <span className={`px-1.5 py-px rounded-full text-[10px] font-medium ${pv.kind === 'meeting' ? 'bg-[var(--accent-dim)]/20 text-[var(--accent)]' : 'bg-[var(--surface)] text-[var(--text-muted)]'}`}>{pv.label}</span>
                                      )}
                                      <span>{formatDate(s.timestamp)}</span>
                                      {s.messageCount ? (
                                        <>
                                          <span className="opacity-40">·</span>
                                          <span className="font-mono">{s.messageCount} msgs</span>
                                        </>
                                      ) : null}
                                    </div>
                                  </div>
                                </div>
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); setShareTarget({ sessionId: s.sessionId, title: s.lastMessage || 'Shared session' }); setShareEmail(''); setShareMsg(null) }}
                                title="Share this session with another user"
                                className="absolute top-1/2 -translate-y-1/2 right-2 p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--surface)] transition-all"
                              >
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" /></svg>
                              </button>
                            </div>
                          )})}
                          {project.sessions.length > 15 && !expandedSessionLists.has(project.cwd) && (
                            <button
                              onClick={() => setExpandedSessionLists(s => { const n = new Set(s); n.add(project.cwd); return n })}
                              className="w-full px-3 py-2 text-[11px] font-medium text-[var(--accent)] rounded-xl hover:bg-[var(--surface-2)] transition-colors text-center"
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
          </aside>{/* ── end LEFT SIDEBAR ── */}
        </div>
      </main>
    </>
  )
}
