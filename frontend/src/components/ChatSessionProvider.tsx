'use client'

/**
 * ChatSessionProvider
 *
 * Hoisted connection state for the /chat route. Owns every piece of state
 * that must survive UI edits to `chat/page.tsx` or `VoiceRoom.tsx`:
 *
 *   - LiveKit token + room code
 *   - Sandbox discovery / start flow
 *   - SSE keepalive to the sprite's /events endpoint
 *   - Idle-disconnect timer + user activity tracking
 *   - The `<LiveKitRoom>` component itself
 *
 * Everything here renders from `app/chat/layout.tsx`. Next.js App Router
 * treats layouts as stable across page edits — Fast Refresh swaps the page
 * but keeps the layout (and therefore this provider) mounted. That's what
 * protects the WebRTC connection from being torn down every time a dev
 * edits the chat UI.
 *
 * Before this lift, the <LiveKitRoom> lived inside <VoiceRoom> which was
 * rendered by <ChatPage>. Any non-Fast-Refresh-safe edit to page.tsx or
 * VoiceRoom.tsx triggered a full remount, dropped the LiveKit WebSocket,
 * forced the browser to re-prompt for mic (which failed without a user
 * gesture), and ended the voice session mid-conversation.
 */

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { LiveKitRoom, RoomAudioRenderer } from '@livekit/components-react'
import '@livekit/components-styles'

interface ChatSessionContextValue {
  // ── Connection state ───────────────────────
  token: string | null
  roomCode: string | null
  agentUrl: string
  connecting: boolean
  connected: boolean
  error: string | null
  statusMsg: string | null
  authRequired: boolean
  activeSandboxId: string | null

  // ── Derived from URL (stable per session) ──
  provider: string
  voiceArch: string
  codingAgent: string
  preSelectedSessionId: string | null

  // ── Actions consumed by the page + inner UI ─
  reconnect: () => Promise<void>
  disconnect: () => void
  markAgentReady: () => void
  markAuthRequired: () => void
  // Called by VoiceRoom whenever voice activity occurs (user spoke, agent
  // thinking/speaking). Resets the idle-stop timer — voice is the primary
  // activity signal; DOM events are removed as they're unreliable on mobile.
  markVoiceActivity: () => void
  // True when the session was stopped due to inactivity. VoiceRoom renders
  // a resume overlay instead of the normal UI. Cleared on reconnect.
  idleStopped: boolean
}

const ChatSessionContext = createContext<ChatSessionContextValue | null>(null)

export function useChatSession(): ChatSessionContextValue {
  const ctx = useContext(ChatSessionContext)
  if (!ctx) {
    throw new Error(
      'useChatSession must be called inside <ChatSessionProvider>. ' +
      'Make sure the component is rendered from /chat (which has the layout) ' +
      'and not a sibling route.',
    )
  }
  return ctx
}

