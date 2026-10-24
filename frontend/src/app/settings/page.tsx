'use client'

import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react'
import { MagnifyingGlass, Brain, PenNib, Robot } from '@phosphor-icons/react'
import { createSupabaseBrowser } from '@/lib/supabase-browser'
import type { User } from '@supabase/supabase-js'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { SettingsSection, SettingsRow, Switch } from '@/components/settings/ui'
import DeleteSandboxDialog from '@/components/settings/DeleteSandboxDialog'

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

type Provider = 'gemini' | 'openai'
type VoiceArch = 'pipeline'

// The settings nav groups — "You" (account-centric) and "Your Machine"
// (environment-centric). Each item scrolls/drills to a section id.
type SectionId = 'account' | 'voice' | 'preferences' | 'environment' | 'keys' | 'agents'
const NAV_GROUPS: { group: string; items: { id: SectionId; label: string }[] }[] = [
  {
    group: 'You',
    items: [
      { id: 'account', label: 'Account' },
      { id: 'voice', label: 'Voice & Audio' },
      { id: 'preferences', label: 'Preferences' },
    ],
  },
  {
    group: 'Your Machine',
    items: [
      { id: 'environment', label: 'Environment' },
      { id: 'keys', label: 'API Keys' },
      { id: 'agents', label: 'Agents & Skills' },
    ],
  },
]

