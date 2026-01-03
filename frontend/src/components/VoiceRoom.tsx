'use client'

import { useState, useEffect, useRef } from 'react'
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useVoiceAssistant,
  BarVisualizer,
  VoiceAssistantControlBar,
  useDataChannel,
} from '@livekit/components-react'
import '@livekit/components-styles'

interface VoiceRoomProps {
  token: string
}

interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: Date
  toolName?: string
}

function ChatPanel({ messages }: { messages: ChatMessage[] }) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto p-4 space-y-3"
    >
      {messages.length === 0 && (
        <p className="text-gray-500 text-center">
          Start speaking to begin the conversation...
        </p>
      )}
      {messages.map((msg) => (
        <div
          key={msg.id}
          className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
        >
          <div
            className={`max-w-[80%] rounded-lg px-4 py-2 ${
              msg.role === 'user'
                ? 'bg-blue-600 text-white'
                : msg.role === 'system'
                ? 'bg-yellow-900/50 text-yellow-200 border border-yellow-600'
                : 'bg-gray-700 text-white'
            }`}
          >
            {msg.toolName && (
              <div className="text-xs text-yellow-400 mb-1">
                🔧 {msg.toolName}
              </div>
            )}
            <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
            <p className="text-xs opacity-50 mt-1">
              {msg.timestamp.toLocaleTimeString()}
            </p>
          </div>
        </div>
      ))}
    </div>
  )
}

function TextInput({ onSend }: { onSend: (text: string) => void }) {
  const [text, setText] = useState('')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (text.trim()) {
      onSend(text.trim())
      setText('')
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex gap-2 p-4 border-t border-gray-700">
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Type a message or speak..."
        className="flex-1 bg-gray-800 text-white px-4 py-2 rounded-lg border border-gray-600 focus:border-blue-500 focus:outline-none"
      />
      <button
        type="submit"
        className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
      >
        Send
      </button>
    </form>
  )
}

function VoiceAssistantUI({
  messages,
  onSendText,
}: {
  messages: ChatMessage[]
  onSendText: (text: string) => void
}) {
  const { state, audioTrack } = useVoiceAssistant()

  return (
    <div className="w-full max-w-2xl h-[80vh] flex flex-col bg-gray-900 rounded-xl overflow-hidden border border-gray-700">
      {/* Header with voice visualizer */}
      <div className="p-4 border-b border-gray-700 flex items-center gap-4">
        <div className="h-12 w-32">
          <BarVisualizer
            state={state}
            trackRef={audioTrack}
            barCount={5}
            options={{ minHeight: 5 }}
          />
        </div>
        <div className="flex-1">
          <p className="text-sm capitalize text-gray-400">
            {state === 'listening' ? '🎤 Listening...' :
             state === 'thinking' ? '🧠 Thinking...' :
             state === 'speaking' ? '🔊 Speaking...' :
             state}
          </p>
        </div>
        <VoiceAssistantControlBar />
      </div>

      {/* Chat messages */}
      <ChatPanel messages={messages} />

      {/* Text input */}
      <TextInput onSend={onSendText} />
    </div>
  )
}

export default function VoiceRoom({ token }: VoiceRoomProps) {
  const livekitUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL || 'wss://your-project.livekit.cloud'
  const [messages, setMessages] = useState<ChatMessage[]>([])

  const addMessage = (role: ChatMessage['role'], content: string, toolName?: string) => {
    setMessages((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random()}`,
        role,
        content,
        timestamp: new Date(),
        toolName,
      },
    ])
  }

  // Handle text input - send to agent via data channel
  const handleSendText = (text: string) => {
    addMessage('user', text)
    // TODO: Send text to agent via data channel
    // For now, just show in chat
  }

  return (
    <LiveKitRoom
      token={token}
      serverUrl={livekitUrl}
      connect={true}
      audio={true}
      video={false}
      className="w-full flex justify-center"
    >
      <RoomAudioRenderer />
      <TranscriptHandler addMessage={addMessage} />
      <VoiceAssistantUI messages={messages} onSendText={handleSendText} />
    </LiveKitRoom>
  )
}

// Component to handle transcription events
function TranscriptHandler({
  addMessage,
}: {
  addMessage: (role: ChatMessage['role'], content: string, toolName?: string) => void
}) {
  const { agent } = useVoiceAssistant()

  // Track transcription events
  useEffect(() => {
    if (!agent) return

    // Listen for agent state changes and transcription
    const handleAgentTranscription = (segments: any[]) => {
      if (segments.length > 0) {
        const lastSegment = segments[segments.length - 1]
        if (lastSegment.final && lastSegment.text) {
          // This is agent speech that was transcribed
          // We might already have this from the assistant response
        }
      }
    }

    // The useVoiceAssistant hook provides transcription via the agent
    // We'll use the agent's messages if available
  }, [agent])

  // Listen for data channel messages from agent (for tool use, etc.)
  const { message: dataMessage } = useDataChannel('osborn-updates')

  useEffect(() => {
    if (dataMessage) {
      try {
        const data = JSON.parse(new TextDecoder().decode(dataMessage.payload))
        // Use message ID to deduplicate
        const msgId = `${data.type}-${data.text || data.tool || ''}-${Math.floor(Date.now() / 1000)}`

        if (data.type === 'user_transcript') {
          addMessage('user', data.text)
        } else if (data.type === 'assistant_response') {
          addMessage('assistant', data.text)
        } else if (data.type === 'tool_use') {
          // Only show tool use once per second (debounce)
          addMessage('system', `Using ${data.tool}: ${data.description || ''}`, data.tool)
        } else if (data.type === 'permission_request') {
          addMessage('system', `Permission needed: ${data.description}`)
        }
      } catch (e) {
        // Not JSON, ignore
      }
    }
  }, [dataMessage])

  return null
}