export function ChatSessionProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const params = useSearchParams()

  // ── URL-derived, stable for the life of the session ──
  const provider = params.get('provider') || 'gemini'
  const voiceArch = params.get('voiceArch') || 'pipeline'
  const codingAgent = params.get('agent') || 'claude'
  const preSelectedSessionId = params.get('session') || null
  // Optional: cwd the selected session was originally created with. Forwarded to the
  // token API so the agent boots with the matching directory and the session lookup
  // path resolves correctly. Empty when starting a fresh conversation.
  const workingDirectory = params.get('workingDirectory') || ''

  const initialAgentUrl =
    typeof window !== 'undefined'
      ? params.get('agentUrl') || localStorage.getItem('osborn-agent-url') || 'http://localhost:8741'
      : 'http://localhost:8741'

  // ── Mutable session state ──
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
  const [idleStopped, setIdleStopped] = useState(false)

  // ═══════════════════════════════════════════════════════════════════════
  // Sprites cloud sandbox keepalive.
  //
  // Primary strategy: open a persistent SSE connection to osborn's /events
  // endpoint and hold it open for the duration of the chat session. The open
  // TCP connection keeps the sprite in 'running' state, which keeps osborn's
  // Node.js event loop ticking, which keeps LiveKit heartbeats firing, which
  // keeps the LK room alive. This is the only strategy that actually works
  // with Sprites — we verified empirically that short HTTP pings are
  // insufficient because Sprites' 'warm' state serves responses from a
  // process snapshot without resuming the event loop (background timers
  // don't fire between requests, so LK heartbeats stop within seconds of
  // hibernation, LK drops the WebSocket, the room is deleted).
  //
  // Fallback strategy: older osborn versions may not have /events yet.
  // When SSE fails with a permanent error (404, etc.), fall back to the
  // legacy 20-second /health ping. This is INSUFFICIENT for keeping the
  // LK room alive, but at least keeps the sprite from going fully cold so
  // HTTP endpoints remain responsive. A visible warning logs to console
  // so devs notice the sprite needs an osborn version with /events.
  // ═══════════════════════════════════════════════════════════════════════
  useEffect(() => {
    if (!connected) return
    if (!agentUrl) return
    if (!activeSandboxId) return
    if (agentUrl.startsWith('http://localhost')) return

    let es: EventSource | null = null
    let pingInterval: ReturnType<typeof setInterval> | null = null
    let usingFallback = false

    const startFallback = (reason: string) => {
      if (usingFallback) return
      usingFallback = true
      console.warn(
        `[sprite-keepalive] SSE unavailable (${reason}) — falling back to /health pings`,
      )
      console.warn(
        '[sprite-keepalive] WARNING: ping-based keepalive is INSUFFICIENT for LiveKit ' +
          'on Sprites. Voice session may stall. Deploy osborn with /events endpoint.',
      )
      const ping = () => {
        fetch(`${agentUrl}/health`, { signal: AbortSignal.timeout(5000) }).catch(() => {})
      }
      pingInterval = setInterval(ping, 20 * 1000)
      ping()
    }

    const sseUrl = `${agentUrl}/events`
    console.log(`[sprite-keepalive] opening SSE to ${sseUrl}`)
    try {
      es = new EventSource(sseUrl)
      es.onopen = () => console.log('[sprite-keepalive] SSE connected')
      es.onerror = () => {
        if (es && es.readyState === EventSource.CLOSED) {
          startFallback('SSE closed permanently (likely 404 — old osborn version)')
          es = null
        }
      }
    } catch (err) {
      startFallback(`SSE init failed: ${(err as Error).message}`)
    }

    return () => {
      console.log('[sprite-keepalive] cleanup')
      if (es) es.close()
      if (pingInterval) clearInterval(pingInterval)
    }
  }, [connected, agentUrl, activeSandboxId])

  // ── Idle-stop timer ────────────────────────────────────────────────────────
  //
  // 15 min of no voice activity → stop machine + show in-place idle overlay.
  // Intentionally does NOT navigate away — pushing to /dashboard would
  // trigger the dashboard's auto-start, creating a restart loop where the
  // machine spins up again immediately.
  //
  // Instead: set idleStopped=true which (a) unmounts LiveKitRoom so the
  // WebRTC connection closes and credits stop, and (b) shows a resume overlay
  // on the same page. User clicks Resume → connect() restarts everything.
  //
  // Activity signal: voice only — user_transcript (user spoke) and agent_state
  // changes (agent thinking/speaking). DOM events removed — unreliable on
  // mobile voice sessions.
  const IDLE_MS = 15 * 60 * 1000  // 15 minutes from last transcript

  useEffect(() => {
    if (!connected || idleStopped) return
    const checkIdle = setInterval(() => {
      const idleMs = Date.now() - lastActivityAt
      if (idleMs > IDLE_MS) {
        console.log('🛌 Voice idle 15min — stopping machine, showing resume overlay')
        // Stop the fly machine: closes LiveKit connection on the agent side,
        // stops credit burn. Fire-and-forget — overlay shows regardless.
        if (activeSandboxId) {
          fetch('/api/sandbox', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'stop', sandboxId: activeSandboxId }),
          }).catch(() => {})
        }
        // Unmount LiveKitRoom (by clearing token/connected state) and show
        // the idle overlay — no navigation, no restart loop.
        setIdleStopped(true)
        setConnected(false)
        setToken(null)
        setRoomCode(null)
      }
    }, 60 * 1000)
    return () => clearInterval(checkIdle)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, idleStopped, lastActivityAt, activeSandboxId])

  // ── Connection flow ──────────────────────────────────────────────
  const connect = useCallback(async () => {
    setConnecting(true)
    setError(null)
    let resolvedUrl = agentUrl

    try {
      // Step 1: Respect the user's connection mode preference from the dashboard.
      // Cloud is the DEFAULT (no saved preference = cloud); 'local' is opt-in.
      const connectionMode =
        typeof window !== 'undefined'
          ? localStorage.getItem('osborn-connection-mode') || 'cloud'
          : 'cloud'

      // Check/start the cloud sandbox unless the user explicitly chose local
      if (connectionMode === 'cloud') {
        try {
          const sandboxRes = await fetch('/api/sandbox')
          const sandboxData = await sandboxRes.json()

          if (sandboxData.available && sandboxData.sandbox) {
            const sb = sandboxData.sandbox
            setActiveSandboxId(sb.id)
            if (sb.status !== 'running') {
              setStatusMsg(
                sb.status === 'warm'
                  ? 'Resuming your workspace...'
                  : 'Starting your workspace...',
              )
              console.log(`[chat] Sandbox is ${sb.status} — starting it...`)
              const startRes = await fetch('/api/sandbox', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'start', sandboxId: sb.id }),
              })
              if (startRes.ok) {
                const startData = await startRes.json()
                if (startData.previewUrl) {
                  resolvedUrl = startData.previewUrl
                  setAgentUrl(resolvedUrl)
                  // Update URL bar to show the actual cloud agent URL, not localhost
                  const url = new URL(window.location.href)
                  url.searchParams.set('agentUrl', resolvedUrl)
                  window.history.replaceState({}, '', url.toString())
                }
              }
            } else if (sb.status === 'running' && sb.previewUrl) {
              resolvedUrl = sb.previewUrl
              setAgentUrl(resolvedUrl)
              const url = new URL(window.location.href)
              url.searchParams.set('agentUrl', resolvedUrl)
              window.history.replaceState({}, '', url.toString())
            }
          }
        } catch {
          // No sandbox API or not configured — fall back to local URL
        }
      }
      // If connectionMode === 'local', use the agentUrl from query param / localStorage as-is

      setStatusMsg('Connecting to agent...')

      // Step 2: Fetch room code from agent.
      // Cloud mode: proxy through Next.js API — handles cold-wake and CORS server-side.
      // Local mode: direct fetch with mixed-content guard (skip if HTTPS frontend → HTTP agent).
      let code: string | null = null
      try {
        if (connectionMode === 'cloud') {
          const r = await fetch('/api/sandbox', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'room-code' }),
          })
          if (r.ok) {
            const d = (await r.json()) as { roomCode?: string; agentUrl?: string }
            code = d.roomCode ?? null
            if (d.agentUrl) {
              resolvedUrl = d.agentUrl
              setAgentUrl(resolvedUrl)
              const url = new URL(window.location.href)
              url.searchParams.set('agentUrl', resolvedUrl)
              window.history.replaceState({}, '', url.toString())
            }
          }
        } else {
          const isMixed =
            window.location.protocol === 'https:' && resolvedUrl.startsWith('http:')
          if (!isMixed) {
            const r = await fetch(`${resolvedUrl}/room-code`, {
              signal: AbortSignal.timeout(3000),
            })
            if (r.ok) {
              const d = (await r.json()) as { roomCode?: string }
              code = d.roomCode ?? null
            }
          }
        }
      } catch {
        // room-code unavailable — token API will generate a fresh room
      }

      // Step 2.5: Ensure the agent is in its LiveKit room before we join, and
      // — critically for agent 0.9.83+ (temporary rooms) — use the roomName it
      // RETURNS to mint our token. Each /connect-room creates a FRESH room with
      // a unique suffix (osborn-<code>-<ts>); the room-code fetched above may be
      // stale/different, so joining it lands us in an empty room stuck
      // "Connecting". connect-room's returned roomName is the authoritative one.
      // (Older agents don't return roomName → we keep the room-code value.)
      try {
        if (connectionMode === 'cloud') {
          const cr = await fetch('/api/sandbox', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'connect-room' }),
          }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
          if (cr?.roomName) code = String(cr.roomName).replace(/^osborn-/, '')
        } else {
          const isMixed =
            window.location.protocol === 'https:' && resolvedUrl.startsWith('http:')
          if (!isMixed) {
            const cr = await fetch(`${resolvedUrl}/connect-room`, {
              method: 'POST',
              signal: AbortSignal.timeout(5000),
            }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
            if (cr?.roomName) code = String(cr.roomName).replace(/^osborn-/, '')
          }
        }
      } catch {
        // best-effort — the agent's boot-connect / retry loop is the backstop
      }

      // Step 2.6: Wait until the agent is actually IN the room before minting
      // our token. Agent-side ParticipantConnected only fires for users who
      // join AFTER the agent — if we win the join race, no voice session is
      // created and the UI hangs at "Connecting...". (Agent 0.9.76+ also
      // adopts pre-existing participants, but ordering correctly here means
      // we don't depend on the machine running a fixed version.)
      try {
        const isMixed =
          window.location.protocol === 'https:' && resolvedUrl.startsWith('http:')
        if (!isMixed) {
          const deadline = Date.now() + 30_000
          while (Date.now() < deadline) {
            const h = await fetch(`${resolvedUrl}/health`, {
              signal: AbortSignal.timeout(3000),
            })
              .then((r) => (r.ok ? r.json() : null))
              .catch(() => null)
            // Break on connected — or on agents too old to report livekit
            // status, where waiting longer can't tell us anything.
            if (!h || !h.livekit || h.livekit.status === 'connected') break
            await new Promise((r) => setTimeout(r, 1000))
          }
        }
      } catch {
        // best-effort — worst case we reproduce the old race odds
      }

      // Step 3: Get LiveKit token
      let url = `/api/token?provider=${provider}&voiceArch=${voiceArch}&codingAgent=${codingAgent}`
      if (code) url += `&roomCode=${code}`
      if (preSelectedSessionId)
        url += `&sessionId=${encodeURIComponent(preSelectedSessionId)}`
      // Forward the session's cwd into the token metadata so the agent boots with
      // the matching directory. Required for session resume to find the JSONL file
      // (which lives at ~/.claude/projects/<slug-derived-from-cwd>/<sessionId>.jsonl).
      if (workingDirectory)
        url += `&workingDirectory=${encodeURIComponent(workingDirectory)}`

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
  }, [
    agentUrl,
    provider,
    voiceArch,
    codingAgent,
    preSelectedSessionId,
    workingDirectory,
  ])

  // Auto-connect on first mount. Keep the deps array empty on purpose — we
  // only want to connect once per provider-mount, not re-trigger when the
  // `connect` callback identity changes.
  useEffect(() => {
    connect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Two disconnect paths — they ONLY differ in whether they ask the agent to
  // leave its LiveKit room.
  //
  // disconnect() — called by the explicit "Leave" button in VoiceRoom + the
  //   chat-page header. We KNOW the user is done with this session, so we
  //   POST /leave-room to make the agent leave its LiveKit room immediately
  //   (stops connection-minute burn — the whole point of room-presence v0.9.52).
  //
  // disconnectFromLiveKitLifecycle() — bound to the <LiveKitRoom> element's
  //   onDisconnected. This fires on ANY LiveKit drop, including transient
  //   network blips, tab visibility changes, mobile background pauses, and
  //   anything else that briefly closes the WebRTC connection. In that case
  //   we MUST NOT tell the agent to leave its room — the user is likely
  //   reconnecting in seconds and we don't want to kick the agent out of the
  //   room they're trying to rejoin. Just capture the log and navigate.
  //
  // Bug fix 2026-06-16 (post-0.9.55 deploy): we previously bound disconnect()
  // to both — so every LiveKit lifecycle disconnect made the agent leave its
  // room, leaving the user stuck on "back to dashboard" loops on every
  // resume attempt. The agent-side alone-timer (3 min if no participant)
  // is the right backstop for the lifecycle case; explicit /leave-room is
  // only for the explicit button.

  // Fire-and-forget log capture: fetch log from sprite then save to Supabase Storage.
  // Must not block or throw — caller proceeds unconditionally.
  const captureSessionLog = useCallback(() => {
    if (!activeSandboxId) return
    const spriteName = activeSandboxId
    fetch('/api/sandbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'fetch-log', sandboxId: spriteName }),
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`fetch-log ${res.status}`))))
      .then((data: { log: string }) => {
        return fetch('/api/sandbox', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'save-log',
            sandboxId: spriteName,
            spriteName,
            logContent: data.log,
            sessionId: preSelectedSessionId ?? undefined,
          }),
        })
      })
      .catch(() => {
        // Log capture is best-effort — swallow all errors silently
      })
  }, [activeSandboxId, preSelectedSessionId])

  // Explicit user leave (Leave button). Tell the agent to leave its LiveKit
  // room so connection-minute burn stops immediately.
  const disconnect = useCallback(() => {
    if (activeSandboxId) {
      fetch('/api/sandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'leave-room', sandboxId: activeSandboxId }),
      }).catch(() => {})
    } else if (
      agentUrl &&
      !(window.location.protocol === 'https:' && agentUrl.startsWith('http:'))
    ) {
      fetch(`${agentUrl}/leave-room`, { method: 'POST' }).catch(() => {})
    }
    captureSessionLog()
    router.push('/dashboard')
  }, [router, activeSandboxId, agentUrl, captureSessionLog])

  // LiveKit lifecycle disconnect (transient drops, tab close, mobile background).
  // Do NOT call /leave-room — the user is likely reconnecting in seconds and
  // we don't want to kick the agent out of the room they're trying to rejoin.
  // The agent's 3-min alone-timer is the backstop if the user truly walked away.
  const disconnectFromLiveKitLifecycle = useCallback(() => {
    captureSessionLog()
    router.push('/dashboard')
  }, [router, captureSessionLog])

  const markAgentReady = useCallback(() => {
    // Reset activity clock + clear idle state on connection so the machine
    // gets a full 15 min grace period from the moment voice is ready.
    setLastActivityAt(Date.now())
    setIdleStopped(false)
    setConnected(true)
  }, [])

  const markAuthRequired = useCallback(() => {
    setAuthRequired(true)
    setConnected(true) // surface the VoiceRoom UI so user can see + complete auth
  }, [])

  const markVoiceActivity = useCallback(() => {
    setLastActivityAt(Date.now())
  }, [])

  const value: ChatSessionContextValue = {
    token,
    roomCode,
    agentUrl,
    connecting,
    connected,
    error,
    statusMsg,
    authRequired,
    activeSandboxId,
    provider,
    voiceArch,
    codingAgent,
    preSelectedSessionId,
    reconnect: connect,
    disconnect,
    markAgentReady,
    markAuthRequired,
    markVoiceActivity,
    idleStopped,
  }

  // LiveKit config is stable per session
  const livekitUrl =
    process.env.NEXT_PUBLIC_LIVEKIT_URL || 'wss://your-project.livekit.cloud'
  const enableVideo = provider === 'gemini'

  // Conditional LiveKitRoom: only mount once we have a token. Before token is
  // available, render `children` bare so the page can show its "Connecting..."
  // UI. After token, wrap `children` in LiveKitRoom so descendants can use
  // `useRoomContext`, `useLocalParticipant`, `useDataChannel`, etc.
  //
  // Why not always render LiveKitRoom with a nullable token: the LiveKit
  // component requires a non-null token at mount time and logs noisy errors
  // if given null. Conditional mount is cleaner.
  return (
    <ChatSessionContext.Provider value={value}>
      {token && roomCode && !idleStopped ? (
        <LiveKitRoom
          token={token}
          serverUrl={livekitUrl}
          connect={true}
          audio={{
            // Browser-side Acoustic Echo Cancellation (AEC) — strips the agent's
            // TTS audio out of the mic capture BEFORE it gets published to
            // LiveKit. Root-cause fix for the "agent interrupts itself" loop:
            // without AEC, TTS plays through device speakers → mic captures the
            // echo → LiveKit publishes it as user audio → Deepgram classifies it
            // as speech → agent's user_state_changed handler interrupts its own
            // TTS. WebRTC supports these as MediaTrackConstraints in all modern
            // browsers, including iPad Safari. Echo cancellation is the primary
            // defense; noiseSuppression filters fan/HVAC; autoGainControl
            // smooths mic level so soft speech still triggers turn detection.
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          }}
          video={enableVideo}
          onDisconnected={disconnectFromLiveKitLifecycle}
          className="w-full flex justify-center"
        >
          <RoomAudioRenderer />
          {children}
        </LiveKitRoom>
      ) : (
        children
      )}
    </ChatSessionContext.Provider>
  )
}
