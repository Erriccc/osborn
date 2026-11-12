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

import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { liveSessionKey, sessionParamsFromSearch, takeoverSessionUrl } from '@/lib/chat-url'
import { LiveKitRoom, RoomAudioRenderer } from '@livekit/components-react'
import { DisconnectReason } from 'livekit-client'
import '@livekit/components-styles'
import { MIC_DENIED_EVENT, isMicDenied, reconcileMicDenied, type MicPermissionState } from '@/lib/mic-permission'
import { TAB_LOCK_NAME, TAB_LOCK_RETRY_MS, controlsEnabled, lockOutcomeAfterRestore, shouldConnectOnTransition, shouldRetryLockProbe, tabGuardCopy, tabGuardReducer, type TabRole } from '@/lib/tab-guard'
import { CONNECT_WATCHDOG_MS, connectTimeoutMessage, isAwaitingAgent, nextAuthRequired } from '@/lib/connect-gate'
import { createSupabaseBrowser } from '@/lib/supabase-browser'
import { isSupabaseConfigured } from '@/lib/supabase'

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
  // Optional seed prompt (URL ?prompt=) auto-sent once when a FRESH session
  // connects — powers "Talk about it" from a public page without any new API:
  // same /chat route + the existing send path, just pre-filled.
  seedPrompt: string | null

  // ── Actions consumed by the page + inner UI ─
  reconnect: () => Promise<void>
  disconnect: () => void
  markAgentReady: () => void
  markAuthRequired: () => void
  // Claude sign-in resolved (claude_auth_complete / claude_auth_error):
  // clears the pending-auth flag.
  markAuthResolved: (messageType: 'claude_auth_complete' | 'claude_auth_error') => void
  // VoiceRoom reports whether the sign-in modal is open on an active OAuth
  // step. While true the connect watchdog stays disarmed (issue #78).
  markAuthInProgress: (inProgress: boolean) => void
  // Called by VoiceRoom whenever voice activity occurs (user spoke, agent
  // thinking/speaking). Resets the idle-stop timer — voice is the primary
  // activity signal; DOM events are removed as they're unreliable on mobile.
  markVoiceActivity: () => void
  // True when the session was stopped due to inactivity. VoiceRoom renders
  // a resume overlay instead of the normal UI. Cleared on reconnect.
  idleStopped: boolean
  // True while THIS tab controls the session (bug 619af155). A second tab
  // stays out of the room until the user takes over.
  isController: boolean
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

// Mic permission helpers (review MAJOR 1). The reload rule runs at most once
// per document, so an in-app remount does not clear a fresh denial again.
let micReloadRuleApplied = false
function asMicState(state: string | undefined): MicPermissionState | null {
  return state === 'granted' || state === 'prompt' || state === 'denied' ? state : null
}
function currentNavigationType(): string | null {
  try {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    if (nav?.type) return nav.type
    // Legacy API: 1 = TYPE_RELOAD.
    const legacy = (performance as unknown as { navigation?: { type?: number } }).navigation
    if (legacy?.type === 1) return 'reload'
  } catch { /* no Performance API */ }
  return null
}

