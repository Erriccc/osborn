'use client'

import { useState } from 'react'
import VoiceRoom from '@/components/VoiceRoom'

type LLMProvider = 'openai' | 'gemini'
type CodingAgent = 'claude' | 'codex'

export default function Home() {
  const [isConnected, setIsConnected] = useState(false)
  const [token, setToken] = useState<string | null>(null)
  const [provider, setProvider] = useState<LLMProvider>('openai')
  const [codingAgent, setCodingAgent] = useState<CodingAgent>('claude')
  const [isConnecting, setIsConnecting] = useState(false)

  const connect = async () => {
    setIsConnecting(true)
    try {
      const res = await fetch(`/api/token?provider=${provider}&codingAgent=${codingAgent}`)
      const data = await res.json()
      setToken(data.token)
      setIsConnected(true)
    } catch (error) {
      console.error('Failed to get token:', error)
    } finally {
      setIsConnecting(false)
    }
  }

  const disconnect = () => {
    setIsConnected(false)
    setToken(null)
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-8">
      <h1 className="text-4xl font-bold mb-8">Osborn</h1>
      <p className="text-gray-400 mb-8">Voice AI Coding Assistant</p>

      {!isConnected ? (
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
            onClick={connect}
            disabled={isConnecting}
            className="px-6 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 disabled:cursor-wait rounded-lg text-lg font-medium transition-colors"
          >
            {isConnecting ? 'Connecting...' : 'Connect to Voice'}
          </button>
        </div>
      ) : (
        <VoiceRoom token={token!} onDisconnect={disconnect} />
      )}
    </main>
  )
}
