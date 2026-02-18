'use client'

import { useState, useEffect, useCallback } from 'react'
import VoiceRoom from '@/components/VoiceRoom'
import SessionBrowser from '@/components/SessionBrowser'

type Provider = 'gemini' | 'openai'
type VoiceArch = 'realtime' | 'pipelined' | 'direct'
type CodingAgent = 'claude' | 'codex'
type ConnectionState = 'browsing' | 'waiting' | 'connected'

export default function Home() {
  const [connectionState, setConnectionState] = useState<ConnectionState>('browsing')
  const [token, setToken] = useState<string | null>(null)
  const [roomCode, setRoomCode] = useState<string | null>(null)
  const [provider, setProvider] = useState<Provider>('gemini')
  const [voiceArch, setVoiceArch] = useState<VoiceArch>('realtime')
  const [codingAgent, setCodingAgent] = useState<CodingAgent>('claude')
  const [copied, setCopied] = useState(false)
  const [agentStatus, setAgentStatus] = useState<string>('waiting')
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [agentUrl, setAgentUrl] = useState<string>('http://localhost:8741')

  // Load stored preferences on mount
  useEffect(() => {
    const storedRoom = localStorage.getItem('osborn-room-code')
    const storedProvider = localStorage.getItem('osborn-provider') as Provider | null
    const storedVoiceArch = localStorage.getItem('osborn-voice-arch') as VoiceArch | null
    const storedAgent = localStorage.getItem('osborn-coding-agent') as CodingAgent | null
    const storedAgentUrl = localStorage.getItem('osborn-agent-url')

    if (storedRoom) setRoomCode(storedRoom)
    if (storedProvider) setProvider(storedProvider)
    if (storedVoiceArch) setVoiceArch(storedVoiceArch)
    if (storedAgent) setCodingAgent(storedAgent)
    if (storedAgentUrl) setAgentUrl(storedAgentUrl)
  }, [])

  // Persist preferences
  useEffect(() => {
    localStorage.setItem('osborn-provider', provider)
    localStorage.setItem('osborn-voice-arch', voiceArch)
    localStorage.setItem('osborn-coding-agent', codingAgent)
    localStorage.setItem('osborn-agent-url', agentUrl)
  }, [provider, voiceArch, codingAgent, agentUrl])

  const handleAgentReady = useCallback(() => {
    setAgentStatus('connected')
    setConnectionState('connected')
  }, [])

  // Core: join a room code with optional session ID
  const joinRoom = async (code: string, sessionId?: string | null) => {
    try {
      let url = `/api/token?provider=${provider}&voiceArch=${voiceArch}&codingAgent=${codingAgent}&roomCode=${code}`
      if (sessionId) {
        url += `&sessionId=${encodeURIComponent(sessionId)}`
      }
      const res = await fetch(url)
      const data = await res.json()

      setToken(data.token)
      setRoomCode(data.roomCode)
      setSelectedSessionId(sessionId || null)
      localStorage.setItem('osborn-room-code', data.roomCode)
      setAgentStatus('waiting')
      setConnectionState('waiting')
    } catch (error) {
      console.error('Failed to join room:', error)
    }
  }

  // Frontend-first: generate a new room, wait for agent to join
  const connectFresh = async () => {
    try {
      const url = `/api/token?provider=${provider}&voiceArch=${voiceArch}&codingAgent=${codingAgent}`
      const res = await fetch(url)
      const data = await res.json()

      setToken(data.token)
      setRoomCode(data.roomCode)
      setSelectedSessionId(null)
      localStorage.setItem('osborn-room-code', data.roomCode)
      setAgentStatus('waiting')
      setConnectionState('waiting')
    } catch (error) {
      console.error('Failed to connect:', error)
    }
  }

  // SessionBrowser callbacks
  const handleJoinRoom = useCallback((code: string, sessionId?: string | null) => {
    joinRoom(code, sessionId)
  }, [provider, voiceArch, codingAgent])

  const handleNewSession = useCallback(() => {
    connectFresh()
  }, [provider, voiceArch, codingAgent])

  const disconnect = () => {
    setConnectionState('browsing')
    setToken(null)
    setSelectedSessionId(null)
  }

  const copyCommand = () => {
    navigator.clipboard.writeText(`npx osborn-agent --room ${roomCode}`)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-8">
      {/* Session Browser - landing page */}
      {connectionState === 'browsing' && (
        <SessionBrowser
          provider={provider}
          voiceArch={voiceArch}
          codingAgent={codingAgent}
          onProviderChange={setProvider}
          onVoiceArchChange={setVoiceArch}
          onCodingAgentChange={setCodingAgent}
          agentUrl={agentUrl}
          onAgentUrlChange={setAgentUrl}
          onJoinRoom={handleJoinRoom}
          onNewSession={handleNewSession}
          roomCode={roomCode}
        />
      )}

      {/* Waiting + Connected states - VoiceRoom stays mounted */}
      {(connectionState === 'waiting' || connectionState === 'connected') && roomCode && token && (
        <div className="flex flex-col items-center gap-6 w-full">
          {/* Waiting panel */}
          {connectionState === 'waiting' && agentStatus !== 'connected' && (
            <div className="w-full p-6 bg-gray-800 rounded-xl border border-gray-700">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-3 h-3 rounded-full bg-yellow-500 animate-pulse" />
                <span className="text-gray-300">Waiting for agent...</span>
              </div>

              <p className="text-gray-400 mb-3 text-sm">Run this command on your machine:</p>
              <div className="flex items-center gap-2 bg-gray-900 rounded-lg p-3 mb-3">
                <code className="flex-1 text-green-400 font-mono text-sm overflow-x-auto">
                  npm run room {roomCode}
                </code>
                <button
                  onClick={copyCommand}
                  className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-sm transition-colors shrink-0"
                >
                  {copied ? '✓' : 'Copy'}
                </button>
              </div>

              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-500">
                  Room: <span className="font-mono text-gray-300">{roomCode}</span>
                </span>
                <span className="text-gray-500">
                  {provider === 'gemini' ? 'Gemini' : 'OpenAI'} / {voiceArch === 'direct' ? 'Direct' : voiceArch === 'pipelined' ? 'Pipelined' : 'Realtime'} / {codingAgent === 'claude' ? 'Claude' : 'Codex'}
                </span>
              </div>
            </div>
          )}

          <VoiceRoom
            token={token}
            onDisconnect={disconnect}
            onAgentReady={handleAgentReady}
            waitingMode={connectionState === 'waiting' && agentStatus !== 'connected'}
            provider={provider}
            preSelectedSessionId={selectedSessionId}
          />

          {connectionState === 'waiting' && agentStatus !== 'connected' && (
            <button
              onClick={disconnect}
              className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
            >
              Cancel
            </button>
          )}
        </div>
      )}
    </main>
  )
}