export default function SettingsPage() {
  const router = useRouter()
  const supabase = createSupabaseBrowser()
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  // ── Agent connection + machine state (identical model to the dashboard) ──
  const [agentUrl, setAgentUrl] = useState('http://localhost:8741')
  const [agentOnline, setAgentOnline] = useState<boolean | null>(null)
  const [dashSkills, setDashSkills] = useState<{ name: string; description: string; folder?: string }[]>([])
  const [dashAgents, setDashAgents] = useState<{ name: string; description: string; model: string; tools: string[] }[]>([])
  const [syncToken, setSyncToken] = useState<string | null>(null)
  const [dashSecrets, setDashSecrets] = useState<{ key: string; set: boolean; secret: boolean; masked: string; source: 'store' | 'env' | 'none' }[]>([])
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({})
  const [savingSecret, setSavingSecret] = useState<string | null>(null)
  const [machineRegion, setMachineRegion] = useState<string | null>(() => {
    try { return typeof window !== 'undefined' ? localStorage.getItem('osborn-machine-region') : null } catch { return null }
  })
  const [installedVersion, setInstalledVersion] = useState<string | null>(null)
  const [latestVersion, setLatestVersion] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<{ text: string; type: 'success' | 'error' | 'info' } | null>(null)

  type LayerReport = {
    persistentSessionCount: number
    persistentTotalJsonl: number
    persistentBytes: number
    containerSessionCount: number
    mismatch: boolean
    projects: Array<{ slug: string; jsonlCount: number; bigJsonlCount: number; totalBytes: number }>
  }
  const [layerReport, setLayerReport] = useState<LayerReport | null>(null)

  type Operation = {
    kind: 'restart' | 'update'
    stage: 'starting' | 'installing' | 'verifying' | 'snapshotting'
    startedAt: number
    targetVersion?: string
  }
  const [operation, setOperation] = useState<Operation | null>(null)
  const [opElapsed, setOpElapsed] = useState(0)

  useEffect(() => {
    if (!operation) { setOpElapsed(0); return }
    const id = setInterval(() => setOpElapsed(Math.floor((Date.now() - operation.startedAt) / 1000)), 1000)
    return () => clearInterval(id)
  }, [operation])

  const restarting = operation?.kind === 'restart'
  const updating = operation?.kind === 'update'
  const [sandboxAvailable, setSandboxAvailable] = useState(false)
  const [sandboxStatus, setSandboxStatus] = useState<string | null>(null)
  const [sandboxId, setSandboxId] = useState<string | null>(null)
  const [provisioning, setProvisioning] = useState(false)
  const [localAgentUrl] = useState('http://localhost:8741')
  const [connectionMode, setConnectionMode] = useState<'local' | 'cloud'>('cloud')

  // Prefs
  const [provider, setProvider] = useState<Provider>('gemini')
  const [voiceArch, setVoiceArch] = useState<VoiceArch>('pipeline')
  const [turbo, setTurbo] = useState(false)
  const [turboSaving, setTurboSaving] = useState(false)
  const [autoApprove, setAutoApprove] = useState(false)

  const [syncCopied, setSyncCopied] = useState(false)
  const [globalSyncCopied, setGlobalSyncCopied] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)

  // Active nav item (desktop scroll-spy intent) + mobile drill-in.
  const [activeSection, setActiveSection] = useState<SectionId>('account')
  const [mobileSection, setMobileSection] = useState<SectionId | null>(null)
  const sectionRefs = useRef<Partial<Record<SectionId, HTMLDivElement | null>>>({})

  // ── Auth: redirect out if there's no user (settings is account-centric) ──
  useEffect(() => {
    const timeout = setTimeout(() => setLoading(false), 3000)
    supabase.auth.getUser().then(({ data: { user } }) => {
      clearTimeout(timeout)
      setUser(user)
      setLoading(false)
      if (!user) router.replace('/login')
    }).catch(() => { clearTimeout(timeout); setLoading(false) })
  }, [])

  // Load prefs
  useEffect(() => {
    const u = localStorage.getItem('osborn-agent-url')
    const p = localStorage.getItem('osborn-provider') as Provider | null
    const v = localStorage.getItem('osborn-voice-arch') as VoiceArch | null
    const m = localStorage.getItem('osborn-connection-mode') as 'local' | 'cloud' | null
    const a = localStorage.getItem('osborn-auto-approve')
    if (u) setAgentUrl(u)
    if (p) setProvider(p)
    if (v === 'pipeline') setVoiceArch(v)
    if (m) setConnectionMode(m)
    if (a === 'true') setAutoApprove(true)
  }, [])

  // Fetch skills + named agents + secrets from the agent's HTTP API on load.
  useEffect(() => {
    if (!agentUrl) return
    const base = agentUrl.replace(/\/$/, '')
    fetch(`${base}/skills`).then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (Array.isArray(d?.skills)) setDashSkills(d.skills) })
      .catch(() => {})
    fetch(`${base}/agents`).then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (Array.isArray(d?.agents)) setDashAgents(d.agents) })
      .catch(() => {})
    if (syncToken) {
      fetch(`${base}/secrets`, { headers: { 'Authorization': `Bearer ${syncToken}` } })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (Array.isArray(d?.secrets)) setDashSecrets(d.secrets) })
        .catch(() => {})
    }
  }, [agentUrl, syncToken])

  // Machine location (agent /health region).
  useEffect(() => {
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

  const canFetchAgent = useCallback(() => {
    if (typeof window === 'undefined') return false
    if (!agentUrl) return false
    if (window.location.protocol === 'https:' && agentUrl.startsWith('http://')) return false
    if (connectionMode === 'cloud' && agentUrl.startsWith('http://localhost')) return false
    return true
  }, [agentUrl, connectionMode])

  // Status polling — branches on connection mode (identical to dashboard).
  useEffect(() => {
    if (loading) return
    if (!user) return
    let cancelled = false
    const check = async () => {
      if (cancelled) return
      if (connectionMode === 'cloud') {
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
      if (!canFetchAgent()) { setAgentOnline(false); return }
      try {
        await fetch(`${agentUrl}/health`, { signal: AbortSignal.timeout(4000) })
        if (!cancelled) setAgentOnline(true)
      } catch {
        if (!cancelled) setAgentOnline(false)
      }
    }
    check()
    const i = setInterval(check, 15000)
    return () => { cancelled = true; clearInterval(i) }
  }, [agentUrl, loading, user, connectionMode, canFetchAgent])

  // One-time sandbox discovery + instance load (sync token + turbo).
  useEffect(() => {
    if (loading || !user) return
    fetch('/api/sandbox').then(r => r.json())
      .then(d => {
        setSandboxAvailable(d.available || false)
        if (d.sandbox) {
          setSandboxId(d.sandbox.id)
          setSandboxStatus(d.sandbox.status)
          if (d.sandbox.previewUrl) {
            setConnectionMode('cloud')
            setAgentUrl(d.sandbox.previewUrl)
          }
        }
      })
      .catch(() => setSandboxAvailable(false))
    fetch('/api/instance')
      .then(r => r.json())
      .then(d => {
        if (d.instance?.sync_token) setSyncToken(d.instance.sync_token)
        if (typeof d.instance?.turbo === 'boolean') setTurbo(d.instance.turbo)
      })
      .catch(() => {})
  }, [user, loading])

  const isCloud = connectionMode === 'cloud'

  // Check installed vs latest version whenever we have a cloud sandbox.
  useEffect(() => {
    if (isCloud && sandboxId) {
      checkVersion()
      if (sandboxStatus && sandboxStatus !== 'creating') {
        checkLayerConsistency()
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCloud, sandboxId, sandboxStatus])

  // ── Actions (lifted verbatim from dashboard/page.tsx) ──

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

  const handleTurboToggle = async () => {
    if (!user) return
    const next = !turbo
    setTurbo(next)
    setTurboSaving(true)
    try {
      await supabase.from('instances').update({ turbo: next }).eq('user_id', user.id)
    } catch {
      setTurbo(!next)
    } finally {
      setTurboSaving(false)
    }
  }

  const handleAutoApproveToggle = () => {
    const next = !autoApprove
    setAutoApprove(next)
    try { localStorage.setItem('osborn-auto-approve', String(next)) } catch {}
  }

  // Delete now goes through the type-"delete" confirm dialog. The dialog
  // enforces the friction; this just performs the irreversible delete.
  const handleDeleteSandbox = async () => {
    setShowDeleteDialog(false)
    if (!sandboxId) return
    try { await fetch('/api/sandbox', { method: 'DELETE' }) } catch {}
    setSandboxId(null)
    setSandboxStatus(null)
    setConnectionMode('local')
    setAgentUrl(localAgentUrl)
  }

  const handleRestart = async () => {
    if (operation) return
    setStatusMessage(null)
    setOperation({ kind: 'restart', stage: 'starting', startedAt: Date.now() })
    try {
      const restartPromise = fetch('/api/sandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'restart-service', sandboxId }),
      }).then(r => r.json()).catch((e) => ({ success: false, error: String(e) }))

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

      setOperation({ kind: 'restart', stage: 'verifying', startedAt: Date.now() })
      const deadline = Date.now() + 60000
      while (Date.now() < deadline) {
        try {
          const r = await fetch(`${agentUrl}/health`, { signal: AbortSignal.timeout(2000) })
          if (r.ok) {
            setOperation(null)
            setAgentOnline(true)
            setStatusMessage({ text: 'Agent is back online', type: 'success' })
            checkVersion()
            setTimeout(() => setStatusMessage(null), 4000)
            return
          }
        } catch {}
        await new Promise(r => setTimeout(r, 2000))
      }
      setOperation(null)
      setStatusMessage({ text: 'Agent restart timed out (60s)', type: 'error' })
    } catch (err) {
      setOperation(null)
      setStatusMessage({ text: `Restart error: ${(err as Error).message}`, type: 'error' })
    }
  }

  const handleUpdate = async () => {
    if (!sandboxId) return
    if (operation) return
    setStatusMessage(null)

    const target = latestVersion ?? null
    setOperation({
      kind: 'update',
      stage: 'starting',
      startedAt: Date.now(),
      targetVersion: target ?? undefined,
    })

    const phaseTimers = [
      setTimeout(() => setOperation((op) => op?.kind === 'update' ? { ...op, stage: 'installing' } : op), 3000),
      setTimeout(() => setOperation((op) => op?.kind === 'update' ? { ...op, stage: 'verifying' } : op), 60000),
      setTimeout(() => setOperation((op) => op?.kind === 'update' ? { ...op, stage: 'snapshotting' } : op), 80000),
    ]

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
            const lastTargetMatches =
              data.lastUpdate?.targetVersion && targetVersion
                ? data.lastUpdate.targetVersion === targetVersion
                : true
            if (data.lastUpdate?.status === 'success' && lastTargetMatches) {
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
            if (
              data.machineState === 'running' &&
              data.installedVersion &&
              targetVersion &&
              data.installedVersion === targetVersion
            ) {
              return { success: true, version: data.installedVersion }
            }
          }
        } catch {
          // Network error during poll — keep retrying until the deadline.
        }
        await new Promise((resolve) => setTimeout(resolve, 4000))
      }
      if (lastSignals.installedVersion === targetVersion) {
        return { success: true, version: lastSignals.installedVersion ?? null }
      }
      const detail = lastSignals.machineState
        ? ` (machine=${lastSignals.machineState}, installed=${lastSignals.installedVersion ?? 'unknown'})`
        : ''
      return { success: false, error: `Verification timed out after 3 min${detail}` }
    }

    try {
      const result = await fetch('/api/sandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update-osborn', sandboxId }),
      }).then(r => r.json()).catch((e) => ({ __droppedFetch: true, error: String(e) }))

      phaseTimers.forEach(clearTimeout)

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
          const errMsg = result.error || verified.error
          setStatusMessage({ text: `Update failed: ${errMsg}`, type: 'error' })
        }
        return
      }

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
    try {
      ['osborn-setup-completed', 'osborn-agent-url', 'osborn-provider',
       'osborn-voice-arch', 'osborn-coding-agent', 'osborn-room-code']
        .forEach(k => localStorage.removeItem(k))
    } catch {}
    window.location.href = '/'
  }

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

  const handleCopyGlobalSyncInfo = async () => {
    const skillUrl = `${window.location.origin}/api/sync-skill`
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

  // Scroll to a section (desktop) or drill into it (mobile).
  const goToSection = (id: SectionId) => {
    setActiveSection(id)
    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches) {
      setMobileSection(id)
      return
    }
    sectionRefs.current[id]?.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'start',
    })
  }

  /** Editable public handle (profiles.username) — drives /p/{handle}/{slug}
   *  URLs. Self-contained: loads on mount, PUTs /api/account/handle on save.
   *  Must stay ABOVE the `if (loading)` early return (Rules of Hooks). */
  const [handleValue, setHandleValue] = useState<string>('')
  const [handleEdit, setHandleEdit] = useState(false)
  const [handleBusy, setHandleBusy] = useState(false)
  const [handleMsg, setHandleMsg] = useState<string | null>(null)
  useEffect(() => {
    if (!user?.id) return
    ;(async () => {
      try {
        const { data } = await supabase.from('profiles').select('username').eq('id', user.id).maybeSingle()
        setHandleValue((data as { username?: string } | null)?.username || '')
      } catch { /* profile not loaded yet */ }
    })()
  }, [user?.id, supabase])
  const saveHandle = useCallback(async () => {
    setHandleBusy(true); setHandleMsg(null)
    try {
      const r = await fetch('/api/account/handle', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle: handleValue.trim() }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) { setHandleMsg(j?.error || 'Could not save') }
      else { setHandleValue(j.handle); setHandleEdit(false); setHandleMsg('Saved — your public pages now live at /p/' + j.handle) }
    } catch { setHandleMsg('Could not save') }
    finally { setHandleBusy(false) }
  }, [handleValue])

  if (loading) {
    return (
      <main className="min-h-screen bg-[var(--background)] flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-[var(--border)] border-t-[var(--accent)] rounded-full animate-spin" />
      </main>
    )
  }

  // Secret-field metadata (label + placeholder) — shared by desktop + mobile.
  const SECRET_META: Record<string, { label: string; placeholder: string }> = {
    ANTHROPIC_API_KEY: { label: 'Anthropic', placeholder: 'sk-ant-…' },
    OPENROUTER_API_KEY: { label: 'OpenRouter', placeholder: 'sk-or-…' },
    RECALL_API_KEY: { label: 'Recall.ai', placeholder: 'API key' },
    RECALL_REGION: { label: 'Recall region', placeholder: 'us-west-2' },
  }

  // ───────────────────────── Section bodies ─────────────────────────
  // Each returns the content for one settings section. Shared between the
  // desktop long-scroll pane and the mobile drill-in screen.

  const AccountSection = (
    <SettingsSection title="Account" description="Your Voice Native identity and session.">
      <SettingsRow label="Signed in as" sublabel={user?.email || 'No account connected'} />
      {user && (
        <SettingsRow label="Public handle" sublabel={handleMsg || (handleValue ? `voice-native.com/p/${handleValue}` : 'Your public pages URL — lowercase letters, numbers, hyphens')}>
          {handleEdit ? (
            <div className="flex items-center gap-2">
              <input
                value={handleValue}
                onChange={(e) => { setHandleValue(e.target.value); setHandleMsg(null) }}
                maxLength={30}
                autoFocus
                className="min-h-[44px] w-40 rounded-lg border border-[var(--border-subtle)] bg-[var(--background)] px-2.5 text-[13px] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
              />
              <button onClick={saveHandle} disabled={handleBusy || !handleValue.trim()}
                className="min-h-[44px] rounded-lg bg-[var(--accent)] px-3 text-[13px] font-semibold text-[var(--background)] disabled:opacity-50">
                {handleBusy ? '…' : 'Save'}
              </button>
              <button onClick={() => { setHandleEdit(false); setHandleMsg(null) }}
                className="min-h-[44px] rounded-lg border border-[var(--border-subtle)] px-3 text-[13px] text-[var(--text-secondary)]">
                Cancel
              </button>
            </div>
          ) : (
            <button onClick={() => setHandleEdit(true)}
              className="min-h-[44px] rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-2)] px-3 text-[13px] font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]">
              Edit
            </button>
          )}
        </SettingsRow>
      )}
      <SettingsRow label="Library" sublabel="Saved outputs, documents, and references">
        <Link
          href="/library"
          className="inline-flex min-h-[44px] items-center rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-2)] px-3 text-[13px] font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          Open library
        </Link>
      </SettingsRow>
      {user && (
        <SettingsRow label="Sign out" sublabel="End this session on this device">
          <button
            onClick={signOut}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-2)] px-3 text-[13px] font-medium text-[var(--text-secondary)] transition-colors hover:border-red-400/40 hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
            Sign out
          </button>
        </SettingsRow>
      )}
    </SettingsSection>
  )

  const VoiceSection = (
    <SettingsSection title="Voice & Audio" description="How your voice session is wired.">
      <SettingsRow label="Voice mode" sublabel="Speech-to-text → agent → text-to-speech">
        <div className="inline-flex rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-2)] p-0.5">
          {([['pipeline', 'Pipeline']] as [VoiceArch, string][]).map(([v, l]) => (
            <button
              key={v}
              onClick={() => setVoiceArch(v)}
              aria-pressed={voiceArch === v}
              aria-label={`Voice mode: ${l}`}
              className={`min-h-[36px] rounded-lg px-3 text-[12px] font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                voiceArch === v
                  ? 'bg-[var(--accent)] font-semibold text-[var(--background)] shadow-sm'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              }`}
            >
              {l}
            </button>
          ))}
        </div>
      </SettingsRow>
    </SettingsSection>
  )

  const PreferencesSection = (
    <SettingsSection title="Preferences" description="Defaults applied to every conversation.">
      <SettingsRow label="Auto-approve" sublabel="Let the agent act without per-step confirmation">
        <Switch checked={autoApprove} onChange={handleAutoApproveToggle} label="Toggle auto-approve" />
      </SettingsRow>
      {user && (
        <SettingsRow label="Turbo" sublabel="Run all agents on a faster, lighter model">
          <Switch checked={turbo} onChange={handleTurboToggle} label="Toggle turbo mode" disabled={turboSaving} />
        </SettingsRow>
      )}
    </SettingsSection>
  )

  const EnvironmentSection = (
    <>
      <SettingsSection title="Environment" description="Where your agent runs and how it stays current.">
        {/* Data-layer mismatch warning */}
        {layerReport && layerReport.mismatch && (
          <div className="px-4 py-3">
            <div className="rounded-lg border border-amber-400/30 bg-amber-400/[0.06] px-3 py-2.5 text-[11.5px] leading-relaxed text-amber-100">
              <div className="flex items-start gap-2">
                <span className="mt-px text-[13px] leading-none text-amber-400">⚠</span>
                <div className="flex-1 space-y-1">
                  <div className="font-medium text-amber-300">
                    Older session data on disk isn&rsquo;t visible to the running agent
                  </div>
                  <div className="text-amber-100/80">
                    Persistent disk has{' '}
                    <span className="font-mono">{layerReport.persistentSessionCount}</span>{' '}
                    large session{layerReport.persistentSessionCount === 1 ? '' : 's'}{' '}
                    ({(layerReport.persistentBytes / 1024 / 1024).toFixed(1)} MB total).
                    Agent only sees{' '}
                    <span className="font-mono">{layerReport.containerSessionCount}</span>.
                    This usually means a checkpoint restore rolled back the container
                    view. Data isn&rsquo;t lost — it&rsquo;s recoverable from a Sprites checkpoint
                    (destructive to current session).
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Machine status dot + id + region */}
        {isCloud && sandboxId && (
          <SettingsRow
            stacked
            label="Machine"
            sublabel="Your hosted cloud agent"
          >
            <div className="flex flex-col gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-2)] px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2.5">
                  <div className={`h-2 w-2 shrink-0 rounded-full ${
                    sandboxStatus === 'running' ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.4)]'
                    : sandboxStatus === 'warm' ? 'bg-amber-400'
                    : sandboxStatus === 'cold' ? 'bg-sky-400'
                    : sandboxStatus === 'stopped' ? 'bg-orange-400'
                    : sandboxStatus === 'creating' ? 'bg-amber-400 motion-safe:animate-pulse'
                    : 'bg-gray-500'
                  }`} />
                  <span className="font-mono text-[12px] text-[var(--text-secondary)]">{sandboxId.substring(0, 8)}</span>
                  <span className="text-[11px] capitalize text-[var(--text-muted)]">{sandboxStatus}</span>
                  {machineRegion && (
                    <span className="flex items-center gap-1 text-[11px] text-[var(--text-muted)]">
                      <span className="opacity-40">·</span>📍 {machineRegion}
                    </span>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {(sandboxStatus === 'stopped' || sandboxStatus === 'warm' || sandboxStatus === 'cold') && (
                    <button onClick={handleStartSandbox} disabled={provisioning}
                      className="rounded-lg px-2 py-1 text-[11px] text-emerald-400 transition-all hover:bg-emerald-400/10 hover:text-emerald-300 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400">
                      Resume
                    </button>
                  )}
                  {sandboxStatus === 'running' && (
                    <button onClick={handleStopSandbox}
                      className="rounded-lg px-2 py-1 text-[11px] text-[var(--text-muted)] transition-all hover:bg-orange-400/10 hover:text-orange-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400">
                      Stop
                    </button>
                  )}
                </div>
              </div>
              {syncToken && (
                <div className="flex items-center gap-2 border-t border-[var(--border-subtle)] pt-2">
                  <span className="flex-1 truncate font-mono text-[11px] text-[var(--text-muted)]">
                    Sync token: {syncToken.substring(0, 8)}...
                  </span>
                  <button
                    onClick={handleCopySyncToken}
                    className="shrink-0 rounded-lg bg-[var(--surface-raised)] px-2 py-1 text-[11px] text-[var(--text-muted)] transition-colors hover:bg-[var(--border)] hover:text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                  >
                    {syncCopied ? '✓ Copied' : 'Copy token'}
                  </button>
                </div>
              )}
            </div>
          </SettingsRow>
        )}

        {/* Local / Cloud segment */}
        <SettingsRow stacked label="Connection" sublabel="Run the agent on your machine (Local) or in the cloud.">
          <div className="flex gap-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-2)] p-1">
            <button
              onClick={() => { setConnectionMode('local'); setAgentUrl(localAgentUrl) }}
              aria-pressed={!isCloud}
              aria-label="Use local agent"
              className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-[13px] font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                !isCloud
                  ? 'border border-[var(--border-subtle)] bg-[var(--background)] text-[var(--text-primary)] shadow-sm'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              }`}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
              </svg>
              Local
            </button>
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
              aria-pressed={isCloud}
              aria-label="Use cloud agent"
              className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-[13px] font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-30 ${
                isCloud
                  ? 'border border-[var(--border-subtle)] bg-[var(--background)] text-[var(--text-primary)] shadow-sm'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              }`}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>
              </svg>
              {provisioning ? 'Setting up...' : 'Cloud'}
            </button>
          </div>
          {!isCloud && (
            <input type="text" value={agentUrl}
              onChange={e => setAgentUrl(e.target.value)}
              placeholder="http://localhost:8741"
              className="mt-2 h-11 w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-2)] px-3 font-mono text-[16px] text-[var(--text-secondary)] outline-none transition-colors placeholder:text-[var(--text-muted)]/40 focus-visible:border-[var(--accent)]/50" />
          )}
          {provisioning && (
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-[var(--surface-2)]">
              <div className="h-full rounded-full" style={{
                background: 'linear-gradient(90deg, transparent, var(--accent), transparent)',
                backgroundSize: '200% 100%',
                animation: 'shimmer 1.5s ease-in-out infinite',
              }} />
            </div>
          )}
        </SettingsRow>

        {/* Version + Update / Restart */}
        {isCloud && sandboxId && (
          <SettingsRow label="Voice Native version" sublabel="Keep the agent on the latest release">
            {!operation && (
              <>
                {installedVersion && (
                  <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-mono text-[11px] ${
                    latestVersion && installedVersion !== latestVersion
                      ? 'bg-amber-400/15 text-amber-400'
                      : 'bg-[var(--surface-2)] text-[var(--text-muted)]'
                  }`}>
                    {latestVersion && installedVersion !== latestVersion && (
                      <span className="text-[9px] text-amber-400">▲</span>
                    )}
                    v{installedVersion}
                  </span>
                )}
                <button onClick={handleUpdate}
                  className="rounded-lg px-2 py-1 text-[12px] text-[var(--text-muted)] transition-colors hover:text-sky-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400">
                  {latestVersion && installedVersion && latestVersion !== installedVersion
                    ? `Update to v${latestVersion}`
                    : 'Update Voice Native'}
                </button>
                <button onClick={handleRestart}
                  className="rounded-lg px-2 py-1 text-[12px] text-[var(--text-muted)] transition-colors hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400">
                  Restart agent
                </button>
              </>
            )}
            {updating && operation && (
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1 rounded-full bg-sky-400/15 px-1.5 py-0.5 font-mono text-[11px] text-sky-400">
                  v{installedVersion ?? '?'}
                  <span className="opacity-60">→</span>
                  v{operation.targetVersion ?? latestVersion ?? '?'}
                </span>
                <span className="text-[11px] text-sky-400 motion-safe:animate-pulse">
                  {operation.stage === 'starting'      && 'Stopping service...'}
                  {operation.stage === 'installing'    && `Installing v${operation.targetVersion ?? latestVersion ?? 'latest'}...`}
                  {operation.stage === 'verifying'     && 'Verifying agent...'}
                  {operation.stage === 'snapshotting'  && 'Saving snapshot...'}
                  {' '}({opElapsed}s)
                </span>
              </div>
            )}
            {restarting && operation && (
              <span className="text-[11px] text-amber-400 motion-safe:animate-pulse">
                {operation.stage === 'starting'  && 'Restarting service...'}
                {operation.stage === 'verifying' && 'Waiting for agent to come back...'}
                {' '}({opElapsed}s)
              </span>
            )}
          </SettingsRow>
        )}

        {statusMessage && !operation && (
          <SettingsRow label="Status">
            <p className={`text-[12px] ${statusMessage.type === 'success' ? 'text-green-400' : statusMessage.type === 'error' ? 'text-red-400' : 'text-sky-400'}`}>
              {statusMessage.text}
            </p>
          </SettingsRow>
        )}

        <SettingsRow label="Sync skill" sublabel="Copy the install snippet for Claude Code">
          <button
            onClick={handleCopyGlobalSyncInfo}
            className={`inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-2)] px-3 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
              globalSyncCopied ? 'text-emerald-400' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            {globalSyncCopied ? 'Copied' : 'Copy sync info'}
          </button>
        </SettingsRow>
      </SettingsSection>

      {/* ── Danger Zone ── */}
      <section className="mb-10">
        <h2 className="mb-3 font-display text-xl font-medium text-red-400 tracking-tight">Danger Zone</h2>
        <div className="rounded-xl border border-red-500/40 bg-red-500/[0.04]">
          <div className="flex min-h-[44px] flex-col items-start justify-between gap-3 px-4 py-4 sm:flex-row sm:items-center">
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-[var(--text-primary)]">Delete sandbox</div>
              <div className="mt-0.5 text-[12px] leading-snug text-[var(--text-muted)]">
                Permanently destroys your cloud machine. No recovery — this cannot be undone.
              </div>
            </div>
            <button
              onClick={() => setShowDeleteDialog(true)}
              disabled={!sandboxId}
              className="inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-lg border border-red-500/50 bg-red-500/10 px-3 text-[13px] font-semibold text-red-400 transition-colors hover:bg-red-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
              Delete sandbox
            </button>
          </div>
        </div>
      </section>
    </>
  )

  const KeysSection = (
    <SettingsSection
      title="API Keys"
      description="Add your own keys — applied live, no restart. Stored encrypted on your machine, never shown back."
    >
      {syncToken && dashSecrets.length > 0 ? (
        dashSecrets.map((s) => {
          const m = SECRET_META[s.key] ?? { label: s.key, placeholder: 'value' }
          const draft = secretDrafts[s.key] ?? ''
          const busy = savingSecret === s.key
          return (
            <SettingsRow key={s.key} stacked label={
              <span className="flex items-center justify-between gap-2">
                <span>{m.label}</span>
                {s.set ? (
                  <span className="flex shrink-0 items-center gap-1.5">
                    <span className="rounded-full border border-[var(--accent-dim)]/25 bg-[var(--accent-dim)]/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-[var(--accent)]">
                      {s.source === 'env' ? 'platform' : 'set'}
                    </span>
                    <span className="font-mono text-[11px] text-[var(--text-muted)]">{s.masked}</span>
                  </span>
                ) : (
                  <span className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">not set</span>
                )}
              </span>
            }>
              <div className="flex items-center gap-2">
                <input
                  type={s.secret ? 'password' : 'text'}
                  value={draft}
                  placeholder={m.placeholder}
                  autoComplete="off"
                  onChange={(e) => setSecretDrafts((prev) => ({ ...prev, [s.key]: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === 'Enter' && draft.trim()) handleSaveSecret(s.key) }}
                  className="min-w-0 flex-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-2)] px-2.5 py-2.5 font-mono text-[16px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent-dim)] focus:outline-none"
                />
                <button
                  onClick={() => handleSaveSecret(s.key)}
                  disabled={busy || !draft.trim()}
                  className="shrink-0 rounded-lg border border-[var(--accent-dim)]/25 bg-[var(--accent-dim)]/15 px-2.5 py-2.5 text-[12px] text-[var(--accent)] transition-colors hover:bg-[var(--accent-dim)]/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {busy ? '…' : 'Save'}
                </button>
                {s.set && s.source !== 'env' && (
                  <button
                    onClick={() => handleDeleteSecret(s.key)}
                    disabled={busy}
                    className="shrink-0 rounded-lg bg-[var(--surface-raised)] px-2.5 py-2.5 text-[12px] text-[var(--text-muted)] transition-colors hover:bg-[var(--border)] hover:text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-40"
                  >
                    Remove
                  </button>
                )}
              </div>
            </SettingsRow>
          )
        })
      ) : (
        <SettingsRow label="No keys available" sublabel={syncToken ? 'Connect your machine to manage keys.' : 'Connect your machine to manage keys.'} />
      )}
    </SettingsSection>
  )

  const AgentsSection = (
    <>
      <SettingsSection title={`Agents${dashAgents.length ? ` (${dashAgents.length})` : ''}`} description="The specialists your voice agent can dispatch to.">
        {dashAgents.length > 0 ? (
          dashAgents.map((a) => {
            const Glyph = a.name === 'researcher' ? MagnifyingGlass : a.name === 'reasoner' ? Brain : a.name === 'writer' ? PenNib : Robot
            return (
              <div key={a.name} className="flex gap-3 px-4 py-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--border-subtle)] bg-gradient-to-b from-[var(--surface-2)] to-[var(--surface)]">
                  <Glyph size={19} weight="duotone" color="var(--accent)" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13px] font-semibold capitalize tracking-tight text-[var(--text-primary)]">{a.name}</span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <span className="rounded-full border border-[var(--accent-dim)]/25 bg-[var(--accent-dim)]/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-[var(--accent)]">{a.model}</span>
                      <span className="font-mono text-[10px] text-[var(--text-muted)]">{a.tools.length}⚒</span>
                    </span>
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-[var(--text-muted)]">{a.description}</p>
                </div>
              </div>
            )
          })
        ) : (
          <SettingsRow label="No agents loaded" sublabel="Connect your machine to see its named agents." />
        )}
      </SettingsSection>

      <SettingsSection title={`Skills${dashSkills.length ? ` (${dashSkills.length})` : ''}`} description="Capabilities available to the agent on your machine.">
        <div className="px-4 py-3.5">
          {dashSkills.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {dashSkills.map((s) => (
                <span key={s.folder || s.name} title={s.description}
                  className="rounded-full border border-[var(--border-subtle)] bg-[var(--surface-2)] px-2 py-0.5 text-[10px] text-[var(--text-secondary)]">
                  {s.name.length > 34 ? s.name.slice(0, 32) + '…' : s.name}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-[12px] text-[var(--text-muted)]">Connect your machine to see its skills.</p>
          )}
        </div>
      </SettingsSection>
    </>
  )

  const SECTION_BODIES: Record<SectionId, ReactNode> = {
    account: AccountSection,
    voice: VoiceSection,
    preferences: PreferencesSection,
    environment: EnvironmentSection,
    keys: KeysSection,
    agents: AgentsSection,
  }

  const sectionLabel = (id: SectionId) =>
    NAV_GROUPS.flatMap((g) => g.items).find((i) => i.id === id)?.label ?? ''

  return (
    <>
      <main className="flex min-h-screen flex-col bg-[var(--background)]">
        {/* ── Header: back-to-dashboard + title ── */}
        <header className="sticky top-0 z-30 border-b border-[var(--border-subtle)] bg-[var(--background)]/80 backdrop-blur-md">
          <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4 pt-[env(safe-area-inset-top)]">
            <button
              onClick={() => {
                // On mobile, a drilled-in section goes back to the section list first.
                if (mobileSection && window.matchMedia('(max-width: 1023px)').matches) {
                  setMobileSection(null)
                } else {
                  router.push('/dashboard')
                }
              }}
              aria-label={mobileSection ? 'Back to settings' : 'Back to dashboard'}
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
            </button>
            <h1 className="font-display text-lg font-medium text-[var(--text-primary)]">
              {mobileSection ? <span className="lg:hidden">{sectionLabel(mobileSection)}</span> : 'Settings'}
              <span className={mobileSection ? 'hidden lg:inline' : ''}>{mobileSection ? 'Settings' : ''}</span>
            </h1>
          </div>
        </header>

        <div className="mx-auto flex w-full max-w-5xl flex-1 gap-8 px-4 py-6 lg:py-8">
          {/* ── Desktop left sidebar nav (lg+) ── */}
          <nav aria-label="Settings sections" className="hidden w-[220px] shrink-0 lg:block">
            <div className="sticky top-20 space-y-6">
              {NAV_GROUPS.map((g) => (
                <div key={g.group}>
                  <div className="px-2 pb-1.5 text-[11px] font-medium uppercase tracking-widest text-[var(--text-muted)]">{g.group}</div>
                  <ul className="space-y-0.5">
                    {g.items.map((item) => {
                      const active = activeSection === item.id
                      return (
                        <li key={item.id}>
                          <button
                            onClick={() => goToSection(item.id)}
                            aria-current={active ? 'true' : undefined}
                            className={`flex w-full items-center rounded-lg border-l-2 py-2 pl-3 pr-2 text-left text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                              active
                                ? 'border-[var(--accent)] bg-[var(--surface)] font-medium text-[var(--text-primary)]'
                                : 'border-transparent text-[var(--text-secondary)] hover:bg-[var(--surface)] hover:text-[var(--text-primary)]'
                            }`}
                          >
                            {item.label}
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              ))}
            </div>
          </nav>

          {/* ── Content pane ── */}
          <div className="min-w-0 flex-1 lg:max-w-2xl">
            {/* Desktop: all sections in one scroll pane */}
            <div className="hidden lg:block">
              {(['account', 'voice', 'preferences', 'environment', 'keys', 'agents'] as SectionId[]).map((id) => (
                <div
                  key={id}
                  id={`section-${id}`}
                  ref={(el) => { sectionRefs.current[id] = el }}
                  className="scroll-mt-20"
                >
                  {SECTION_BODIES[id]}
                </div>
              ))}
            </div>

            {/* Mobile: iOS-Settings style root list → drill into a section */}
            <div className="lg:hidden pb-[env(safe-area-inset-bottom)]">
              {mobileSection ? (
                <div>{SECTION_BODIES[mobileSection]}</div>
              ) : (
                <div className="space-y-6">
                  {NAV_GROUPS.map((g) => (
                    <div key={g.group}>
                      <div className="mb-1.5 px-1 text-[11px] font-medium uppercase tracking-widest text-[var(--text-muted)]">{g.group}</div>
                      <div className="divide-y divide-[var(--border-subtle)] overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)]">
                        {g.items.map((item) => (
                          <button
                            key={item.id}
                            onClick={() => goToSection(item.id)}
                            className="flex min-h-[52px] w-full items-center justify-between px-4 py-3 text-left text-[15px] text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] active:bg-[var(--surface-2)]"
                          >
                            {item.label}
                            <svg className="h-4 w-4 text-[var(--text-muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                            </svg>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </main>

      <DeleteSandboxDialog
        open={showDeleteDialog}
        onCancel={() => setShowDeleteDialog(false)}
        onConfirm={handleDeleteSandbox}
      />
    </>
  )
}
