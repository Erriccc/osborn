'use client'

import { useState, useEffect, useCallback } from 'react'
import VoiceRoom from '@/components/VoiceRoom'

type Provider = 'openai' | 'gemini'
type VoiceArch = 'realtime' | 'pipelined'
type CodingAgent = 'claude' | 'codex'
type ConnectionState = 'disconnected' | 'waiting' | 'connected'

export default function Home() {
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected')
  const [token, setToken] = useState<string | null>(null)
  const [roomCode, setRoomCode] = useState<string | null>(null)
  const [roomInput, setRoomInput] = useState<string>('')
  const [provider, setProvider] = useState<Provider>('openai')
  const [voiceArch, setVoiceArch] = useState<VoiceArch>('realtime')
  const [codingAgent, setCodingAgent] = useState<CodingAgent>('claude')
  const [isConnecting, setIsConnecting] = useState(false)
  const [copied, setCopied] = useState(false)
  const [agentStatus, setAgentStatus] = useState<string>('waiting')

  // Check for stored preferences on mount
  useEffect(() => {
    const storedRoom = localStorage.getItem('osborn-room-code')
    const storedProvider = localStorage.getItem('osborn-provider') as Provider | null
    const storedVoiceArch = localStorage.getItem('osborn-voice-arch') as VoiceArch | null
    const storedAgent = localStorage.getItem('osborn-coding-agent') as CodingAgent | null

    if (storedRoom) setRoomCode(storedRoom)
    if (storedProvider) setProvider(storedProvider)
    if (storedVoiceArch) setVoiceArch(storedVoiceArch)
    if (storedAgent) setCodingAgent(storedAgent)
  }, [])

  // Save preferences when changed
  useEffect(() => {
    localStorage.setItem('osborn-provider', provider)
    localStorage.setItem('osborn-voice-arch', voiceArch)
    localStorage.setItem('osborn-coding-agent', codingAgent)
  }, [provider, voiceArch, codingAgent])

  // Handle agent ready signal from VoiceRoom
  const handleAgentReady = useCallback(() => {
    setAgentStatus('connected')
    setConnectionState('connected')
  }, [])

  const joinRoom = async (code: string) => {
    setIsConnecting(true)
    try {
      const url = `/api/token?provider=${provider}&voiceArch=${voiceArch}&codingAgent=${codingAgent}&roomCode=${code}`
      const res = await fetch(url)
      const data = await res.json()

      setToken(data.token)
      setRoomCode(data.roomCode)
      localStorage.setItem('osborn-room-code', data.roomCode)
      setAgentStatus('waiting')
      setConnectionState('waiting')
    } catch (error) {
      console.error('Failed to join room:', error)
    } finally {
      setIsConnecting(false)
    }
  }

  const startSession = async () => {
    // If room input is provided, join that room
    if (roomInput.trim()) {
      return joinRoom(roomInput.trim())
    }
    // Otherwise use stored room code or generate new
    const existingCode = localStorage.getItem('osborn-room-code')
    if (existingCode) {
      return joinRoom(existingCode)
    }
    // Generate new room (legacy flow - frontend creates room)
    setIsConnecting(true)
    try {
      const url = `/api/token?provider=${provider}&voiceArch=${voiceArch}&codingAgent=${codingAgent}`
      const res = await fetch(url)
      const data = await res.json()

      setToken(data.token)
      setRoomCode(data.roomCode)
      localStorage.setItem('osborn-room-code', data.roomCode)
      setConnectionState('waiting')
    } catch (error) {
      console.error('Failed to start session:', error)
    } finally {
      setIsConnecting(false)
    }
  }

  const connect = () => {
    setConnectionState('connected')
  }

  const disconnect = () => {
    setConnectionState('disconnected')
    setToken(null)
    // Don't clear room code - allow reconnection with same code
  }

  const newSession = () => {
    localStorage.removeItem('osborn-room-code')
    setRoomCode(null)
    setConnectionState('disconnected')
    setToken(null)
  }

  const copyCommand = () => {
    navigator.clipboard.writeText(`npx osborn-agent --room ${roomCode}`)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-8">
      <h1 className="text-4xl font-bold mb-8">Osborn</h1>
      <p className="text-gray-400 mb-8">Voice AI Coding Assistant</p>

      {connectionState === 'disconnected' && (
        <div className="flex flex-col items-center gap-6">
          {/* Voice Provider selector */}
          <div className="text-center">
            <p className="text-sm text-gray-500 mb-2">Voice Provider</p>
            <div className="flex gap-4">
              <button
                onClick={() => setProvider('openai')}
                className={`px-4 py-2 rounded-lg border-2 transition-colors ${
                  provider === 'openai'
                    ? 'border-blue-500 bg-blue-500/20 text-blue-400'
                    : 'border-gray-600 text-gray-400 hover:border-gray-500'
                }`}
              >
                OpenAI
              </button>
              <button
                onClick={() => setProvider('gemini')}
                className={`px-4 py-2 rounded-lg border-2 transition-colors ${
                  provider === 'gemini'
                    ? 'border-green-500 bg-green-500/20 text-green-400'
                    : 'border-gray-600 text-gray-400 hover:border-gray-500'
                }`}
              >
                Gemini
              </button>
            </div>
          </div>

          {/* Voice Architecture selector */}
          <div className="text-center">
            <p className="text-sm text-gray-500 mb-2">Voice Architecture</p>
            <div className="flex gap-4">
              <button
                onClick={() => setVoiceArch('realtime')}
                className={`px-4 py-2 rounded-lg border-2 transition-colors ${
                  voiceArch === 'realtime'
                    ? 'border-cyan-500 bg-cyan-500/20 text-cyan-400'
                    : 'border-gray-600 text-gray-400 hover:border-gray-500'
                }`}
              >
                Realtime
                <span className="block text-xs opacity-70">Speech-to-Speech</span>
              </button>
              <button
                onClick={() => setVoiceArch('pipelined')}
                className={`px-4 py-2 rounded-lg border-2 transition-colors ${
                  voiceArch === 'pipelined'
                    ? 'border-pink-500 bg-pink-500/20 text-pink-400'
                    : 'border-gray-600 text-gray-400 hover:border-gray-500'
                }`}
              >
                Pipelined
                <span className="block text-xs opacity-70">STT → LLM → TTS</span>
              </button>
            </div>
          </div>

          {/* Coding Agent selector */}
          <div className="text-center">
            <p className="text-sm text-gray-500 mb-2">Coding Agent</p>
            <div className="flex gap-4">
              <button
                onClick={() => setCodingAgent('claude')}
                className={`px-4 py-2 rounded-lg border-2 transition-colors ${
                  codingAgent === 'claude'
                    ? 'border-orange-500 bg-orange-500/20 text-orange-400'
                    : 'border-gray-600 text-gray-400 hover:border-gray-500'
                }`}
              >
                Claude Code
              </button>
              <button
                onClick={() => setCodingAgent('codex')}
                className={`px-4 py-2 rounded-lg border-2 transition-colors ${
                  codingAgent === 'codex'
                    ? 'border-purple-500 bg-purple-500/20 text-purple-400'
                    : 'border-gray-600 text-gray-400 hover:border-gray-500'
                }`}
              >
                OpenAI Codex
              </button>
            </div>
          </div>

          {/* Room code input */}
          <div className="text-center w-full max-w-sm">
            <p className="text-sm text-gray-500 mb-2">Join Existing Room (from agent)</p>
            <div className="flex gap-2">
              <input
                type="text"
                value={roomInput}
                onChange={(e) => setRoomInput(e.target.value.toLowerCase())}
                placeholder="Enter room code..."
                className="flex-1 px-4 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none font-mono"
              />
              <button
                onClick={() => joinRoom(roomInput.trim())}
                disabled={isConnecting || !roomInput.trim()}
                className="px-4 py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-600 disabled:cursor-not-allowed rounded-lg font-medium transition-colors"
              >
                Join
              </button>
            </div>
          </div>

          <div className="flex items-center gap-4 text-gray-500">
            <div className="h-px bg-gray-700 flex-1" />
            <span className="text-sm">or</span>
            <div className="h-px bg-gray-700 flex-1" />
          </div>

          <button
            onClick={startSession}
            disabled={isConnecting}
            className="px-6 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 disabled:cursor-wait rounded-lg text-lg font-medium transition-colors"
          >
            {isConnecting ? 'Starting...' : roomCode ? 'Reconnect' : 'Create New Room'}
          </button>

          {roomCode && (
            <p className="text-sm text-gray-500">
              Previous session: <span className="font-mono text-gray-400">{roomCode}</span>
              <button
                onClick={newSession}
                className="ml-2 text-red-400 hover:text-red-300"
              >
                (new session)
              </button>
            </p>
          )}
        </div>
      )}

      {/* Unified view for waiting and connected states - keeps VoiceRoom mounted */}
      {(connectionState === 'waiting' || connectionState === 'connected') && roomCode && token && (
        <div className="flex flex-col items-center gap-6 w-full max-w-2xl">
          {/* Agent connection panel - show when waiting */}
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
                  {provider === 'openai' ? '🔵 OpenAI' : '🟢 Gemini'} {voiceArch === 'pipelined' ? '⚡ Pipelined' : '🎙️ Realtime'} + {codingAgent === 'claude' ? '🟠 Claude' : '🟣 Codex'}
                </span>
              </div>
            </div>
          )}

          {/* VoiceRoom stays mounted across waiting->connected transition */}
          <VoiceRoom
            token={token}
            onDisconnect={disconnect}
            onAgentReady={handleAgentReady}
            waitingMode={connectionState === 'waiting' && agentStatus !== 'connected'}
          />

          {connectionState === 'waiting' && agentStatus !== 'connected' && (
            <button
              onClick={newSession}
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
