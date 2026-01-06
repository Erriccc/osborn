# Osborn Voice Architecture V4 - Direct SDK Integration

**Status**: In Progress

## Wrappers Created

- `claude-llm.ts` - Wraps Claude Agent SDK for LiveKit AgentSession
- `codex-llm.ts` - Wraps Codex Agent SDK for LiveKit AgentSession

## Overview

Direct voice-to-Claude/Codex integration. No middle layer.

```
┌─────────────────────────────────────────────────────────────┐
│                    ALWAYS LISTENING                          │
│              OpenAI Whisper STT (via LiveKit)                │
│                                                              │
│    User speaks → Whisper transcribes → Raw text              │
└─────────────────────────┬────────────────────────────────────┘
                          │
                          ↓ transcript event
┌─────────────────────────────────────────────────────────────┐
│                    TRANSCRIPT ROUTER                         │
│                                                              │
│    • Receives transcript from STT                            │
│    • Calls Claude/Codex SDK directly                         │
│    • Handles parallel context injection                      │
└─────────────────────────┬────────────────────────────────────┘
                          │
          ┌───────────────┴───────────────┐
          ↓                               ↓
┌─────────────────────┐         ┌─────────────────────┐
│   CLAUDE AGENT SDK  │         │   CODEX AGENT SDK   │
│                     │         │                     │
│   query({           │         │   codex.run({       │
│     prompt,         │         │     prompt,         │
│     options: {      │         │     ...             │
│       resume: sid   │         │   })                │
│     }               │         │                     │
│   })                │         │                     │
└─────────┬───────────┘         └─────────┬───────────┘
          │                               │
          │ text/tool events              │ text events
          └───────────────┬───────────────┘
                          │
                          ↓
┌─────────────────────────────────────────────────────────────┐
│                    TTS ENGINE                                │
│              (Gemini or OpenAI - direct call)                │
│                                                              │
│    Text chunks → synthesize() → Audio frames → User          │
└─────────────────────────────────────────────────────────────┘
```

---

## Key Components

### 1. Always-Listening STT

Use LiveKit's STT plugin in standalone mode (no LLM):

```typescript
import * as openai from '@livekit/agents-plugin-openai'

const stt = new openai.STT({ model: 'whisper-1' })

// Listen to audio track from room
const stream = stt.stream()
audioTrack.pipe(stream)

stream.on('transcript', (text: string, isFinal: boolean) => {
  if (isFinal) {
    handleUserSpeech(text)
  }
})
```

### 2. Direct Claude SDK Usage

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk'

let sessionId: string | null = null

async function handleUserSpeech(transcript: string) {
  console.log(`🎤 User: "${transcript}"`)

  // Call Claude directly - no wrapper
  for await (const message of query({
    prompt: transcript,
    options: {
      cwd: workingDirectory,
      permissionMode: 'acceptEdits',
      ...(sessionId && { resume: sessionId }),
    }
  })) {
    // Capture session for continuity
    if (message.type === 'system' && message.subtype === 'init') {
      sessionId = message.session_id
    }

    // Stream text to TTS
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') {
          await speakText(block.text)
        }
      }
    }

    // Send tool usage to frontend
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'tool_use') {
          sendToFrontend({ type: 'tool_use', tool: block.name })
        }
      }
    }
  }
}
```

### 3. Direct Codex SDK Usage

```typescript
import Codex from '@openai/codex'

const codex = new Codex({ apiKey: process.env.OPENAI_API_KEY })

async function handleUserSpeechCodex(transcript: string) {
  const response = await codex.run({
    prompt: transcript,
    // options...
  })

  await speakText(response.text)
}
```

### 4. Direct TTS (No AgentSession)

```typescript
import * as google from '@livekit/agents-plugin-google'

const tts = new (google.beta as any).TTS({
  model: 'gemini-2.5-flash-preview-tts',
  voice: 'Zephyr',
})

async function speakText(text: string) {
  const audio = await tts.synthesize(text)
  // Send audio frames to LiveKit room
  await localParticipant.publishData(audio, { reliable: true })
}
```

---

## Always-Listening + Context Injection

The key feature: user can speak while Claude is working.

```typescript
let claudeWorking = false
let pendingContext: string[] = []

async function handleUserSpeech(transcript: string) {
  if (claudeWorking) {
    // Claude is busy - queue context for injection
    pendingContext.push(transcript)
    await speakText("Got it, I'll add that context.")
    return
  }

  // Include any pending context
  const fullPrompt = pendingContext.length > 0
    ? `Additional context from user:\n${pendingContext.join('\n')}\n\nNew request: ${transcript}`
    : transcript
  pendingContext = []

  claudeWorking = true
  try {
    await runClaudeQuery(fullPrompt)
  } finally {
    claudeWorking = false
  }
}
```

---

## Simplified File Structure

```
agent/src/
├── index.ts              # Main: STT listener + SDK calls + TTS output
├── voice-io.ts           # STT/TTS factory functions (keep)
├── claude-handler.ts     # REMOVE or simplify to just session mgmt
├── codex-handler.ts      # REMOVE or simplify
├── config.ts             # Keep
└── status-manager.ts     # Keep for progress tracking
```

---

## Questions to Resolve

1. **LiveKit STT standalone mode**: Can we use STT without AgentSession?
   - Need to research: `stt.stream()` vs `AgentSession`

2. **TTS audio output**: How to send audio frames to room without AgentSession?
   - Option A: Raw audio frames via `publishTrack()`
   - Option B: Use minimal AgentSession with just STT+TTS (no LLM)

3. **Interruption handling**: How does user interrupt Claude mid-response?
   - Need to implement abort logic

---

## Next Steps

1. Research LiveKit STT/TTS standalone usage
2. Prototype minimal setup
3. Test latency: STT → Claude SDK → TTS
