'use client'

import { useState, useEffect, useCallback } from 'react'
import { createSupabaseBrowser } from '@/lib/supabase-browser'
import type { User } from '@supabase/supabase-js'
import { useRouter } from 'next/navigation'

interface SessionInfo {
  sessionId: string
  timestamp: string
  lastMessage?: string
  messageCount?: number
  // The cwd the session was originally created with. Critical for resume:
  // sessions live at ~/.claude/projects/<slug>/<sessionId>.jsonl where <slug>
  // is derived from the cwd, so the agent must boot with the matching cwd or
  // the session lookup goes to the wrong directory ("Session not found").
  cwd?: string
}

type Provider = 'gemini' | 'openai'
type VoiceArch = 'pipeline' | 'direct' | 'realtime'

export default function Dashboard() {
  const router = useRouter()
  const supabase = createSupabaseBrowser()
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [agentUrl, setAgentUrl] = useState('http://localhost:8741')
  const [agentOnline, setAgentOnline] = useState<boolean | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [installedVersion, setInstalledVersion] = useState<string | null>(null)
  const [latestVersion, setLatestVersion] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<{ text: string; type: 'success' | 'error' | 'info' } | null>(null)
  const [sandboxAvailable, setSandboxAvailable] = useState(false)
  const [sandboxStatus, setSandboxStatus] = useState<string | null>(null)
  const [sandboxId, setSandboxId] = useState<string | null>(null)
  const [provisioning, setProvisioning] = useState(false)
  const PAGE_SIZE = 20
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)

  const [localAgentUrl] = useState('http://localhost:8741')
  const [connectionMode, setConnectionMode] = useState<'local' | 'cloud'>('local')

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
    if (m) setConnectionMode(m)
  }, [])

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
    if (!canFetchAgent()) { setAgentOnline(false); setSessions([]); return }
    setSessionsLoading(true)
    try {
      const r = await fetch(`${agentUrl}/sessions`)
      const data = await r.json()
      setSessions(data.sessions || [])
      setAgentOnline(true)
    } catch {
      setAgentOnline(false)
      setSessions([])
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
          const savedMode = localStorage.getItem('osborn-connection-mode')
          if (savedMode === 'cloud' && d.sandbox.previewUrl) {
            setConnectionMode('cloud')
            setAgentUrl(d.sandbox.previewUrl)
          }
        }
      })
      .catch(() => setSandboxAvailable(false))
  }, [user, loading])

  const isCloud = connectionMode === 'cloud'

  // Check installed vs latest osborn version when cloud agent comes online
  useEffect(() => {
    if (agentOnline && isCloud && sandboxId) {
      checkVersion()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentOnline, isCloud, sandboxId])

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

  const handleDeleteSandbox = async () => {
    if (!sandboxId) return
    try { await fetch('/api/sandbox', { method: 'DELETE' }) } catch {}
    setSandboxId(null)
    setSandboxStatus(null)
    setConnectionMode('local')
    setAgentUrl(localAgentUrl)
  }

  const handleRestart = async () => {
    setRestarting(true)
    setStatusMessage(null)
    try {
      const result = await fetch('/api/sandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'restart-service', sandboxId })
      }).then(r => r.json()).catch(() => ({ success: false }))
      if (result.success === false) {
        setStatusMessage({ text: 'Restart failed', type: 'error' })
        setRestarting(false)
        return
      }
      // poll health
      const poll = setInterval(async () => {
        try {
          const r = await fetch(`${agentUrl}/health`, { signal: AbortSignal.timeout(2000) })
          if (r.ok) {
            clearInterval(poll)
            setRestarting(false)
            setAgentOnline(true)
            setStatusMessage({ text: 'Agent is back online', type: 'success' })
            checkVersion()
            setTimeout(() => setStatusMessage(null), 4000)
          }
        } catch {}
      }, 2000)
      setTimeout(() => { clearInterval(poll); setRestarting(false) }, 60000)
    } catch {
      setRestarting(false)
    }
  }

  const handleUpdate = async () => {
    if (!sandboxId) return
    setUpdating(true)
    setStatusMessage(null)
    try {
      const result = await fetch('/api/sandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update-osborn', sandboxId }),
      }).then(r => r.json()).catch(() => ({ success: false }))
      if (result.success === false) {
        setStatusMessage({ text: result.error || 'Update failed', type: 'error' })
        setUpdating(false)
        return
      }
      // updateOsborn already waited for /health server-side — no client-side poll needed.
      // Use the version returned by the API to update the badge immediately.
      const newVersion = result.version as string | null
      if (newVersion) setInstalledVersion(newVersion)
      setUpdating(false)
      setAgentOnline(true)
      setStatusMessage({ text: `Updated to v${newVersion || latestVersion || 'latest'}`, type: 'success' })
      checkVersion()
      setTimeout(() => setStatusMessage(null), 4000)
    } catch {
      setUpdating(false)
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
                  {agentOnline && !restarting && !updating && (
                    <button onClick={handleRestart}
                      className="text-[11px] text-[var(--text-muted)] hover:text-red-400 transition-colors">
                      Restart agent
                    </button>
                  )}
                  {agentOnline && !restarting && !updating && isCloud && (
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
                  {restarting && <span className="text-[11px] text-amber-400 animate-pulse">Restarting...</span>}
                  {updating && <span className="text-[11px] text-sky-400 animate-pulse">Updating...</span>}
                  {statusMessage && (
                    <p className={`text-[11px] ${statusMessage.type === 'success' ? 'text-green-400' : statusMessage.type === 'error' ? 'text-red-400' : 'text-sky-400'}`}>
                      {statusMessage.text}
                    </p>
                  )}
                </div>
                </div>

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
                  <div className="flex items-center justify-between bg-[var(--surface)] rounded-xl px-3 py-2.5 border border-[var(--border-subtle)]">
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
                      <button onClick={handleDeleteSandbox}
                        className="text-[11px] text-[var(--text-muted)] hover:text-red-400 px-2 py-1 rounded-lg hover:bg-red-400/10 transition-all"
                        title="Delete sandbox and switch to local">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                        </svg>
                      </button>
                    </div>
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

          {/* Recent chats */}
          <div className="space-y-3">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-[var(--text-secondary)] text-xs font-medium uppercase tracking-wider">Recent</h2>
              {sessionsLoading && (
                <div className="w-3 h-3 border border-[var(--border)] border-t-[var(--accent)] rounded-full animate-spin" />
              )}
            </div>

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

            {agentOnline && sessions.length === 0 && !sessionsLoading && (
              <div className="text-center py-12" style={{ animation: 'fadeIn 0.3s ease both' }}>
                <p className="text-[var(--text-muted)] text-sm">No conversations yet</p>
                <p className="text-[var(--text-muted)] text-xs mt-1 opacity-60">Start a new conversation to begin</p>
              </div>
            )}

            {sessions.slice(0, visibleCount).map((s, i) => (
              <button key={s.sessionId} onClick={() => startChat(s.sessionId, s.cwd)}
                className="w-full text-left p-4 rounded-2xl bg-[var(--surface)] border border-[var(--border-subtle)] hover:border-[var(--border)] transition-all group"
                style={{ animation: `enter 0.3s ease ${Math.min(i, 10) * 0.04}s both` }}>
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                    style={{ background: 'linear-gradient(135deg, var(--surface-raised) 0%, var(--border) 100%)' }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                    </svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[var(--text-primary)] text-[14px] leading-relaxed line-clamp-2">
                      {s.lastMessage || 'New conversation'}
                    </p>
                    <div className="flex items-center gap-2 mt-2">
                      <span className="text-[var(--text-muted)] text-[11px]">{formatDate(s.timestamp)}</span>
                      {s.messageCount ? (
                        <span className="text-[var(--text-muted)] text-[11px] bg-[var(--surface-raised)] px-1.5 py-0.5 rounded-full">
                          {s.messageCount} messages
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <svg className="w-4 h-4 text-[var(--text-muted)] opacity-0 group-hover:opacity-60 transition-opacity shrink-0 mt-3"
                    viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="9 18 15 12 9 6"/>
                  </svg>
                </div>
              </button>
            ))}

            {sessions.length > visibleCount && (
              <button onClick={() => setVisibleCount(c => c + PAGE_SIZE)}
                className="w-full py-3 mt-2 rounded-xl text-[var(--text-secondary)] text-sm hover:text-[var(--text-primary)] hover:bg-[var(--surface)] transition-all">
                Show more ({sessions.length - visibleCount} remaining)
              </button>
            )}

            {sessions.length > 0 && (
              <p className="text-center text-[var(--text-muted)] text-[11px] mt-4 pb-4">
                {sessions.length} conversation{sessions.length !== 1 ? 's' : ''}
              </p>
            )}
          </div>
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
