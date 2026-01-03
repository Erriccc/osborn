'use client'

import { useState } from 'react'
import VoiceRoom from '@/components/VoiceRoom'

type LLMProvider = 'openai' | 'gemini'

export default function Home() {
  const [isConnected, setIsConnected] = useState(false)
  const [token, setToken] = useState<string | null>(null)
  const [provider, setProvider] = useState<LLMProvider>('openai')

  const connect = async () => {
    try {
      const res = await fetch(`/api/token?provider=${provider}`)
      const data = await res.json()
      setToken(data.token)
      setIsConnected(true)
    } catch (error) {
      console.error('Failed to get token:', error)
    }
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-8">
      <h1 className="text-4xl font-bold mb-8">Osborn</h1>
      <p className="text-gray-400 mb-8">Voice AI Coding Assistant</p>

      {!isConnected ? (
        <div className="flex flex-col items-center gap-6">
          {/* Provider selector */}
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

          <button
            onClick={connect}
            className="px-6 py-3 bg-blue-600 hover:bg-blue-700 rounded-lg text-lg font-medium transition-colors"
          >
            Connect to Voice
          </button>
        </div>
      ) : (
        <VoiceRoom token={token!} />
      )}
    </main>
  )
}
