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
  const agentUrl = params.get('agentUrl') || localStorage.getItem('osborn-agent-url') || 'http://localhost:8741'
  const sessionId = params.get('session') || null

  const [token, setToken] = useState<string | null>(null)
  const [roomCode, setRoomCode] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)

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
    try {
      // Try to get room code from agent first
      let code: string | null = null
      try {
        const r = await fetch(`${agentUrl}/room-code`)
        const d = await r.json()
        if (d.roomCode) code = d.roomCode
      } catch {}

      // Get token
      let url = `/api/token?provider=${provider}&voiceArch=${voiceArch}&codingAgent=${codingAgent}`
      if (code) url += `&roomCode=${code}`
      if (sessionId) url += `&sessionId=${encodeURIComponent(sessionId)}`

      const res = await fetch(url)
      const data = await res.json()

      setToken(data.token)
      setRoomCode(data.roomCode)
    } catch (e) {
      setError('Failed to connect to agent')
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
            <p className="text-[var(--text-secondary)] text-sm">Connecting...</p>
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
