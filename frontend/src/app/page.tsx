'use client'

import { useState, useEffect } from 'react'
import VoiceRoom from '@/components/VoiceRoom'

type LLMProvider = 'openai' | 'gemini'
type CodingAgent = 'claude' | 'codex'
type ConnectionState = 'disconnected' | 'waiting' | 'connected'

export default function Home() {
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected')
  const [token, setToken] = useState<string | null>(null)
  const [roomCode, setRoomCode] = useState<string | null>(null)
  const [provider, setProvider] = useState<LLMProvider>('openai')
  const [codingAgent, setCodingAgent] = useState<CodingAgent>('claude')
  const [isConnecting, setIsConnecting] = useState(false)
  const [copied, setCopied] = useState(false)

  // Check for stored room code on mount (for reconnection)
  useEffect(() => {
    const stored = localStorage.getItem('osborn-room-code')
    if (stored) {
      setRoomCode(stored)
    }
  }, [])

  const startSession = async () => {
    setIsConnecting(true)
    try {
      // Use stored room code if available, otherwise generate new one
      const existingCode = localStorage.getItem('osborn-room-code')
      const url = existingCode
        ? `/api/token?provider=${provider}&codingAgent=${codingAgent}&roomCode=${existingCode}`
        : `/api/token?provider=${provider}&codingAgent=${codingAgent}`

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
                OpenAI Realtime
              </button>
              <button
                onClick={() => setProvider('gemini')}
                className={`px-4 py-2 rounded-lg border-2 transition-colors ${
                  provider === 'gemini'
                    ? 'border-green-500 bg-green-500/20 text-green-400'
                    : 'border-gray-600 text-gray-400 hover:border-gray-500'
                }`}
              >
                Gemini Live
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

          <button
            onClick={startSession}
            disabled={isConnecting}
            className="px-6 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 disabled:cursor-wait rounded-lg text-lg font-medium transition-colors"
          >
            {isConnecting ? 'Starting...' : roomCode ? 'Reconnect' : 'Start Session'}
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

      {connectionState === 'waiting' && roomCode && (
        <div className="flex flex-col items-center gap-6 max-w-lg">
          <div className="text-center p-6 bg-gray-800 rounded-xl border border-gray-700">
            <p className="text-gray-400 mb-4">Run this command on your machine:</p>
            <div className="flex items-center gap-2 bg-gray-900 rounded-lg p-3">
              <code className="flex-1 text-green-400 font-mono text-sm">
                npx osborn-agent --room {roomCode}
              </code>
              <button
                onClick={copyCommand}
                className="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-sm transition-colors"
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <p className="text-xs text-gray-500 mt-3">
              Make sure you have Node.js installed and your API keys configured
            </p>
          </div>

          <div className="text-center">
            <div className="animate-pulse text-yellow-400 mb-2">
              Waiting for agent to connect...
            </div>
            <p className="text-sm text-gray-500">
              Room Code: <span className="font-mono text-white">{roomCode}</span>
            </p>
          </div>

          <div className="flex gap-4">
            <button
              onClick={connect}
              className="px-4 py-2 bg-green-600 hover:bg-green-700 rounded-lg transition-colors"
            >
              Agent Connected? Start Voice
            </button>
            <button
              onClick={newSession}
              className="px-4 py-2 bg-gray-600 hover:bg-gray-700 rounded-lg transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {connectionState === 'connected' && token && (
        <VoiceRoom token={token} onDisconnect={disconnect} />
      )}
    </main>
  )
}
