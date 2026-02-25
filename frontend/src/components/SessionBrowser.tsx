'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { formatTime, groupSessionsByDate, type SessionInfo } from '@/lib/sessions'

type Provider = 'gemini' | 'openai'
type VoiceArch = 'realtime' | 'pipelined' | 'direct'
type CodingAgent = 'claude' | 'codex'

const PAGE_SIZE = 10

interface SessionBrowserProps {
  provider: Provider
  voiceArch: VoiceArch
  codingAgent: CodingAgent
  onProviderChange: (p: Provider) => void
  onVoiceArchChange: (v: VoiceArch) => void
  onCodingAgentChange: (c: CodingAgent) => void
  agentUrl: string
  onAgentUrlChange: (url: string) => void
  onJoinRoom: (code: string, sessionId?: string | null) => void
  onNewSession: () => void
  roomCode: string | null
  onRerunSetup?: () => void
}

const PROVIDER_LABELS: Record<Provider, string> = { gemini: 'Gemini',openai: 'OpenAI' }
const VOICE_LABELS: Record<VoiceArch, string> = { direct: 'Direct', realtime: 'Realtime', pipelined: 'Pipelined' }
const AGENT_LABELS: Record<CodingAgent, string> = { claude: 'Claude', codex: 'Codex' }

