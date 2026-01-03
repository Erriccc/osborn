'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
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
  onDisconnect?: () => void
}

interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: Date
  toolName?: string
}

interface PermissionRequest {
  toolName: string
  description: string
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

function PermissionModal({
  permission,
  onRespond,
}: {
  permission: PermissionRequest
  onRespond: (response: 'allow' | 'deny' | 'always_allow') => void
}) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-xl p-6 max-w-md w-full mx-4 border border-gray-600 shadow-xl">
        <div className="flex items-center gap-3 mb-4">
          <span className="text-2xl">⚠️</span>
          <h3 className="text-lg font-semibold text-white">Permission Required</h3>
        </div>

        <div className="mb-4">
          <p className="text-gray-300 mb-2">
            Claude wants to use: <span className="text-yellow-400 font-mono">{permission.toolName}</span>
          </p>
          <p className="text-gray-400 text-sm bg-gray-900 rounded-lg p-3 font-mono">
            {permission.description}
          </p>
        </div>

        <div className="flex gap-3">
          <button
            onClick={() => onRespond('deny')}
            className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 rounded-lg transition-colors text-white font-medium"
          >
            Deny
          </button>
          <button
            onClick={() => onRespond('allow')}
            className="flex-1 px-4 py-2 bg-green-600 hover:bg-green-700 rounded-lg transition-colors text-white font-medium"
          >
            Allow Once
          </button>
          <button
            onClick={() => onRespond('always_allow')}
            className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors text-white font-medium"
          >
            Always Allow
          </button>
        </div>

        <p className="text-gray-500 text-xs mt-4 text-center">
          Say "allow", "deny", or "always allow" to respond via voice
        </p>
      </div>
    </div>
  )
}

// Inner component that has access to LiveKit hooks
function VoiceRoomInner({ onDisconnect }: { onDisconnect?: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null)

  const { state, audioTrack } = useVoiceAssistant()

  // Data channel for receiving updates from agent
  const { message: dataMessage } = useDataChannel('osborn-updates')

  // Data channel for sending to agent
  const { send: sendToAgent } = useDataChannel('user-input')

  const addMessage = useCallback((role: ChatMessage['role'], content: string, toolName?: string) => {
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
  }, [])

  // Handle incoming data channel messages
  useEffect(() => {
    if (dataMessage) {
      try {
        const data = JSON.parse(new TextDecoder().decode(dataMessage.payload))

        if (data.type === 'user_transcript') {
          addMessage('user', data.text)
        } else if (data.type === 'assistant_response') {
          addMessage('assistant', data.text)
        } else if (data.type === 'tool_use') {
          addMessage('system', `Using ${data.tool}: ${data.description || ''}`, data.tool)
        } else if (data.type === 'permission_request') {
          // Show permission modal
          setPendingPermission({
            toolName: data.toolName,
            description: data.description,
          })
        } else if (data.type === 'permission_response') {
          // Permission was handled (possibly by voice)
          setPendingPermission(null)
        }
      } catch (e) {
        // Not JSON, ignore
      }
    }
  }, [dataMessage, addMessage])

  // Handle text input
  const handleSendText = useCallback((text: string) => {
    addMessage('user', text)
    // Send to agent via data channel
    const encoder = new TextEncoder()
    const payload = encoder.encode(JSON.stringify({
      type: 'user_text',
      content: text,
    }))
    sendToAgent(payload, { reliable: true })
  }, [addMessage, sendToAgent])

  // Handle permission response
  const handlePermissionResponse = useCallback((response: 'allow' | 'deny' | 'always_allow') => {
    const toolName = pendingPermission?.toolName || 'tool'
    setPendingPermission(null)
    addMessage('system', `Permission ${response}: ${toolName}`)

    // Send to agent via data channel
    const encoder = new TextEncoder()
    const payload = encoder.encode(JSON.stringify({
      type: 'permission_response',
      response,
    }))
    sendToAgent(payload, { reliable: true })
  }, [addMessage, sendToAgent, pendingPermission])

  return (
    <>
      {pendingPermission && (
        <PermissionModal
          permission={pendingPermission}
          onRespond={handlePermissionResponse}
        />
      )}
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
          {onDisconnect && (
            <button
              onClick={onDisconnect}
              className="px-3 py-1.5 text-sm bg-red-600/20 hover:bg-red-600/40 text-red-400 rounded-lg transition-colors border border-red-600/50"
            >
              Disconnect
            </button>
          )}
        </div>

        {/* Chat messages */}
        <ChatPanel messages={messages} />

        {/* Text input */}
        <TextInput onSend={handleSendText} />
      </div>
    </>
  )
}

export default function VoiceRoom({ token, onDisconnect }: VoiceRoomProps) {
  const livekitUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL || 'wss://your-project.livekit.cloud'

  return (
    <LiveKitRoom
      token={token}
      serverUrl={livekitUrl}
      connect={true}
      audio={true}
      video={false}
      className="w-full flex justify-center"
      onDisconnected={onDisconnect}
    >
      <RoomAudioRenderer />
      <VoiceRoomInner onDisconnect={onDisconnect} />
    </LiveKitRoom>
  )
}