export function ChatSessionProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const params = useSearchParams()

  // ── URL-derived, stable for the life of the session ──
  // provider / voiceArch / agent / agentUrl used to ride the /chat URL as query
  // params, which exposed the provider, voice arch, coding-agent name and the
  // agent's fly.dev URL in the visible address bar. The dashboard now launches a
  // clean URL (only ?session= / ?workingDirectory=); these settings fall back to
  // the same localStorage keys the dashboard already writes, so function is
  // unchanged while the URL stays tidy. A query param still wins when present
  // (guest/test lanes, shared links).
  const lsGet = (k: string): string | null => {
    if (typeof window === 'undefined') return null
    try { return localStorage.getItem(k) } catch { return null }
  }
  const provider = params.get('provider') || lsGet('osborn-provider') || 'gemini'
  const voiceArch = params.get('voiceArch') || 'pipeline' // only 'pipeline' is supported now
  const codingAgent = params.get('agent') || lsGet('osborn-coding-agent') || 'claude'
  // Captured ONCE for the page life (#71): VoiceRoom rewrites ?session= with
  // history.replaceState as soon as the live session id is known (new session,
  // or after a switch) so a reload lands back in it. That rewrite must not
  // re-run the mount-time effects keyed on these values (prior-message
  // hydration would re-inject the live transcript). Reconnects read the LIVE
  // URL instead — see connect().
  const [preSelectedSessionId] = useState<string | null>(() => params.get('session') || null)
  // Optional: cwd the selected session was originally created with. Forwarded to the
  // token API so the agent boots with the matching directory and the session lookup
  // path resolves correctly. Empty when starting a fresh conversation.
  const [workingDirectory] = useState<string>(() => params.get('workingDirectory') || '')
  // Seed prompt for "Talk about it" / chat-based refine. A short seed rides the
  // URL (?prompt=); a FULL draft body (too big for a URL) is stashed in
  // sessionStorage by the caller and signalled with ?seed=1. VoiceRoom clears
  // it after sending so a refresh never re-seeds.
  const [seedPrompt] = useState<string | null>(() => {
    const p = params.get('prompt')
    if (p) return p.slice(0, 4000)
    if (params.get('seed') === '1' && typeof window !== 'undefined') {
      try { return sessionStorage.getItem('voice-native-seed') || null } catch { return null }
    }
    return null
  })

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
  // agent_ready actually fired. Distinct from `connected`, which
  // markAuthRequired also flips to uncover the sign-in modal (issue #78).
  const [agentReady, setAgentReady] = useState(false)
  // Sign-in modal open on an active OAuth step (reported by VoiceRoom).
  const [authInProgress, setAuthInProgress] = useState(false)
  const [idleStopped, setIdleStopped] = useState(false)

  // Connect-attempt generation. Each connect() run captures the value it was
  // started with; Cancel/disconnect bumps it. An in-flight connect() whose
  // generation is stale stops writing state — this is what makes Cancel respond
  // on the FIRST click (issue #53): without it, a connect() still awaiting a
  // slow fetch would re-set token/connecting AFTER the user navigated away,
  // re-showing the "Connecting…" overlay and making Cancel look like a no-op.
  const connectGenRef = useRef(0)

  // ── One controlling tab per browser (bug 619af155, frontend minimum) ──────
  // The agent hands the session to the newest joiner and greets it, so a
  // second tab used to steal the session. This tab holds a Web Lock while it
  // controls the session; a tab that cannot get it does not join the room
  // (no greeting, no mic, no send) until the user presses Take over, which
  // steals the lock. The previous holder's lock request then rejects with
  // AbortError and that tab drops its room (without /leave-room).
  const [tabRole, dispatchTab] = useReducer(tabGuardReducer, 'probing' as TabRole)
  const tabRoleRef = useRef<TabRole>(tabRole)
  tabRoleRef.current = tabRole
  const tabLockReleaseRef = useRef<(() => void) | null>(null)
  const requestTabLock = useCallback((steal: boolean, isCancelled: () => boolean = () => false, opts: { attempt?: number; restored?: boolean } = {}) => {
    const locks = typeof navigator !== 'undefined'
      ? (navigator as unknown as { locks?: { request: (name: string, opts: Record<string, unknown>, cb: (lock: unknown) => unknown) => Promise<unknown> } }).locks
      : undefined
    if (!locks?.request) { dispatchTab({ type: 'unsupported' }); return }
    const attempt = opts.attempt ?? 0
    locks.request(TAB_LOCK_NAME, steal ? { steal: true } : { ifAvailable: true }, (lock) => {
      if (isCancelled()) return undefined
      if (!lock) {
        // The previous document (reload, bfcache, quick tab switch) may still
        // be letting go: retry once before showing standby.
        if (!steal && shouldRetryLockProbe(attempt)) {
          setTimeout(() => { if (!isCancelled()) requestTabLock(false, isCancelled, { ...opts, attempt: attempt + 1 }) }, TAB_LOCK_RETRY_MS)
          return undefined
        }
        dispatchTab(opts.restored ? lockOutcomeAfterRestore(tabRoleRef.current, false) : { type: 'unavailable' })
        return undefined
      }
      dispatchTab({ type: 'acquired' })
      // Hold the lock until this provider unmounts (or it is stolen).
      return new Promise<void>((resolve) => { tabLockReleaseRef.current = resolve })
    }).catch((err: { name?: string } | undefined) => {
      if (err?.name === 'AbortError') {
        tabLockReleaseRef.current = null
        dispatchTab({ type: 'stolen' })
      }
    })
  }, [])
  useEffect(() => {
    let cancelled = false
    // Deferred one tick so a StrictMode mount/unmount/mount never makes this
    // tab hold the lock twice (and see itself as "another tab").
    const t = setTimeout(() => requestTabLock(false, () => cancelled), 0)
    return () => {
      cancelled = true
      clearTimeout(t)
      tabLockReleaseRef.current?.()
      tabLockReleaseRef.current = null
    }
  }, [requestTabLock])
  // Back/forward cache: a page going into the cache lets go of the lock (so
  // another tab can control meanwhile); when it is restored it re-requests it
  // (ifAvailable, one retry). Missing it while "active" = another tab took the
  // session, so this one stops as if stolen.
  useEffect(() => {
    let cancelled = false
    const onPageHide = (e: PageTransitionEvent) => {
      if (!e.persisted) return
      tabLockReleaseRef.current?.()
      tabLockReleaseRef.current = null
    }
    const onPageShow = (e: PageTransitionEvent) => {
      if (!e.persisted || tabLockReleaseRef.current) return
      requestTabLock(false, () => cancelled, { restored: true })
    }
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('pageshow', onPageShow)
    return () => {
      cancelled = true
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [requestTabLock])
  const takeOverTab = useCallback(() => {
    if (tabRoleRef.current !== 'standby' && tabRoleRef.current !== 'taken-over') return
    dispatchTab({ type: 'take-over' })
    requestTabLock(true)
  }, [requestTabLock])

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

    const openSse = () => {
      const sseUrl = `${agentUrl}/events`
      console.log(`[sprite-keepalive] opening SSE to ${sseUrl}`)
      try {
        const s = new EventSource(sseUrl)
        s.onopen = () => console.log('[sprite-keepalive] SSE connected')
        s.onerror = () => {
          if (s.readyState === EventSource.CLOSED) {
            startFallback('SSE closed permanently (likely 404 — old osborn version)')
            if (es === s) es = null
          }
        }
        es = s
      } catch (err) {
        startFallback(`SSE init failed: ${(err as Error).message}`)
      }
    }
    openSse()

    // P1.8 (2026-10-24): iOS suspends this EventSource the moment the tab
    // backgrounds. On foreground it can come back CLOSED (or zombie-CONNECTING
    // against a dead socket) while the sprite still believes the keepalive is
    // held — the exact recipe for a mid-session idle-stop. Re-open on visible;
    // bridge the suspend window with one keepalive fetch on hidden.
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        if (!usingFallback && (!es || es.readyState === EventSource.CLOSED)) {
          if (es) es.close()
          openSse()
        }
      } else {
        // Best-effort bridge while suspended; `keepalive` lets the request
        // outlive the imminent page freeze.
        fetch(`${agentUrl}/health`, { keepalive: true, signal: AbortSignal.timeout(5000) }).catch(() => {})
      }
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      console.log('[sprite-keepalive] cleanup')
      document.removeEventListener('visibilitychange', onVisibility)
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
        setAgentReady(false)
        setToken(null)
        setRoomCode(null)
      }
    }, 60 * 1000)
    return () => clearInterval(checkIdle)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, idleStopped, lastActivityAt, activeSandboxId])

  // ── Connection flow ──────────────────────────────────────────────
  const connect = useCallback(async () => {
    // Claim this connect attempt. If the user cancels (disconnect bumps the
    // generation) while we're awaiting a fetch below, `isCurrent()` goes false
    // and we stop touching state so the overlay can't be resurrected.
    const myGen = ++connectGenRef.current
    const isCurrent = () => connectGenRef.current === myGen
    setConnecting(true)
    setAgentReady(false)
    setError(null)
    let resolvedUrl = agentUrl

    // CONNECT TIMING: stamp the dashboard button click and log every frontend
    // stage delta (visible in Railway logs). clickTs is forwarded to the agent
    // so it can report the true end-to-end click→first-answer in one place.
    const clickTs = Date.now()
    ;(window as any).__osbornClickTs = clickTs
    const ctMark = (label: string) =>
      console.log(`⏱️ [connect-timing] +${Date.now() - clickTs}ms ${label}`)
    ctMark('button clicked (connect start)')

    try {
      // Step 0 — AUTH PRE-WARM (fix: a direct /chat load showed "Sign in to
      // connect to your agent" while the account was signed in; entering /chat
      // from the dashboard worked). Every call below is cookie-auth-gated
      // (/api/sandbox connect-room + status, then /api/token). On a cold DIRECT
      // load — opening /chat by URL or reloading after being away, e.g. right
      // after a machine restart — the Supabase access-token cookie may have
      // expired, and nothing on this route refreshed it first. The dashboard
      // masks the bug: it runs supabase.auth.getUser() on mount, which refreshes
      // and persists a fresh cookie, so dashboard→/chat always carries a valid
      // token; VoiceRoom's own getUser() here is too late (it mounts only AFTER
      // a token is minted). getSession() is a local no-op when the token is still
      // valid and refreshes + persists it (under the auth client's refresh lock)
      // when expired — so the concurrent connect-room / status / token calls
      // below all see one fresh, non-rotating session instead of each racing a
      // server-side refresh-token rotation that fails closed as a 401. Best
      // effort: a genuinely signed-out user still falls through to the real 401.
      let prewarmedSession: { user?: unknown } | null = null
      let sessionResolved = false
      try {
        const { data } = await createSupabaseBrowser().auth.getSession()
        prewarmedSession = data.session
        sessionResolved = true
      } catch { /* no Supabase / self-hosted: real gate is /api/token */ }

      // GUEST SHORT-CIRCUIT (#140): a signed-out visitor landing on /chat (e.g.
      // from the dashboard loop) would otherwise fire /api/sandbox (connect-room
      // + status) and /api/token — all 401 — and sit on a dead "Connecting…".
      // /api/token has no guest path (it 401s every anonymous caller), so there
      // is nothing to gain by making those calls. Surface the sign-in prompt up
      // front with NO sandbox/token calls.
      //   - Only when Supabase is configured AND getSession() resolved with no
      //     session: that is a definitive "signed out" on the hosted, auth-gated
      //     product. A self-hosted build with no Supabase (getSession throws →
      //     sessionResolved stays false) keeps the old behavior where /api/token
      //     is the real gate.
      //   - The explicit guest/test lane (a visible ?agentUrl= on the URL) talks
      //     straight to that agent and is left untouched.
      //   - Signed-in users (and auto-reconnect, which only runs for an
      //     already-live session) always have a session here, so this never fires
      //     for them.
      const hasVisibleAgentParam =
        typeof window !== 'undefined' &&
        !!new URLSearchParams(window.location.search).get('agentUrl')
      if (isSupabaseConfigured() && sessionResolved && !prewarmedSession?.user && !hasVisibleAgentParam) {
        if (isCurrent()) {
          setError('Sign in to connect to your agent.')
          setConnecting(false)
        }
        return
      }

      // Step 1: Respect the user's connection mode preference from the dashboard.
      // Cloud is the DEFAULT (no saved preference = cloud); 'local' is opt-in.
      const connectionMode =
        typeof window !== 'undefined'
          ? localStorage.getItem('osborn-connection-mode') || 'cloud'
          : 'cloud'
      // GUEST-CONNECT REGRESSION FIX (2026-08-01): cloud-by-default sent GUESTS
      // through /api/sandbox for room-code + connect-room — those 401 without a
      // session, so /connect-room never reached the agent named in ?agentUrl=
      // and the page hung on "Connecting...". When the sandbox is unavailable
      // for this caller but an explicit agentUrl exists (guest/test lane),
      // downgrade the REST of the flow to the direct lane.
      // Guest/direct-lane trigger. agentUrl no longer rides the visible URL for
      // dashboard launches, so fall back to the localStorage value the dashboard
      // writes — the guest/test lanes still pass ?agentUrl= and win here.
      const urlAgentParam = typeof window !== 'undefined'
        ? (new URLSearchParams(window.location.search).get('agentUrl')
            || (() => { try { return localStorage.getItem('osborn-agent-url') } catch { return null } })())
        : null
      let effectiveMode: string = connectionMode

      // CLICK-TIME START (0.9.266): fire the self-waking connect-room NOW, in
      // parallel with the status GET below — instead of serializing GET → start
      // → connect-room. connect-room resolves the sandbox + wakes the machine
      // server-side (route.ts self-wake) and returns the authoritative roomName,
      // and Fly's /start is idempotent so it can't conflict with the GET block's
      // start. Measured: the serial GET-before-start stacked ~6s before Fly was
      // even told to boot. Cloud path only; awaited at step 2.5.
      let connectRoomPromise: Promise<{ roomName?: string } | null> | null = null
      if (connectionMode === 'cloud') {
        connectRoomPromise = fetch('/api/sandbox', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'connect-room' }),
        }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
      }

      // Check/start the cloud sandbox unless the user explicitly chose local
      if (connectionMode === 'cloud') {
        try {
          const sandboxRes = await fetch('/api/sandbox')
          const sandboxData = await sandboxRes.json()

          if (!(sandboxData.available && sandboxData.sandbox) && urlAgentParam) {
            console.log('[chat] No sandbox for this caller + explicit agentUrl — using direct lane')
            effectiveMode = 'local'
          }
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
                  // Keep the resolved cloud agent URL for a refresh WITHOUT putting
                  // the fly.dev URL in the visible address bar (it used to be
                  // written back as ?agentUrl=). localStorage is where initialAgentUrl
                  // and the guest/direct lane now read it from.
                  try { localStorage.setItem('osborn-agent-url', resolvedUrl) } catch { /* ignore */ }
                }
              }
            } else if (sb.status === 'running' && sb.previewUrl) {
              resolvedUrl = sb.previewUrl
              setAgentUrl(resolvedUrl)
              try { localStorage.setItem('osborn-agent-url', resolvedUrl) } catch { /* ignore */ }
            }
          }
        } catch {
          // No sandbox API or not configured — fall back to local URL
          if (urlAgentParam) effectiveMode = 'local'
        }
      }
      // If effectiveMode === 'local', use the agentUrl from query param / localStorage as-is

      ctMark('sandbox checked/started')
      setStatusMsg('Connecting to agent...')

      // Step 2 (room-code) REMOVED (0.9.260 connect-latency fix): connect-room
      // below now self-wakes the machine + waits for health + returns the
      // authoritative roomName. The old separate room-code round-trip stacked a
      // second wake + waitForHealth(15s) + a 5x(5s fetch + 2s sleep) retry loop
      // ON TOP of connect-room — up to ~35s, measured as the bulk of the
      // "Connecting to agent…" orb. One wake, one health wait, one round-trip now.
      let code: string | null = null

      // Step 2.5: Ensure the agent is in its LiveKit room before we join, and
      // — critically for agent 0.9.83+ (temporary rooms) — use the roomName it
      // RETURNS to mint our token. Each /connect-room creates a FRESH room with
      // a unique suffix (osborn-<code>-<ts>); the room-code fetched above may be
      // stale/different, so joining it lands us in an empty room stuck
      // "Connecting". connect-room's returned roomName is the authoritative one.
      // (Older agents don't return roomName → we keep the room-code value.)
      // connect-room AWAITS the agent's room-join before it returns a roomName,
      // so a returned name means the agent is already in the room — the health
      // poll below (step 2.6) is then redundant. Track that to skip it: this is
      // the fix for the ~29s "connecting orb" measured in the connect video (the
      // serial room-code → connect-room → 30s-health-poll chain before token mint).
      let roomConfirmed = false
      try {
        if (effectiveMode === 'cloud') {
          // Await the connect-room we already fired at click-time (above).
          const cr = await connectRoomPromise
          if (cr?.roomName) { code = String(cr.roomName).replace(/^osborn-/, ''); roomConfirmed = true }
        } else {
          const isMixed =
            window.location.protocol === 'https:' && resolvedUrl.startsWith('http:')
          if (!isMixed) {
            const cr = await fetch(`${resolvedUrl}/connect-room`, {
              method: 'POST',
              signal: AbortSignal.timeout(8000),
            }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
            if (cr?.roomName) { code = String(cr.roomName).replace(/^osborn-/, ''); roomConfirmed = true }
          }
        }
      } catch {
        // best-effort — the agent's boot-connect / retry loop is the backstop
      }
      ctMark(`connect-room done (roomConfirmed=${roomConfirmed})`)

      // Step 2.6: Wait until the agent is actually IN the room before minting
      // our token. Agent-side ParticipantConnected only fires for users who
      // join AFTER the agent — if we win the join race, no voice session is
      // created and the UI hangs at "Connecting...". (Agent 0.9.76+ also
      // adopts pre-existing participants, but ordering correctly here means
      // we don't depend on the machine running a fixed version.)
      // Skip entirely when connect-room already confirmed the agent is in the
      // room (the common warm/cloud path) — no need to poll for what we just
      // awaited. Only poll as a FALLBACK when the room wasn't confirmed (older
      // agent that doesn't return roomName, or a connect-room failure), and
      // with a shorter deadline since the room is usually up by now.
      if (!roomConfirmed) {
        try {
          const isMixed =
            window.location.protocol === 'https:' && resolvedUrl.startsWith('http:')
          if (!isMixed) {
            // Shortened from 30s: this is only the FALLBACK poll (connect-room
            // didn't confirm the room). 30s meant a user who actually needs to
            // sign in sat on the connecting spinner for ~30s before /api/token
            // 401'd and the "Sign in to connect" prompt appeared. The modern
            // path skips this entirely, and an already-up agent joins its room
            // well within 8s, so cap the wait so the gate surfaces fast.
            const deadline = Date.now() + 8_000
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
        ctMark('health-poll fallback done')
      }

      // Step 3: Get LiveKit token
      let url = `/api/token?provider=${provider}&voiceArch=${voiceArch}&codingAgent=${codingAgent}`
      if (code) url += `&roomCode=${code}`
      // CONNECT TIMING: forward the click epoch so the agent reports true E2E.
      url += `&clickTs=${clickTs}`
      // Resume the session the URL pins NOW, not the one the page opened with: a
      // reconnect after a switch (or after a new session got its id) must rejoin
      // the live session (#71). On first connect the two are the same.
      const live = typeof window !== 'undefined'
        ? sessionParamsFromSearch(window.location.search)
        : { sessionId: null, workingDirectory: '' }
      const connectSessionId = live.sessionId || preSelectedSessionId
      // Never send an EMPTY cwd when one is known: an empty hint makes the agent
      // boot /workspace root (#112). The live URL's cwd wins; if a switch left it
      // empty, fall back to the cwd the page launched with. The agent treats this
      // purely as a hint and resolves the session's real project dir regardless.
      const connectWorkingDirectory = (live.sessionId ? live.workingDirectory : workingDirectory) || workingDirectory
      if (connectSessionId)
        url += `&sessionId=${encodeURIComponent(connectSessionId)}`
      // Forward the session's cwd into the token metadata so the agent boots with
      // the matching directory. Required for session resume to find the JSONL file
      // (which lives at ~/.claude/projects/<slug-derived-from-cwd>/<sessionId>.jsonl).
      if (connectWorkingDirectory)
        url += `&workingDirectory=${encodeURIComponent(connectWorkingDirectory)}`

      const res = await fetch(url)
      // User cancelled while the token request was in flight — don't resurrect.
      if (!isCurrent()) return
      if (!res.ok) {
        // /api/token requires a signed-in owner of the room's machine.
        setError(
          res.status === 401
            ? 'Sign in to connect to your agent.'
            : res.status === 404
              ? 'This session room is not available to your account.'
              : 'Failed to connect to agent',
        )
        setStatusMsg(null)
        return
      }
      const data = await res.json()
      if (!isCurrent()) return

      ctMark('token minted — handing off to LiveKit room join')
      setToken(data.token)
      setRoomCode(data.roomCode)
      ctMark('token+roomCode set → LiveKit client mounting (WebRTC start)')
      setStatusMsg(null)
    } catch (e) {
      if (!isCurrent()) return
      setError('Failed to connect to agent')
      setStatusMsg(null)
    } finally {
      if (isCurrent()) setConnecting(false)
    }
  }, [
    agentUrl,
    provider,
    voiceArch,
    codingAgent,
    preSelectedSessionId,
    workingDirectory,
  ])

  // Auto-connect when this tab becomes the controller (first mount, or after
  // Take over) — never in a standby tab, so it does not join the room or
  // trigger a greeting. Not re-triggered by `connect` identity changes.
  // Losing control drops the room locally; the agent is NOT told to leave
  // (the tab that took over is joining it).
  const prevTabRoleRef = useRef<TabRole>('probing')
  // Signed-in user id for the per-user live-session record (S13). undefined
  // until resolved: a take-over before that simply doesn't adopt.
  const liveUserIdRef = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    try {
      createSupabaseBrowser().auth.getSession()
        .then(({ data }) => { liveUserIdRef.current = data?.session?.user?.id ?? null })
        .catch(() => { liveUserIdRef.current = null })
    } catch { liveUserIdRef.current = null }
  }, [])
  useEffect(() => {
    const prev = prevTabRoleRef.current
    prevTabRoleRef.current = tabRole
    if (shouldConnectOnTransition(prev, tabRole)) {
      // S13: a tab taking over adopts the session the previous tab was live in
      // (it may have switched since this tab's URL was opened). connect() reads
      // the live URL, so rewrite it first. Never on first mount (probing).
      try {
        const uid = liveUserIdRef.current
        if (uid !== undefined) {
          const next = takeoverSessionUrl(window.location.href, localStorage.getItem(liveSessionKey(uid)), prev, Date.now(), uid)
          if (next) window.history.replaceState(null, '', next)
        }
      } catch { /* storage blocked */ }
      void connect()
    } else if (tabRole === 'taken-over') {
      setConnected(false)
      setAgentReady(false)
      setToken(null)
      setRoomCode(null)
      setStatusMsg(null)
      setConnecting(false)
    } else if (tabRole === 'standby') {
      setConnecting(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabRole])

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
    // Invalidate any in-flight connect() so it can't re-set token/connecting
    // after we navigate away (the old "Cancel does nothing on the first click"
    // behaviour, issue #53). Then clear the connecting state synchronously so
    // the overlay disappears immediately — the room-leave/log fetches below are
    // fire-and-forget and never block the navigation.
    connectGenRef.current++
    setConnecting(false)
    setStatusMsg(null)
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

  // Reconnect-attempt guard: bound auto-rejoin so a truly-down machine can't
  // spin the full connect() flow forever. Reset on a successful ready.
  const reconnectAttemptsRef = useRef(0)
  const MAX_AUTO_RECONNECTS = 3

  // LiveKit lifecycle disconnect — now REASON-GATED (reconnect-survival Phase 0b).
  // `onDisconnected` hands us a DisconnectReason; the old code bounced to the
  // dashboard on ALL of them, so a hotspot blip or iPad screen-lock yanked the
  // user off the voice page mid-session. Branch instead:
  //   • DUPLICATE_IDENTITY → the same session was opened on another device
  //     (device handoff / single-client takeover). STAND DOWN: show a message,
  //     do NOT navigate, do NOT reconnect (reconnecting would start a flap war
  //     — "someone deliberately took the seat").
  //   • explicit/terminal (CLIENT_INITIATED / ROOM_DELETED / PARTICIPANT_REMOVED)
  //     → the session really ended → go to the dashboard (original behavior).
  //   • anything else (network: SIGNAL_CLOSE, SERVER_SHUTDOWN, STATE_MISMATCH…)
  //     → attempt to rejoin the SAME room via connect() (bounded), which lands
  //     back on the warm brain once the server-side grace/re-attach ships. Never
  //     call /leave-room on this path (preserves the agent's room).
  const disconnectFromLiveKitLifecycle = useCallback((reason?: DisconnectReason) => {
    // Control moved to another tab: this drop is expected; stay on the notice.
    if (tabRoleRef.current !== 'active') return
    if (reason === DisconnectReason.DUPLICATE_IDENTITY) {
      console.log('🔀 Session moved to another device (duplicate identity) — standing down')
      setStatusMsg('This session is now active on another device.')
      setConnected(false)
      setAgentReady(false)
      return
    }
    const terminal =
      reason === DisconnectReason.CLIENT_INITIATED ||
      reason === DisconnectReason.ROOM_DELETED ||
      reason === DisconnectReason.PARTICIPANT_REMOVED
    if (terminal) {
      captureSessionLog()
      router.push('/dashboard')
      return
    }
    // Network-class drop → try to rejoin the same room (bounded), don't bounce.
    if (reconnectAttemptsRef.current < MAX_AUTO_RECONNECTS) {
      reconnectAttemptsRef.current += 1
      console.log(`🔁 Network disconnect (reason=${reason ?? 'unknown'}) — auto-rejoin attempt ${reconnectAttemptsRef.current}/${MAX_AUTO_RECONNECTS}`)
      setStatusMsg('Reconnecting…')
      void connect()
      return
    }
    console.log('🔁 Auto-rejoin attempts exhausted — returning to dashboard')
    captureSessionLog()
    router.push('/dashboard')
  }, [router, captureSessionLog, connect])

  const markAgentReady = useCallback(() => {
    // Reset activity clock + clear idle state on connection so the machine
    // gets a full 15 min grace period from the moment voice is ready.
    setLastActivityAt(Date.now())
    setIdleStopped(false)
    setConnected(true)
    setAgentReady(true)
    // A clean ready = reconnect succeeded → reset the auto-rejoin budget.
    reconnectAttemptsRef.current = 0
  }, [])

  const markAuthRequired = useCallback(() => {
    setAuthRequired(true)
    setConnected(true) // surface the VoiceRoom UI so user can see + complete auth
  }, [])

  const markAuthResolved = useCallback((messageType: 'claude_auth_complete' | 'claude_auth_error') => {
    setAuthRequired((prev) => nextAuthRequired(prev, messageType))
  }, [])

  const markAuthInProgress = useCallback((inProgress: boolean) => {
    setAuthInProgress(inProgress)
  }, [])

  const markVoiceActivity = useCallback(() => {
    setLastActivityAt(Date.now())
  }, [])

  // ── Connect watchdog (issue #53) ──────────────────────────────────────────
  // Bound the "Connecting…" screen. A fresh account whose agent blocks on
  // ensureClaudeAuth() before ever sending agent_ready — or any cold/slow
  // machine, dropped data message, or crashed agent — used to leave the
  // spinner running forever. Arm a timer while we're waiting on the agent and
  // nothing has resolved the screen; on expiry, surface an actionable error
  // (the page's error branch has Retry + Back). Keyed on `agentReady`, not
  // `connected`: markAuthRequired flips `connected` true to uncover the Claude
  // sign-in modal, which used to disarm the watchdog for good — a user who
  // dismissed the modal sat on "Connecting…" forever (issue #78). Now only an
  // active OAuth step (modal open, `authInProgress`) holds it off, so someone
  // mid-sign-in is never cut off. `statusMsg` / `authInProgress` are in the
  // deps so each progress tick or modal reopen/dismiss restarts the timer — a
  // slow-but-progressing connect is never cut off.
  useEffect(() => {
    if (!isAwaitingAgent({ connecting, agentReady, hasToken: !!token, error: !!error, authRequired, authInProgress })) return
    const t = setTimeout(() => {
      setError(connectTimeoutMessage(authRequired))
      setStatusMsg(null)
      setConnecting(false)
    }, CONNECT_WATCHDOG_MS)
    return () => clearTimeout(t)
  }, [connecting, agentReady, token, error, authRequired, authInProgress, statusMsg])

  // ── P1.8 (2026-10-24): foreground fast-rejoin + screen wake lock ──────────
  const connectedRef = useRef(connected)
  connectedRef.current = connected
  const idleStoppedRef = useRef(idleStopped)
  idleStoppedRef.current = idleStopped
  // Set once a session has been live at least once — gates foreground rejoins
  // so a cold tab merely brought to focus never tries to connect.
  const everConnectedRef = useRef(false)
  useEffect(() => {
    if (connected) everConnectedRef.current = true
  }, [connected])

  // Foreground fast-rejoin: iOS suspends JS while backgrounded, so a drop
  // that happened mid-background may never have fired its auto-rejoin — and
  // LiveKit can surface a zombie `connected` after resume. If the session was
  // live before hiding and is now dead (and not idle-stopped), rejoin
  // immediately instead of waiting for the user to notice the silence.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      if (tabRoleRef.current !== 'active') return
      if (!everConnectedRef.current) return
      if (connectedRef.current || idleStoppedRef.current) return
      if (reconnectAttemptsRef.current >= MAX_AUTO_RECONNECTS) return
      reconnectAttemptsRef.current += 1
      console.log(
        `🔁 [foreground] session dropped while backgrounded — rejoin attempt ${reconnectAttemptsRef.current}/${MAX_AUTO_RECONNECTS}`,
      )
      setStatusMsg('Reconnecting…')
      void connect()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [connect])

  // Screen wake lock while a session is live: a phone that sleeps mid-voice-
  // session suspends WebRTC + SSE and burns a full reconnect cycle. Held for
  // the live session, released on disconnect/idle-stop, re-acquired on
  // foreground (browsers release the lock every time the page hides).
  // Feature-detected — silently absent where unsupported.
  useEffect(() => {
    if (!connected || idleStopped) return
    let sentinel: { release: () => Promise<void>; addEventListener?: (t: string, l: () => void) => void } | null = null
    let cancelled = false
    const acquire = async () => {
      if (cancelled || document.visibilityState !== 'visible') return
      const wl = (navigator as unknown as { wakeLock?: { request: (t: 'screen') => Promise<typeof sentinel> } }).wakeLock
      if (!wl) return
      try {
        const s = await wl.request('screen')
        if (cancelled) {
          try { await s?.release() } catch { /* already gone */ }
          return
        }
        sentinel = s
        sentinel?.addEventListener?.('release', () => { sentinel = null })
      } catch { /* denied/unavailable — no-op */ }
    }
    const onVis = () => {
      if (document.visibilityState === 'visible') void acquire()
    }
    void acquire()
    document.addEventListener('visibilitychange', onVis)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVis)
      try { void sentinel?.release() } catch { /* already released */ }
    }
  }, [connected, idleStopped])

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
    seedPrompt,
    reconnect: connect,
    disconnect,
    markAgentReady,
    markAuthRequired,
    markAuthResolved,
    markAuthInProgress,
    markVoiceActivity,
    idleStopped,
    isController: controlsEnabled(tabRole),
  }

  // Bug 7cf00ae6: LiveKitRoom publishes the mic on EVERY signal (re)connect,
  // so after the browser denied it each reconnect re-asked and re-raised the
  // warning. VoiceRoom records the denial in sessionStorage; while it stands
  // the room joins without the mic, and only the user's Try again / unmute
  // re-asks. Options object is memoized so its identity is stable.
  const [micDenied, setMicDeniedState] = useState(false)
  useEffect(() => {
    const read = () => {
      try { setMicDeniedState(isMicDenied(window.sessionStorage)) } catch { /* storage blocked */ }
    }
    read()
    window.addEventListener(MIC_DENIED_EVENT, read)
    return () => window.removeEventListener(MIC_DENIED_EVENT, read)
  }, [])
  // The stored denial must not outlive the browser's own answer (review MAJOR
  // 1): on mount and on every PermissionStatus change, granted/prompt clears
  // it and denied keeps it. Without the Permissions API, a page reload clears
  // it (once per document). Changes are broadcast so VoiceRoom's ref follows.
  useEffect(() => {
    let cancelled = false
    let status: PermissionStatus | null = null
    const apply = (permission: MicPermissionState | null) => {
      if (cancelled) return
      let store: Storage
      try { store = window.sessionStorage } catch { return }
      const before = isMicDenied(store)
      let navigationType: string | null = null
      if (permission === null && !micReloadRuleApplied) {
        micReloadRuleApplied = true
        navigationType = currentNavigationType()
      }
      const after = reconcileMicDenied(store, { permission, navigationType })
      if (after !== before) {
        try { window.dispatchEvent(new Event(MIC_DENIED_EVENT)) } catch { /* ignore */ }
      }
    }
    const onChange = () => apply(asMicState(status?.state))
    const perms = typeof navigator !== 'undefined' ? navigator.permissions : undefined
    if (perms && typeof perms.query === 'function') {
      perms.query({ name: 'microphone' as PermissionName })
        .then((s) => {
          if (cancelled) return
          status = s
          apply(asMicState(s.state))
          s.addEventListener('change', onChange)
        })
        .catch(() => apply(null)) // 'microphone' unknown to this browser
    } else {
      apply(null)
    }
    return () => {
      cancelled = true
      status?.removeEventListener('change', onChange)
    }
  }, [])
  const audioCapture = useMemo(
    // AEC rationale (moved from the LiveKitRoom prop):
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
    () => (micDenied ? false : { echoCancellation: true, noiseSuppression: true, autoGainControl: true }),
    [micDenied],
  )

  // LiveKit config is stable per session
  const livekitUrl =
    process.env.NEXT_PUBLIC_LIVEKIT_URL || 'wss://your-project.livekit.cloud'
  // Audio-only by default (no camera permission prompt). Flip ALLOW_VIDEO to true to re-enable the camera.
  const ALLOW_VIDEO = false
  const enableVideo = ALLOW_VIDEO && provider === 'gemini'

  // Conditional LiveKitRoom: only mount once we have a token. Before token is
  // available, render `children` bare so the page can show its "Connecting..."
  // UI. After token, wrap `children` in LiveKitRoom so descendants can use
  // `useRoomContext`, `useLocalParticipant`, `useDataChannel`, etc.
  //
  // Why not always render LiveKitRoom with a nullable token: the LiveKit
  // component requires a non-null token at mount time and logs noisy errors
  // if given null. Conditional mount is cleaner.
  const guardCopy = tabGuardCopy(tabRole)
  if (guardCopy) {
    return (
      <ChatSessionContext.Provider value={value}>
        <main className="min-h-[100dvh] bg-[var(--background)] flex flex-col items-center justify-center p-8 gap-5" data-testid="tab-guard">
          <div className="text-center max-w-sm">
            <p className="text-[var(--text-primary)] text-lg font-medium">{guardCopy.title}</p>
            <p className="text-[var(--text-muted)] text-sm mt-1.5 leading-relaxed">{guardCopy.body}</p>
          </div>
          <div className="flex gap-3">
            <button
              onClick={takeOverTab}
              disabled={tabRole === 'taking'}
              className="px-4 py-2 rounded-lg bg-[var(--accent)] text-white text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-60"
            >
              {tabRole === 'taking' ? 'Taking over…' : guardCopy.action}
            </button>
            <button
              onClick={() => router.push('/dashboard')}
              className="px-4 py-2 rounded-lg text-[var(--text-muted)] text-sm hover:text-[var(--text-secondary)] transition-colors"
            >
              Back to dashboard
            </button>
          </div>
        </main>
      </ChatSessionContext.Provider>
    )
  }

  return (
    <ChatSessionContext.Provider value={value}>
      {token && roomCode && !idleStopped ? (
        <LiveKitRoom
          token={token}
          serverUrl={livekitUrl}
          connect={true}
          audio={audioCapture}
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