export default function SessionBrowser({
  provider,
  voiceArch,
  codingAgent,
  onProviderChange,
  onVoiceArchChange,
  onCodingAgentChange,
  agentUrl,
  onAgentUrlChange,
  onJoinRoom,
  onNewSession,
  roomCode,
  onRerunSetup,
}: SessionBrowserProps) {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [currentPage, setCurrentPage] = useState(0)
  const [roomInput, setRoomInput] = useState(roomCode || '')
  const [agentConnected, setAgentConnected] = useState(false)
  const [needsRoomCode, setNeedsRoomCode] = useState(false)
  const [hasFetched, setHasFetched] = useState(false)

  // Sync roomInput when roomCode prop changes
  useEffect(() => {
    if (roomCode) setRoomInput(roomCode)
  }, [roomCode])

  // Fetch sessions from agent's HTTP API — only called explicitly
  const fetchSessions = useCallback(async (url: string) => {
    setIsLoading(true)
    try {
      const baseUrl = url.replace(/\/+$/, '')
      const res = await fetch(`${baseUrl}/sessions`, { signal: AbortSignal.timeout(5000) })
      const data = await res.json()
      setSessions(data.sessions || [])
      setAgentConnected(true)
      setHasFetched(true)
    } catch {
      setSessions([])
      setAgentConnected(false)
      setHasFetched(true)
    } finally {
      setIsLoading(false)
    }
  }, [])

  // Connect to agent server — triggered by button click
  const handleConnect = () => {
    if (agentUrl.trim()) {
      fetchSessions(agentUrl)
    }
  }

  // Filter sessions by search query
  const filteredSessions = useMemo(() => {
    if (!searchQuery.trim()) return sessions
    const q = searchQuery.toLowerCase()
    return sessions.filter(s =>
      s.lastMessage?.toLowerCase().includes(q) ||
      s.sessionId.toLowerCase().includes(q)
    )
  }, [sessions, searchQuery])

  // Reset page when search changes
  useEffect(() => {
    setCurrentPage(0)
  }, [searchQuery])

  // Pagination
  const totalPages = Math.max(1, Math.ceil(filteredSessions.length / PAGE_SIZE))
  const paginatedSessions = filteredSessions.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
  const groupedSessions = useMemo(() => groupSessionsByDate(paginatedSessions), [paginatedSessions])

  // Join room with optional session — requires room code
  const handleJoin = (sessionId?: string | null) => {
    const code = roomInput.trim()
    if (code) {
      setNeedsRoomCode(false)
      onJoinRoom(code, sessionId || null)
    } else {
      setNeedsRoomCode(true)
    }
  }

  const handleNewSession = () => {
    const code = roomInput.trim()
    if (code) {
      setNeedsRoomCode(false)
      onJoinRoom(code, null)
    } else {
      onNewSession()
    }
  }

  const settingsSummary = `${PROVIDER_LABELS[provider]} / ${VOICE_LABELS[voiceArch]} / ${AGENT_LABELS[codingAgent]}`

  return (
    <div className="w-full max-w-lg mx-auto flex flex-col h-[85vh]">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Osborn</h1>
          <div className="flex items-center gap-2">
            <p className="text-sm text-gray-400">Voice AI Coding Assistant</p>
            {onRerunSetup && (
              <button
                onClick={onRerunSetup}
                className="text-xs text-violet-400 hover:text-violet-300 transition-colors"
              >
                Setup
              </button>
            )}
          </div>
        </div>
        <button
          onClick={handleNewSession}
          className="px-4 py-2 bg-gradient-to-r from-violet-500 to-purple-600 hover:from-violet-600 hover:to-purple-700 rounded-xl text-white text-sm font-medium transition-all shadow-lg shadow-violet-500/20"
        >
          + New Session
        </button>
      </div>

      {/* Room Code Input */}
      <div className="mb-4 p-4 bg-gray-800/60 rounded-xl border border-gray-700/50">
        <div className="flex gap-2">
          <input
            type="text"
            value={roomInput}
            onChange={(e) => { setRoomInput(e.target.value); setNeedsRoomCode(false) }}
            onKeyDown={(e) => e.key === 'Enter' && handleJoin(null)}
            placeholder="Enter room code from agent..."
            className={`flex-1 px-3 py-2.5 bg-gray-900 border rounded-lg text-white placeholder-gray-500 focus:border-violet-500/50 focus:ring-2 focus:ring-violet-500/20 focus:outline-none transition-all text-sm font-mono ${
              needsRoomCode ? 'border-red-500/70' : 'border-gray-700'
            }`}
          />
          <button
            onClick={() => handleJoin(null)}
            disabled={!roomInput.trim()}
            className="px-5 py-2.5 bg-violet-600 hover:bg-violet-700 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-white text-sm font-medium transition-colors shrink-0"
          >
            Join
          </button>
        </div>
        {needsRoomCode && (
          <p className="text-xs text-red-400 mt-1.5">Enter the room code shown in agent terminal</p>
        )}
        <p className="text-xs text-gray-500 mt-2">Start the agent server, then enter the room code shown in terminal</p>
      </div>

      {/* Agent Server Connection */}
      <div className="mb-4 p-4 bg-gray-800/60 rounded-xl border border-gray-700/50">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-sm font-medium text-gray-300">Agent Server</span>
          {hasFetched && (
            <div className={`flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${agentConnected ? 'bg-green-900/50 text-green-400' : 'bg-red-900/50 text-red-400'}`}>
              <div className={`w-1.5 h-1.5 rounded-full mr-1 ${agentConnected ? 'bg-green-400' : 'bg-red-400'}`} />
              {agentConnected ? 'Connected' : 'Offline'}
            </div>
          )}
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={agentUrl}
            onChange={(e) => { onAgentUrlChange(e.target.value); setAgentConnected(false); setHasFetched(false) }}
            onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
            placeholder="http://localhost:8741"
            className="flex-1 px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:border-violet-500/50 focus:ring-2 focus:ring-violet-500/20 focus:outline-none transition-all text-sm font-mono"
          />
          <button
            onClick={handleConnect}
            disabled={!agentUrl.trim() || isLoading}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-600 rounded-lg text-white text-sm font-medium transition-colors shrink-0"
          >
            {isLoading ? 'Loading...' : agentConnected ? 'Refresh' : 'Connect'}
          </button>
        </div>
        <p className="text-xs text-gray-500 mt-2">Connect to load previous sessions from your agent</p>
      </div>

      {/* Collapsible Settings */}
      <div className="mb-4 bg-gray-800 rounded-xl border border-gray-600">
        <button
          onClick={() => setSettingsOpen(!settingsOpen)}
          className="w-full flex items-center justify-between p-3.5"
        >
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <span className="text-sm font-semibold text-white">Settings</span>
            {!settingsOpen && (
              <span className="text-xs text-gray-400 ml-2">{settingsSummary}</span>
            )}
          </div>
          <svg
            className={`w-4 h-4 text-gray-400 transition-transform duration-200 ${settingsOpen ? 'rotate-180' : ''}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        <div className={`overflow-hidden transition-all duration-200 ${settingsOpen ? 'max-h-[500px] opacity-100' : 'max-h-0 opacity-0'}`}>
          <div className="px-4 pb-4 space-y-3">
            {/* Voice Provider */}
            <div className="flex items-center gap-3">
              <p className="text-sm text-gray-300 w-20 shrink-0">Provider</p>
              <div className="flex gap-2 flex-1">
                <button
                  onClick={() => onProviderChange('openai')}
                  className={`flex-1 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                    provider === 'openai'
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                >
                  OpenAI
                </button>
                <button
                  onClick={() => onProviderChange('gemini')}
                  className={`flex-1 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                    provider === 'gemini'
                      ? 'bg-green-600 text-white'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                >
                  Gemini
                </button>
              </div>
            </div>

            {/* Voice Architecture */}
            <div className="flex items-center gap-3">
              <p className="text-sm text-gray-300 w-20 shrink-0">Voice</p>
              <div className="flex gap-2 flex-1">
                <button
                  onClick={() => onVoiceArchChange('direct')}
                  className={`flex-1 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                    voiceArch === 'direct'
                      ? 'bg-green-600 text-white'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                >
                  Direct
                </button>
                <button
                  onClick={() => onVoiceArchChange('realtime')}
                  className={`flex-1 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                    voiceArch === 'realtime'
                      ? 'bg-cyan-600 text-white'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                >
                  Realtime
                </button>
                <button
                  onClick={() => onVoiceArchChange('pipelined')}
                  className={`flex-1 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                    voiceArch === 'pipelined'
                      ? 'bg-pink-600 text-white'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                >
                  Pipelined
                </button>
              </div>
            </div>

            {/* Coding Agent */}
            <div className="flex items-center gap-3">
              <p className="text-sm text-gray-300 w-20 shrink-0">Agent</p>
              <div className="flex gap-2 flex-1">
                <button
                  onClick={() => onCodingAgentChange('claude')}
                  className={`flex-1 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                    codingAgent === 'claude'
                      ? 'bg-orange-600 text-white'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                >
                  Claude Code
                </button>
                <button
                  onClick={() => onCodingAgentChange('codex')}
                  className={`flex-1 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                    codingAgent === 'codex'
                      ? 'bg-purple-600 text-white'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                >
                  Codex
                </button>
              </div>
            </div>

            {/* Re-run Setup Wizard */}
            {onRerunSetup && (
              <div className="pt-2 border-t border-gray-700/50">
                <button
                  onClick={onRerunSetup}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-gray-700/50 hover:bg-gray-600/50 rounded-lg text-sm text-gray-300 hover:text-white transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  Re-run Setup Wizard
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Sessions Section — only shown after connecting to agent */}
      {agentConnected && (
        <>
          {/* Search */}
          {sessions.length > 0 && (
            <div className="relative mb-3">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search sessions..."
                className="w-full pl-10 pr-4 py-2.5 bg-gray-800/50 border border-gray-700/50 rounded-xl text-white placeholder-gray-500 focus:border-violet-500/50 focus:ring-2 focus:ring-violet-500/20 focus:outline-none transition-all text-sm"
              />
            </div>
          )}

          {/* Session count */}
          {sessions.length > 0 && (
            <div className="text-sm text-gray-500 mb-2 px-1">
              {`Showing ${currentPage * PAGE_SIZE + 1}-${Math.min((currentPage + 1) * PAGE_SIZE, filteredSessions.length)} of ${filteredSessions.length} session${filteredSessions.length !== 1 ? 's' : ''}`}
            </div>
          )}
        </>
      )}

      {/* Session list */}
      <div className="flex-1 overflow-y-auto space-y-1 scrollbar-thin scrollbar-thumb-gray-700 scrollbar-track-transparent">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-16">
            <svg className="w-8 h-8 text-violet-500 animate-spin mb-3" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <p className="text-gray-400 text-sm">Connecting to agent...</p>
          </div>
        ) : !hasFetched ? (
          // Initial state — haven't connected yet
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="w-16 h-16 rounded-full bg-gradient-to-br from-violet-500/20 to-purple-600/20 flex items-center justify-center mb-4">
              <svg className="w-8 h-8 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
            </div>
            <h3 className="text-white font-medium mb-1">Ready to connect</h3>
            <p className="text-gray-400 text-sm max-w-xs">
              Enter a room code to join, or connect to your agent server to browse previous sessions
            </p>
          </div>
        ) : !agentConnected ? (
          // Tried to connect but failed
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="w-16 h-16 rounded-full bg-gradient-to-br from-red-500/20 to-red-600/20 flex items-center justify-center mb-4">
              <svg className="w-8 h-8 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
            </div>
            <h3 className="text-white font-medium mb-1">Could not reach agent</h3>
            <p className="text-gray-400 text-sm max-w-xs">
              Make sure the agent server is running and the URL is correct
            </p>
          </div>
        ) : filteredSessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="w-16 h-16 rounded-full bg-gradient-to-br from-violet-500/20 to-purple-600/20 flex items-center justify-center mb-4">
              <svg className="w-8 h-8 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 01-3 3z" />
              </svg>
            </div>
            <h3 className="text-white font-medium mb-1">
              {searchQuery ? 'No matching sessions' : 'No previous sessions'}
            </h3>
            <p className="text-gray-400 text-sm mb-4 max-w-xs">
              {searchQuery
                ? 'Try a different search term'
                : 'Enter the room code above to start your first session'}
            </p>
          </div>
        ) : (
          groupedSessions.map((group) => (
            <div key={group.label}>
              <div className="sticky top-0 bg-gray-950/95 backdrop-blur-sm px-2 py-1.5 z-10">
                <span className="text-sm font-medium text-gray-500 uppercase tracking-wider">{group.label}</span>
              </div>
              <div className="space-y-1.5 px-1">
                {group.sessions.map((session) => (
                  <button
                    key={session.sessionId}
                    onClick={() => handleJoin(session.sessionId)}
                    className="w-full text-left p-4 rounded-xl border border-gray-800/50 bg-gray-800/50 hover:border-violet-500/30 hover:bg-gray-800/70 transition-all group"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-base text-gray-200 group-hover:text-white transition-colors line-clamp-2 flex-1">
                        {session.lastMessage || 'No preview available'}
                      </p>
                      <span className="text-sm text-gray-400 shrink-0">{session.messageCount} msgs</span>
                    </div>
                    <p className="text-sm text-gray-400 mt-1.5">{formatTime(session.timestamp)}</p>
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Pagination */}
      {agentConnected && filteredSessions.length > PAGE_SIZE && (
        <div className="flex items-center justify-between pt-3 mt-2 border-t border-gray-800">
          <button
            onClick={() => setCurrentPage(p => Math.max(0, p - 1))}
            disabled={currentPage === 0}
            className="px-3 py-1.5 text-sm text-gray-400 hover:text-white disabled:text-gray-600 disabled:cursor-not-allowed transition-colors"
          >
            Prev
          </button>
          <span className="text-sm text-gray-500">
            Page {currentPage + 1} of {totalPages}
          </span>
          <button
            onClick={() => setCurrentPage(p => Math.min(totalPages - 1, p + 1))}
            disabled={currentPage >= totalPages - 1}
            className="px-3 py-1.5 text-sm text-gray-400 hover:text-white disabled:text-gray-600 disabled:cursor-not-allowed transition-colors"
          >
            Next
          </button>
        </div>
      )}
    </div>
  )
}
