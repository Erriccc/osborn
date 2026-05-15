'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createSupabaseBrowser } from '@/lib/supabase-browser'
import type { User } from '@supabase/supabase-js'
import SessionBrowser from '@/components/SessionBrowser'
import SetupWizard from '@/components/SetupWizard'

type Provider = 'gemini' | 'openai'
type VoiceArch = 'realtime' | 'pipelined' | 'direct' | 'pipeline'
type CodingAgent = 'claude' | 'codex'

export default function Home() {
  const router = useRouter()
  const [provider, setProvider] = useState<Provider>('gemini')
  const [voiceArch, setVoiceArch] = useState<VoiceArch>('pipeline')
  const [codingAgent, setCodingAgent] = useState<CodingAgent>('claude')
  const [roomCode, setRoomCode] = useState<string | null>(null)
  const [agentUrl, setAgentUrl] = useState<string>('http://localhost:8741')
  const [showWizard, setShowWizard] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showSessionBrowser, setShowSessionBrowser] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)

  // Supabase auth
  const [user, setUser] = useState<User | null>(null)
  const [authLoading, setAuthLoading] = useState(true)
  const supabase = createSupabaseBrowser()
  const autoConnectAttempted = useRef(false)

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      setUser(user)
      setAuthLoading(false)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
    })
    return () => subscription.unsubscribe()
  }, [])

  // Redirect authenticated users to dashboard
  useEffect(() => {
    if (user && !authLoading) {
      window.location.href = '/dashboard'
    }
  }, [user, authLoading])

  const signInWithProvider = async (p: 'google' | 'github') => {
    await supabase.auth.signInWithOAuth({
      provider: p,
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    })
  }

  const signOut = async () => {
    await supabase.auth.signOut()
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

          {/* ── Hero: Orb + Brand ──────────────────────────── */}
          <div className="flex flex-col items-center gap-5 pt-4 pb-2">
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
              <h1 className="text-[var(--text-primary)] text-2xl font-semibold tracking-[-0.03em]">
                Osborn
              </h1>
              <p className="text-[var(--text-secondary)] text-[13px] mt-1 tracking-wide uppercase">
                Voice-native AI
              </p>
            </div>
          </div>

          {/* ── Auth card ──────────────────────────────────── */}
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-6 flex flex-col gap-3"
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
                  <span className="text-[var(--text-muted)] text-[11px] font-mono truncate max-w-[240px]">
                    {agentUrl}
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
                    <button onClick={() => signInWithProvider('google')}
                      className="flex items-center justify-center gap-2.5 w-full h-11 bg-[var(--surface)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] text-[15px] font-medium hover:bg-[var(--surface-raised)] transition-colors cursor-pointer">
                      <svg width="18" height="18" viewBox="0 0 18 18">
                        <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.566 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
                        <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.909-2.259c-.806.54-1.837.86-3.047.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" fill="#34A853"/>
                        <path d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
                        <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
                      </svg>
                      Continue with Google
                    </button>

                    <button onClick={() => signInWithProvider('github')}
                      className="flex items-center justify-center gap-2.5 w-full h-11 bg-[var(--surface)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] text-[15px] font-medium hover:bg-[var(--surface-raised)] transition-colors cursor-pointer">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.929.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/>
                      </svg>
                      Continue with GitHub
                    </button>

                    <div className="flex items-center gap-3 py-1">
                      <div className="flex-1 h-px bg-[var(--border)]" />
                      <span className="text-[var(--text-muted)] text-[11px] uppercase tracking-widest">or</span>
                      <div className="flex-1 h-px bg-[var(--border)]" />
                    </div>

                    <button onClick={autoConnect}
                      className="w-full h-12 rounded-xl font-semibold text-[15px] tracking-[-0.01em] transition-all duration-150 active:scale-[0.98]"
                      style={{
                        background: 'linear-gradient(135deg, var(--accent) 0%, var(--accent-dim) 100%)',
                        color: 'var(--background)',
                        boxShadow: '0 1px 2px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.1)',
                      }}>
                      Connect without account
                    </button>

                    {connectError && (
                      <p className="text-red-400 text-xs text-center">{connectError}</p>
                    )}
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
                    className="w-full h-9 bg-[var(--background)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] text-[13px] px-3 font-mono outline-none focus:border-[var(--accent)]" />
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
            className="px-3 py-1 text-[12px] border-none cursor-pointer transition-all duration-150"
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
