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
  const PAGE_SIZE = 20
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)

  // Prefs
  const [provider, setProvider] = useState<Provider>('gemini')
  const [voiceArch, setVoiceArch] = useState<VoiceArch>('pipeline')

  // Auth check — allow unauthenticated access (shows limited UI)
  useEffect(() => {
    const timeout = setTimeout(() => setLoading(false), 3000) // Don't hang on slow Supabase
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
    if (u) setAgentUrl(u)
    if (p) setProvider(p)
    if (v) setVoiceArch(v)
  }, [])

  // Persist prefs
  useEffect(() => {
    localStorage.setItem('osborn-agent-url', agentUrl)
    localStorage.setItem('osborn-provider', provider)
    localStorage.setItem('osborn-voice-arch', voiceArch)
  }, [agentUrl, provider, voiceArch])

  // Fetch sessions from agent
  const fetchSessions = useCallback(async () => {
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
  }, [agentUrl])

  useEffect(() => { if (!loading) fetchSessions() }, [loading, fetchSessions])

  // Health check
  useEffect(() => {
    if (loading) return
    const check = () => fetch(`${agentUrl}/health`).then(() => setAgentOnline(true)).catch(() => setAgentOnline(false))
    check()
    const i = setInterval(check, 15000)
    return () => clearInterval(i)
  }, [agentUrl, loading])

  const signOut = async () => {
    await supabase.auth.signOut()
    window.location.href = '/'
  }

  const startChat = (sessionId?: string) => {
    const params = new URLSearchParams({
      provider, voiceArch, agent: 'claude', agentUrl,
    })
    if (sessionId) params.set('session', sessionId)
    router.push(`/chat?${params.toString()}`)
  }

  const formatDate = (ts: string) => {
    const d = new Date(ts)
    const now = new Date()
    const diff = now.getTime() - d.getTime()
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
      `}</style>
      <main className="min-h-screen bg-[var(--background)] flex flex-col">
        {/* ── Top bar ─────────────────────────────────── */}
        <header className="sticky top-0 z-40 border-b border-[var(--border-subtle)] bg-[var(--background)]/80 backdrop-blur-md">
          <div className="max-w-2xl mx-auto px-4 h-14 flex items-center justify-between">
            <div className="flex items-center gap-3">
              {/* Orb */}
              <div className="w-7 h-7 rounded-full flex items-center justify-center"
                style={{ background: 'linear-gradient(135deg, var(--accent) 0%, var(--accent-dim) 100%)' }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--background)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                </svg>
              </div>
              <span className="text-[var(--text-primary)] font-semibold text-[15px] tracking-tight">Osborn</span>
            </div>

            <div className="flex items-center gap-2">
              {/* Status dot */}
              <div className="flex items-center gap-1.5 mr-2">
                <div className={`w-1.5 h-1.5 rounded-full ${agentOnline === true ? 'bg-emerald-400' : agentOnline === false ? 'bg-red-400' : 'bg-[var(--text-muted)]'}`} />
                <span className="text-[11px] text-[var(--text-muted)]">
                  {agentOnline === true ? 'Online' : agentOnline === false ? 'Offline' : '...'}
                </span>
              </div>

              {/* Settings */}
              <button onClick={() => setShowSettings(s => !s)}
                className="p-2 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface)] transition-all">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                </svg>
              </button>

              {/* Avatar */}
              <button onClick={signOut} title="Sign out"
                className="flex items-center gap-2 p-1 rounded-lg hover:bg-[var(--surface)] transition-all group">
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

        {/* ── Settings panel (slides down) ──────────── */}
        <div className="overflow-hidden transition-all duration-200 border-b border-[var(--border-subtle)]"
          style={{ maxHeight: showSettings ? 280 : 0, opacity: showSettings ? 1 : 0 }}>
          <div className="max-w-2xl mx-auto px-4 py-4 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-[var(--text-secondary)] text-xs font-medium uppercase tracking-wider">Settings</span>
              <button onClick={signOut} className="text-red-400/70 text-xs hover:text-red-400 transition-colors">Sign out</button>
            </div>

            <label className="flex flex-col gap-1">
              <span className="text-[var(--text-muted)] text-[11px] uppercase tracking-wider">Agent URL</span>
              <input type="text" value={agentUrl}
                onChange={e => setAgentUrl(e.target.value)}
                className="w-full h-9 bg-[var(--background)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] text-[13px] px-3 font-mono outline-none focus:border-[var(--accent)] transition-colors" />
            </label>

            <div className="flex gap-4">
              <ToggleCompact label="Voice" options={[['pipeline','Pipeline'],['direct','Direct'],['realtime','Realtime']]}
                value={voiceArch} onChange={v => setVoiceArch(v as VoiceArch)} />
              <ToggleCompact label="Provider" options={[['gemini','Gemini'],['openai','OpenAI']]}
                value={provider} onChange={v => setProvider(v as Provider)} />
            </div>

            {user && (
              <p className="text-[var(--text-muted)] text-[11px]">
                {user.email} &middot; {user.app_metadata?.provider || 'email'}
              </p>
            )}
          </div>
        </div>

        {/* ── Content ──────────────────────────────────── */}
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

            {agentOnline === false && (
              <div className="text-center py-12" style={{ animation: 'fadeIn 0.3s ease both' }}>
                <div className="w-10 h-10 rounded-full bg-[var(--surface)] flex items-center justify-center mx-auto mb-3">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/>
                  </svg>
                </div>
                <p className="text-[var(--text-muted)] text-sm">Agent is offline</p>
                <p className="text-[var(--text-muted)] text-xs mt-1">Check that your agent is running at</p>
                <code className="text-[var(--text-muted)] text-xs font-mono">{agentUrl}</code>
              </div>
            )}

            {agentOnline && sessions.length === 0 && !sessionsLoading && (
              <div className="text-center py-12" style={{ animation: 'fadeIn 0.3s ease both' }}>
                <p className="text-[var(--text-muted)] text-sm">No conversations yet</p>
                <p className="text-[var(--text-muted)] text-xs mt-1">Start a new conversation to begin</p>
              </div>
            )}

            {sessions.slice(0, visibleCount).map((s, i) => (
              <button key={s.sessionId} onClick={() => startChat(s.sessionId)}
                className="w-full text-left p-4 rounded-2xl bg-[var(--surface)] border border-[var(--border-subtle)] hover:border-[var(--border)] transition-all group"
                style={{ animation: `enter 0.3s ease ${Math.min(i, 10) * 0.04}s both` }}>
                <div className="flex items-start gap-3">
                  {/* Avatar orb */}
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                    style={{ background: 'linear-gradient(135deg, var(--surface-raised) 0%, var(--border) 100%)' }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                    </svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    {/* Message preview */}
                    <p className="text-[var(--text-primary)] text-[14px] leading-relaxed line-clamp-2">
                      {s.lastMessage || 'New conversation'}
                    </p>
                    {/* Meta row */}
                    <div className="flex items-center gap-2 mt-2">
                      <span className="text-[var(--text-muted)] text-[11px]">{formatDate(s.timestamp)}</span>
                      {s.messageCount ? (
                        <span className="text-[var(--text-muted)] text-[11px] bg-[var(--surface-raised)] px-1.5 py-0.5 rounded-full">
                          {s.messageCount} messages
                        </span>
                      ) : null}
                    </div>
                  </div>
                  {/* Arrow on hover */}
                  <svg className="w-4 h-4 text-[var(--text-muted)] opacity-0 group-hover:opacity-60 transition-opacity shrink-0 mt-3"
                    viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="9 18 15 12 9 6"/>
                  </svg>
                </div>
              </button>
            ))}

            {/* Pagination */}
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
    <div className="flex flex-col gap-1">
      <span className="text-[var(--text-muted)] text-[11px] uppercase tracking-wider">{label}</span>
      <div className="inline-flex rounded-full border border-[var(--border)] overflow-hidden">
        {options.map(([v, l]) => (
          <button key={v} onClick={() => onChange(v)}
            className="px-2.5 py-1 text-[11px] border-none cursor-pointer transition-all"
            style={{
              background: value === v ? 'var(--accent)' : 'transparent',
              color: value === v ? 'var(--background)' : 'var(--text-muted)',
              fontWeight: value === v ? 600 : 400,
            }}>
            {l}
          </button>
        ))}
      </div>
    </div>
  )
}
