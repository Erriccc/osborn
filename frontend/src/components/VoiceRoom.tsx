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
  onAgentReady?: () => void
  waitingMode?: boolean
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

interface AttachedFile {
  file: File
  preview?: string
  type: 'image' | 'file'
}

function TextInput({
  onSend,
  attachedFiles,
  onAttachFile,
  onRemoveFile,
}: {
  onSend: (text: string, files?: AttachedFile[]) => void
  attachedFiles: AttachedFile[]
  onAttachFile: (files: FileList) => void
  onRemoveFile: (index: number) => void
}) {
  const [text, setText] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (text.trim() || attachedFiles.length > 0) {
      onSend(text.trim(), attachedFiles.length > 0 ? attachedFiles : undefined)
      setText('')
    }
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onAttachFile(e.target.files)
    }
    // Reset input so same file can be selected again
    e.target.value = ''
  }

  return (
    <div className="border-t border-gray-700">
      {/* Attached files preview */}
      {attachedFiles.length > 0 && (
        <div className="flex gap-2 p-3 pb-0 overflow-x-auto">
          {attachedFiles.map((af, idx) => (
            <div key={idx} className="relative group shrink-0">
              {af.type === 'image' && af.preview ? (
                <img
                  src={af.preview}
                  alt={af.file.name}
                  className="h-16 w-16 object-cover rounded-lg border border-gray-600"
                />
              ) : (
                <div className="h-16 w-16 bg-gray-700 rounded-lg border border-gray-600 flex items-center justify-center">
                  <span className="text-2xl">📄</span>
                </div>
              )}
              <button
                onClick={() => onRemoveFile(idx)}
                className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 rounded-full text-white text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              >
                ×
              </button>
              <p className="text-xs text-gray-500 truncate w-16 mt-1">{af.file.name}</p>
            </div>
          ))}
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex gap-2 p-3">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,.pdf,.txt,.md,.json,.ts,.tsx,.js,.jsx,.py,.go,.rs,.java,.c,.cpp,.h"
          onChange={handleFileSelect}
          className="hidden"
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg transition-colors text-gray-300"
          title="Attach file"
        >
          📎
        </button>
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type a message or speak..."
          className="flex-1 bg-gray-800 text-white px-4 py-2 rounded-lg border border-gray-600 focus:border-blue-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={!text.trim() && attachedFiles.length === 0}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed rounded-lg transition-colors"
        >
          Send
        </button>
      </form>
    </div>
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
function VoiceRoomInner({
  onDisconnect,
  onAgentReady,
  waitingMode,
}: {
  onDisconnect?: () => void
  onAgentReady?: () => void
  waitingMode?: boolean
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null)
  const [agentConnected, setAgentConnected] = useState(false)
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([])

  // Handle file attachments
  const handleAttachFile = useCallback((files: FileList) => {
    const newFiles: AttachedFile[] = Array.from(files).map((file) => {
      const isImage = file.type.startsWith('image/')
      return {
        file,
        type: isImage ? 'image' : 'file',
        preview: isImage ? URL.createObjectURL(file) : undefined,
      }
    })
    setAttachedFiles((prev) => [...prev, ...newFiles])
  }, [])

  const handleRemoveFile = useCallback((index: number) => {
    setAttachedFiles((prev) => {
      const file = prev[index]
      if (file.preview) URL.revokeObjectURL(file.preview)
      return prev.filter((_, i) => i !== index)
    })
  }, [])

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

        if (data.type === 'agent_ready') {
          // Agent is ready - notify parent
          console.log('🤖 Agent ready signal received!')
          setAgentConnected(true)
          onAgentReady?.()
        } else if (data.type === 'user_transcript') {
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
  }, [dataMessage, addMessage, onAgentReady])

  // Handle text input with optional files
  const handleSendText = useCallback(async (text: string, files?: AttachedFile[]) => {
    // Build message content
    let content = text
    const fileData: { name: string; type: string; content: string }[] = []

    // Process files if any
    if (files && files.length > 0) {
      for (const af of files) {
        // Read file as base64 for images, text for code files
        const isText = !af.file.type.startsWith('image/')
        if (isText) {
          const textContent = await af.file.text()
          fileData.push({
            name: af.file.name,
            type: 'text',
            content: textContent,
          })
          content += `\n\n[File: ${af.file.name}]\n${textContent.substring(0, 2000)}${textContent.length > 2000 ? '...(truncated)' : ''}`
        } else {
          // For images, convert to base64
          const base64 = await new Promise<string>((resolve) => {
            const reader = new FileReader()
            reader.onload = () => resolve(reader.result as string)
            reader.readAsDataURL(af.file)
          })
          fileData.push({
            name: af.file.name,
            type: 'image',
            content: base64,
          })
          content += `\n\n[Image attached: ${af.file.name}]`
        }
      }
      // Clear attached files after sending
      setAttachedFiles([])
    }

    addMessage('user', content)

    // Send to agent via data channel
    const encoder = new TextEncoder()
    const payload = encoder.encode(JSON.stringify({
      type: 'user_text',
      content: text,
      files: fileData.length > 0 ? fileData : undefined,
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

  // Waiting mode - minimal UI just to detect agent
  if (waitingMode) {
    return (
      <div className="w-full p-4 text-center">
        <div className="flex items-center justify-center gap-2 text-gray-400">
          <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
          <span className="text-sm">Listening for agent connection...</span>
        </div>
      </div>
    )
  }

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
          <div className="h-16 flex-1 flex items-center justify-center">
            <BarVisualizer
              state={state}
              trackRef={audioTrack}
              barCount={7}
              options={{ minHeight: 8 }}
            />
          </div>
          <div className="flex items-center gap-3">
            <div className={`px-3 py-1.5 rounded-full text-sm font-medium ${
              state === 'listening' ? 'bg-green-500/20 text-green-400' :
              state === 'thinking' ? 'bg-yellow-500/20 text-yellow-400' :
              state === 'speaking' ? 'bg-blue-500/20 text-blue-400' :
              'bg-gray-500/20 text-gray-400'
            }`}>
              {state === 'listening' ? '🎤 Listening' :
               state === 'thinking' ? '🧠 Thinking' :
               state === 'speaking' ? '🔊 Speaking' :
               state}
            </div>
            <VoiceAssistantControlBar />
            {onDisconnect && (
              <button
                onClick={onDisconnect}
                className="px-3 py-1.5 text-sm bg-red-600/20 hover:bg-red-600/40 text-red-400 rounded-lg transition-colors border border-red-600/50"
              >
                End
              </button>
            )}
          </div>
        </div>

        {/* Chat messages */}
        <ChatPanel messages={messages} />

        {/* Text input with file attachment */}
        <TextInput
          onSend={handleSendText}
          attachedFiles={attachedFiles}
          onAttachFile={handleAttachFile}
          onRemoveFile={handleRemoveFile}
        />
      </div>
    </>
  )
}

export default function VoiceRoom({
  token,
  onDisconnect,
  onAgentReady,
  waitingMode,
}: VoiceRoomProps) {
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
      <VoiceRoomInner
        onDisconnect={onDisconnect}
        onAgentReady={onAgentReady}
        waitingMode={waitingMode}
      />
    </LiveKitRoom>
  )
}
