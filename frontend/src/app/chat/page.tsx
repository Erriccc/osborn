'use client'

import { useState, useEffect, useCallback, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { createSupabaseBrowser } from '@/lib/supabase-browser'
import VoiceRoom from '@/components/VoiceRoom'

function ChatInner() {
  const router = useRouter()
  const params = useSearchParams()
  const supabase = createSupabaseBrowser()

  const provider = params.get('provider') || 'gemini'
  const voiceArch = params.get('voiceArch') || 'pipeline'
  const codingAgent = params.get('agent') || 'claude'
  const initialAgentUrl = params.get('agentUrl') || localStorage.getItem('osborn-agent-url') || 'http://localhost:8741'
  const sessionId = params.get('session') || null

  const [agentUrl, setAgentUrl] = useState(initialAgentUrl)
  const [token, setToken] = useState<string | null>(null)
  const [roomCode, setRoomCode] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const [activeSandboxId, setActiveSandboxId] = useState<string | null>(null)
  const [lastActivityAt, setLastActivityAt] = useState(Date.now())
  const [authRequired, setAuthRequired] = useState(false)

  // Keepalive ping while user is connected to a cloud sandbox
  useEffect(() => {
    if (!connected || !activeSandboxId) return
    const ping = () => {
      fetch('/api/sandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'keepalive', sandboxId: activeSandboxId }),
      }).catch(() => {})
    }
    const interval = setInterval(ping, 5 * 60 * 1000) // every 5 min
    ping() // immediate ping
    return () => clearInterval(interval)
  }, [connected, activeSandboxId])

  // Auto-disconnect after 20 min of no user activity (preserves LiveKit + cloud)
  useEffect(() => {
    if (!connected) return
    const checkIdle = setInterval(() => {
      const idleMs = Date.now() - lastActivityAt
      if (idleMs > 20 * 60 * 1000) {
        console.log('🛌 Idle for 20min — disconnecting to preserve usage')
        router.push('/dashboard')
      }
    }, 60 * 1000) // check every minute
    return () => clearInterval(checkIdle)
  }, [connected, lastActivityAt, router])

  // Track user activity (clicks, key presses, voice events)
  useEffect(() => {
    const update = () => setLastActivityAt(Date.now())
    window.addEventListener('click', update)
    window.addEventListener('keydown', update)
    window.addEventListener('mousemove', update)
    return () => {
      window.removeEventListener('click', update)
      window.removeEventListener('keydown', update)
      window.removeEventListener('mousemove', update)
    }
  }, [])

  // Auth guard
  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) {
        // Allow unauthenticated users too (guest mode)
        // but they came from the landing page connect flow
      }
    })
  }, [])

  // Auto-connect on mount
  useEffect(() => {
    connect()
  }, [])

  const connect = async () => {
    setConnecting(true)
    setError(null)
    let resolvedUrl = agentUrl

    try {
      // Step 1: Respect the user's connection mode preference from the dashboard
      const connectionMode = typeof window !== 'undefined'
        ? localStorage.getItem('osborn-connection-mode') || 'local'
        : 'local'

      // Only check/start cloud sandbox if user explicitly chose cloud mode
      if (connectionMode === 'cloud') {
        try {
          const sandboxRes = await fetch('/api/sandbox')
          const sandboxData = await sandboxRes.json()

          if (sandboxData.available && sandboxData.sandbox) {
            const sb = sandboxData.sandbox
            setActiveSandboxId(sb.id)
            if (sb.status === 'stopped') {
              setStatusMsg('Resuming your workspace...')
              const startRes = await fetch('/api/sandbox', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'start', sandboxId: sb.id }),
              })
              const startData = await startRes.json()
              if (startData.previewUrl) {
                resolvedUrl = startData.previewUrl
                setAgentUrl(resolvedUrl)
              }
            } else if (sb.status === 'running' && sb.previewUrl) {
              resolvedUrl = sb.previewUrl
              setAgentUrl(resolvedUrl)
            }
          }
        } catch {
          // No sandbox API or not configured — fall back to local URL
        }
      }
      // If connectionMode === 'local', use the agentUrl from query param / localStorage as-is

      setStatusMsg('Connecting to agent...')

      // Step 2: Get room code from agent
      let code: string | null = null
      try {
        const r = await fetch(`${resolvedUrl}/room-code`)
        const d = await r.json()
        if (d.roomCode) code = d.roomCode
      } catch {}

      // Step 3: Get LiveKit token
      let url = `/api/token?provider=${provider}&voiceArch=${voiceArch}&codingAgent=${codingAgent}`
      if (code) url += `&roomCode=${code}`
      if (sessionId) url += `&sessionId=${encodeURIComponent(sessionId)}`

      const res = await fetch(url)
      const data = await res.json()

      setToken(data.token)
      setRoomCode(data.roomCode)
      setStatusMsg(null)
    } catch (e) {
      setError('Failed to connect to agent')
      setStatusMsg(null)
    } finally {
      setConnecting(false)
    }
  }

  const handleDisconnect = useCallback(() => {
    router.push('/dashboard')
  }, [router])

  const handleAgentReady = useCallback(() => {
    setConnected(true)
  }, [])

  const handleAuthRequired = useCallback(() => {
    setAuthRequired(true)
    setConnected(true) // surface the VoiceRoom UI so user can see + complete auth
  }, [])

  // ─── Connecting state ────────────────────────────
  if (connecting || (!connected && token && roomCode)) {
    return (
      <>
        <style>{`
          @keyframes breathe { 0%, 100% { transform: scale(1); opacity: 0.7; } 50% { transform: scale(1.15); opacity: 1; } }
          @keyframes ring { 0% { transform: scale(0.8); opacity: 0.5; } 100% { transform: scale(2.2); opacity: 0; } }
        `}</style>
        <main className="min-h-screen bg-[var(--background)] flex flex-col items-center justify-center p-8">
          <div className="flex flex-col items-center gap-6">
            <div className="relative w-20 h-20">
              <div className="absolute inset-0 rounded-full bg-[var(--accent)]"
                style={{ animation: 'breathe 2.4s ease-in-out infinite' }} />
              <div className="absolute inset-0 rounded-full border border-[var(--accent)]"
                style={{ animation: 'ring 2.4s ease-out infinite', opacity: 0.3 }} />
            </div>
            <p className="text-[var(--text-secondary)] text-sm">{statusMsg || 'Connecting...'}</p>
            <button onClick={handleDisconnect}
              className="text-[var(--text-muted)] text-sm hover:text-[var(--text-secondary)] underline underline-offset-2 transition-colors">
              Cancel
            </button>
          </div>

          {/* Hidden VoiceRoom keeps LiveKit connection alive */}
          {token && roomCode && (
            <div className="hidden">
              <VoiceRoom
                token={token}
                onDisconnect={handleDisconnect}
                onAgentReady={handleAgentReady}
                onAuthRequired={handleAuthRequired}
                waitingMode={true}
                provider={provider}
                preSelectedSessionId={sessionId}
              />
            </div>
          )}
        </main>
      </>
    )
  }

  // ─── Error state ──────────────────────────────────
  if (error) {
    return (
      <main className="min-h-screen bg-[var(--background)] flex flex-col items-center justify-center p-8 gap-4">
        <p className="text-red-400 text-sm">{error}</p>
        <div className="flex gap-3">
          <button onClick={connect}
            className="px-4 py-2 rounded-lg bg-[var(--surface)] border border-[var(--border)] text-[var(--text-primary)] text-sm hover:bg-[var(--surface-raised)] transition-colors">
            Retry
          </button>
          <button onClick={handleDisconnect}
            className="px-4 py-2 rounded-lg text-[var(--text-muted)] text-sm hover:text-[var(--text-secondary)] transition-colors">
            Back
          </button>
        </div>
      </main>
    )
  }

  // ─── Connected — show VoiceRoom ───────────────────
  if (connected && token && roomCode) {
    return (
      <VoiceRoom
        token={token}
        onDisconnect={handleDisconnect}
        onAgentReady={handleAgentReady}
        onAuthRequired={handleAuthRequired}
        waitingMode={false}
        provider={provider}
        preSelectedSessionId={sessionId}
      />
    )
  }

  // Fallback
  return null
}

export default function ChatPage() {
  return (
    <Suspense fallback={
      <main className="min-h-screen bg-[var(--background)] flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-[var(--border)] border-t-[var(--accent)] rounded-full animate-spin" />
      </main>
    }>
      <ChatInner />
    </Suspense>
  )
}
