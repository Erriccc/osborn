'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useDocumentTitle } from '@/lib/use-document-title'
import { useHeaderPanel } from '@/lib/use-header-panel'
import { useRouter } from 'next/navigation'
import { createSupabaseBrowser, getBrowserUser } from '@/lib/supabase-browser'
import type { User } from '@supabase/supabase-js'
import SessionBrowser from '@/components/SessionBrowser'
import SetupWizard from '@/components/SetupWizard'
import EmailOtpLogin from '@/components/EmailOtpLogin'
import { clearSignOutLocalState } from '@/lib/transcript-cache'

type Provider = 'gemini' | 'openai'
type VoiceArch = 'realtime' | 'pipelined' | 'direct' | 'pipeline'
type CodingAgent = 'claude' | 'codex'

export default function Home() {
  useDocumentTitle('Sign in')
  const router = useRouter()
  const [provider, setProvider] = useState<Provider>('gemini')
  const [voiceArch, setVoiceArch] = useState<VoiceArch>('pipeline')
  const [codingAgent, setCodingAgent] = useState<CodingAgent>('claude')
  const [roomCode, setRoomCode] = useState<string | null>(null)
  const [agentUrl, setAgentUrl] = useState<string>('http://localhost:8741')
  const [showWizard, setShowWizard] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const authCardRef = useRef<HTMLDivElement>(null)
  // Settings accordion: Esc + click-outside-the-card to close (it had neither).
  useHeaderPanel('login-settings', showSettings, setShowSettings, authCardRef)
  const [showSessionBrowser, setShowSessionBrowser] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)

  // Supabase auth
  const [user, setUser] = useState<User | null>(null)
  const [authLoading, setAuthLoading] = useState(true)
  const supabase = createSupabaseBrowser()
  const autoConnectAttempted = useRef(false)

  useEffect(() => {
    getBrowserUser(supabase).then((user) => {
      setUser(user)
      setAuthLoading(false)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
    })
    return () => subscription.unsubscribe()
  }, [])

  // Back to where sign-in was asked for (?next=/browser), else the dashboard.
  // Same-site paths only, so the link can't send anyone elsewhere.
  const nextPath = () => {
    const n = new URLSearchParams(window.location.search).get('next')
    if (!n) return '/dashboard'
    try {
      const u = new URL(n, window.location.origin)
      return u.origin === window.location.origin ? u.pathname + u.search + u.hash : '/dashboard'
    } catch { return '/dashboard' }
  }

  useEffect(() => {
    if (user && !authLoading) {
      window.location.href = nextPath()
    }
  }, [user, authLoading])

  const signOut = async () => {
    await supabase.auth.signOut()
    // The /chat live-session records + cached transcripts belong to this account.
    try { clearSignOutLocalState(localStorage) } catch {}
    setUser(null)
    autoConnectAttempted.current = false
  }

  // Setup wizard — only shown when explicitly triggered from settings (handleRerunSetup)
  // Auth flow replaces the setup wizard for new users; no auto-trigger on first visit

  // Load stored prefs
  useEffect(() => {
    const sp = localStorage.getItem('osborn-provider') as Provider | null
    const sv = localStorage.getItem('osborn-voice-arch') as VoiceArch | null
    const sa = localStorage.getItem('osborn-coding-agent') as CodingAgent | null
    const su = localStorage.getItem('osborn-agent-url')
    if (sp) setProvider(sp)
    if (sv) setVoiceArch(sv)
    if (sa) setCodingAgent(sa)
    if (su) setAgentUrl(su)
  }, [])

  // Persist prefs
  useEffect(() => {
    localStorage.setItem('osborn-provider', provider)
    localStorage.setItem('osborn-voice-arch', voiceArch)
    localStorage.setItem('osborn-coding-agent', codingAgent)
    localStorage.setItem('osborn-agent-url', agentUrl)
  }, [provider, voiceArch, codingAgent, agentUrl])

  // All voice sessions now live at /chat (wrapped by ChatSessionProvider
  // via app/chat/layout.tsx). This page just builds the URL and navigates.
  // The provider owns the LiveKitRoom, so edits to chat/page.tsx or
  // VoiceRoom.tsx during dev don't tear down the WebRTC connection.
  const navigateToChat = useCallback((sessionId?: string | null, sessionCwd?: string | null) => {
    setConnectError(null)
    const params = new URLSearchParams({
      provider,
      voiceArch,
      agent: codingAgent,
      agentUrl,
    })
    if (sessionId) params.set('session', sessionId)
    // Forward the session's slug-derived cwd (file location on the
    // agent host) so the agent boots Claude Code at the matching slug.
    // Without this, ParticipantConnected falls back to defaultWorkingDir
    // and Claude Code's --resume lookup misses any session that doesn't
    // live in the default slug → "No conversation found". Mirrors the
    // dashboard's `startChat(sessionId, sessionCwd)` plumbing.
    if (sessionCwd) params.set('workingDirectory', sessionCwd)
    router.push(`/chat?${params.toString()}`)
  }, [provider, voiceArch, codingAgent, agentUrl, router])

  const autoConnect = useCallback(() => {
    // The /chat provider already handles "find existing room code vs
    // create fresh" — just forward.
    navigateToChat()
  }, [navigateToChat])

  const handleJoinRoom = useCallback((_code: string, sessionId?: string | null, sessionCwd?: string | null) => {
    navigateToChat(sessionId, sessionCwd)
  }, [navigateToChat])

  const handleNewSession = useCallback(() => { navigateToChat() }, [navigateToChat])

  const handleWizardComplete = useCallback((u: string) => {
    localStorage.setItem('osborn-setup-completed', 'true')
    setShowWizard(false)
    if (u) setAgentUrl(u)
  }, [])

  const handleWizardSkip = useCallback(() => {
    localStorage.setItem('osborn-setup-completed', 'true')
    setShowWizard(false)
  }, [])

  // ─── SETUP WIZARD ────────────────────────────────────────
  if (showWizard) {
    return (
      <main className="min-h-screen bg-[var(--background)] flex items-center justify-center p-8">
        <SetupWizard onComplete={handleWizardComplete} onSkip={handleWizardSkip} />
      </main>
    )
  }

  // ─── SESSION BROWSER ─────────────────────────────────────
  if (showSessionBrowser) {
    return (
      <main className="min-h-screen bg-[var(--background)] flex items-center justify-center p-8">
        <SessionBrowser
          provider={provider} voiceArch={voiceArch} codingAgent={codingAgent}
          onProviderChange={setProvider} onVoiceArchChange={setVoiceArch} onCodingAgentChange={setCodingAgent}
          agentUrl={agentUrl} onAgentUrlChange={setAgentUrl}
          onJoinRoom={handleJoinRoom} onNewSession={handleNewSession}
          roomCode={roomCode} onRerunSetup={() => setShowWizard(true)}
        />
      </main>
    )
  }

  // ─── LANDING / LOGIN ──────────────────────────────────────
  return (
    <>
      <style>{`
        @keyframes enter { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes orb-idle {
          0%, 100% { transform: scale(1); filter: brightness(1); }
          50% { transform: scale(1.04); filter: brightness(1.15); }
        }
        @keyframes grain {
          0%, 100% { transform: translate(0, 0); }
          10% { transform: translate(-5%, -10%); }
          30% { transform: translate(3%, -15%); }
          50% { transform: translate(12%, 9%); }
          70% { transform: translate(9%, 4%); }
          90% { transform: translate(-1%, 7%); }
        }
      `}</style>
      <main className="min-h-screen bg-[var(--background)] flex items-center justify-center p-6 relative overflow-hidden">
        {/* Subtle grain overlay */}
        <div className="fixed inset-0 pointer-events-none opacity-[0.03] z-50"
          style={{
            backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
            animation: 'grain 8s steps(10) infinite',
          }} />

        {/* Ambient glow */}
        <div className="fixed top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full pointer-events-none"
          style={{ background: 'radial-gradient(circle, var(--accent-glow) 0%, transparent 70%)' }} />

        <div className="w-full max-w-[360px] flex flex-col gap-6 relative z-10"
          style={{ animation: 'enter 0.5s ease both' }}>

          {/* Hero: Orb + Brand — links home (only way back from /login) */}
          <a href="/" className="flex flex-col items-center gap-5 pt-4 pb-2 group" aria-label="Voice Native home">
            <div className="relative w-16 h-16">
              <div className="absolute inset-0 rounded-full"
                style={{
                  background: 'radial-gradient(circle at 35% 35%, var(--accent) 0%, var(--accent-dim) 100%)',
                  animation: 'orb-idle 4s ease-in-out infinite',
                  boxShadow: '0 0 40px var(--accent-glow), inset 0 -4px 12px rgba(0,0,0,0.3)',
                }} />
              <svg className="absolute inset-0 m-auto" width="22" height="22" viewBox="0 0 24 24" fill="none"
                stroke="var(--background)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                <line x1="12" y1="19" x2="12" y2="23"/>
                <line x1="8" y1="23" x2="16" y2="23"/>
              </svg>
            </div>
            <div className="text-center">
              {/* #141: the public product name is "Voice Native" — "Osborn" is
                  the internal agent name and must not front the sign-in page. */}
              <h1 className="text-[var(--text-primary)] text-2xl font-semibold tracking-[-0.03em] group-hover:text-[var(--accent)] transition-colors">
                Voice Native
              </h1>
              <p className="text-[var(--text-secondary)] text-[13px] mt-1 tracking-wide uppercase">
                The AI you talk to
              </p>
            </div>
          </a>

          {/* ── Auth card ──────────────────────────────────── */}
          <div ref={authCardRef} className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-6 flex flex-col gap-3"
            style={{ animation: 'enter 0.5s ease 0.1s both' }}>

            {user ? (
              /* ── Authenticated: show user + connect ────── */
              <>
                <div className="flex items-center gap-3 pb-2">
                  {user.user_metadata?.avatar_url ? (
                    <img src={user.user_metadata.avatar_url} alt="" className="w-9 h-9 rounded-full ring-1 ring-[var(--border)]" />
                  ) : (
                    <div className="w-9 h-9 rounded-full bg-[var(--accent-dim)] flex items-center justify-center text-xs font-semibold text-[var(--background)]">
                      {(user.email?.[0] || '?').toUpperCase()}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-[var(--text-primary)] text-sm font-medium truncate">
                      {user.user_metadata?.full_name || user.email}
                    </p>
                    <p className="text-[var(--text-muted)] text-xs truncate">{user.email}</p>
                  </div>
                  <button onClick={signOut}
                    className="text-[var(--text-muted)] text-xs hover:text-[var(--text-secondary)] transition-colors">
                    Sign out
                  </button>
                </div>

                <button onClick={autoConnect}
                  className="w-full h-12 rounded-xl font-semibold text-[15px] tracking-[-0.01em] transition-all duration-150 active:scale-[0.98]"
                  style={{
                    background: 'linear-gradient(135deg, var(--accent) 0%, var(--accent-dim) 100%)',
                    color: 'var(--background)',
                    boxShadow: '0 1px 2px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.1)',
                  }}>
                  Start talking
                </button>

                {connectError && (
                  <p className="text-red-400 text-xs text-center">{connectError}</p>
                )}

                <div className="flex items-center justify-between pt-1">
                  {/* Do NOT render the raw agent/sandbox URL here — it leaks the
                      machine hostname on the login page. Show a neutral label;
                      the actual endpoint stays in the (gated) settings panel. */}
                  <span className="text-[var(--text-muted)] text-[11px] truncate max-w-[240px]">
                    Connection settings
                  </span>
                  <button onClick={() => setShowSettings(s => !s)}
                    className="text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors text-sm p-1">
                    {showSettings ? '×' : '⚙'}
                  </button>
                </div>
              </>
            ) : (
              /* ── Not authenticated: login buttons ─────── */
              <>
                {authLoading ? (
                  <div className="h-24 flex items-center justify-center">
                    <div className="w-5 h-5 border-2 border-[var(--border)] border-t-[var(--accent)] rounded-full animate-spin" />
                  </div>
                ) : (
                  <>
                    <EmailOtpLogin supabase={supabase} />

                    {connectError && (
                      <p className="text-red-400 text-xs text-center">{connectError}</p>
                    )}

                    <p className="text-[var(--text-muted)] text-[11px] text-center leading-relaxed pt-1">
                      By continuing you agree to our{' '}
                      <a href="/terms" className="underline underline-offset-2 hover:text-[var(--text-secondary)]">Terms</a>
                      {' '}and{' '}
                      <a href="/privacy" className="underline underline-offset-2 hover:text-[var(--text-secondary)]">Privacy</a>.
                    </p>
                  </>
                )}
              </>
            )}

            {/* ── Settings (collapsible) ───────────────── */}
            <div className="overflow-hidden transition-all duration-200"
              style={{ maxHeight: showSettings ? 320 : 0, opacity: showSettings ? 1 : 0 }}>
              <div className="flex flex-col gap-3 pt-3 border-t border-[var(--border)]">

                <label className="flex flex-col gap-1">
                  <span className="text-[var(--text-secondary)] text-[11px] uppercase tracking-wider">Agent URL</span>
                  <input type="text" value={agentUrl}
                    onChange={e => { setAgentUrl(e.target.value); localStorage.setItem('osborn-agent-url', e.target.value) }}
                    className="w-full h-9 max-sm:h-11 bg-[var(--background)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] text-[13px] max-sm:text-base px-3 font-mono outline-none focus:border-[var(--accent)]" />
                </label>

                {/* Toggle rows */}
                <ToggleRow label="Voice" options={[['pipeline','Pipeline'],['direct','Direct'],['realtime','Realtime']]}
                  value={voiceArch} onChange={v => setVoiceArch(v as VoiceArch)} />

                <ToggleRow label="Provider" options={[['gemini','Gemini'],['openai','OpenAI']]}
                  value={provider} onChange={v => setProvider(v as Provider)} />

                <ToggleRow label="Agent" options={[['claude','Claude'],['codex','Codex']]}
                  value={codingAgent} onChange={v => setCodingAgent(v as CodingAgent)} />

                <button onClick={() => setShowSessionBrowser(true)}
                  className="text-[var(--accent)] text-[13px] hover:underline underline-offset-2 text-left mt-1">
                  Browse sessions
                </button>
              </div>
            </div>
          </div>

          {/* ── Footer ──────────────────────────────────── */}
          <p className="text-center text-[var(--text-muted)] text-[11px] tracking-wide"
            style={{ animation: 'enter 0.5s ease 0.2s both' }}>
            Research deeply. Build faster.
          </p>
        </div>
      </main>
    </>
  )
}

/* ── Toggle pill component ─────────────────────────────── */
function ToggleRow({ label, options, value, onChange }: {
  label: string
  options: [string, string][]
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[var(--text-secondary)] text-[11px] uppercase tracking-wider">{label}</span>
      <div className="inline-flex rounded-full border border-[var(--border)] overflow-hidden">
        {options.map(([v, l]) => (
          <button key={v} onClick={() => onChange(v)}
            className="px-3 py-1 max-sm:min-h-9 max-sm:px-3.5 text-[12px] border-none cursor-pointer transition-all duration-150"
            style={{
              background: value === v ? 'var(--accent)' : 'transparent',
              color: value === v ? 'var(--background)' : 'var(--text-secondary)',
              fontWeight: value === v ? 600 : 400,
            }}>
            {l}
          </button>
        ))}
      </div>
    </div>
  )
}
