# Gemini Integration Plan for Osborn Voice Agent

## Overview

This document summarizes the research findings and technical plan for aligning the Gemini Live API integration with OpenAI Realtime API best practices in the Osborn voice agent project.

---

## Current Implementation Analysis

### File: `agent/src/index.ts`

The current implementation uses a provider-agnostic pattern that switches between OpenAI and Gemini based on participant metadata:

```typescript
function createModel(provider: string) {
  if (provider === 'gemini') {
    return new google.beta.realtime.RealtimeModel({
      model: 'gemini-2.5-flash-native-audio-preview-12-2025',
      voice: 'Puck',
    })
  } else {
    return new openai.realtime.RealtimeModel({
      voice: 'alloy',
    })
  }
}
```

---

## Key Differences: OpenAI vs Gemini

### 1. Model Configuration

| Aspect | OpenAI | Gemini |
|--------|--------|--------|
| Package | `@livekit/agents-plugin-openai` | `@livekit/agents-plugin-google` |
| API Access | `openai.realtime.RealtimeModel` | `google.beta.realtime.RealtimeModel` |
| Status | Stable | **Beta** |
| Environment Variable | `OPENAI_API_KEY` | `GOOGLE_API_KEY` |
| Default Model | `gpt-realtime` | `gemini-2.0-flash-live-001` |

### 2. Audio Configuration

| Aspect | OpenAI | Gemini |
|--------|--------|--------|
| Input Sample Rate | 24000 Hz | **16000 Hz** |
| Output Sample Rate | 24000 Hz | 24000 Hz |
| Channels | Mono (1) | Mono (1) |
| Chunk Size | 100ms | 50ms |

### 3. Turn Detection

| Feature | OpenAI | Gemini |
|---------|--------|--------|
| Default Type | `semantic_vad` | Server-controlled |
| Configuration | `turnDetection` object | `realtimeInputConfig` |
| Interruption | `response.cancel` event | Activity-based (`startUserActivity`) |
| Manual Mode | Not typical | `automaticActivityDetection.disabled` |

### 4. Voice Options

| OpenAI Voices | Gemini Voices |
|---------------|---------------|
| `alloy`, `echo`, `shimmer`, `ash`, `ballad`, `coral`, `sage`, `verse`, `marin` | `Puck`, `Charon`, `Kore`, `Fenrir`, `Aoede` |

### 5. Session Management

| Feature | OpenAI | Gemini |
|---------|--------|--------|
| Max Duration | 20 minutes | Uses `goAway` events |
| Reconnection | Manual rebuild | Session resumption via `sessionResumptionHandle` |
| Message Truncation | Supported | **Not supported** |
| Context Management | Server-side history | Manual client-side tracking |

### 6. Tool Calling

| Aspect | OpenAI | Gemini |
|--------|--------|--------|
| Tool Definitions | Native JSON schema | `functionDeclarations` via Google format |
| Tool Response | Direct response | `LiveClientToolResponse` with `functionResponses` |
| Maturity | More mature | Good but newer |

### 7. Pricing

| Provider | Cost |
|----------|------|
| OpenAI Realtime | ~$0.10/minute |
| Gemini Live | **Free during preview** |

---

## Debugging Checklist: Why Gemini May Not Be Working

### 1. Environment Variable Issues

```bash
# Verify GOOGLE_API_KEY is set
echo $GOOGLE_API_KEY

# Should output your API key (not empty)
```

**Check in code:**
```typescript
console.log('GOOGLE_API_KEY:', process.env.GOOGLE_API_KEY ? 'set' : 'NOT SET')
```

### 2. Model Name Issues

The Gemini model name may be incorrect or deprecated. Try these in order:

1. `gemini-2.0-flash-live-001` (most stable for AI Studio)
2. `gemini-2.0-flash-exp` (experimental, for Vertex AI)
3. `gemini-2.5-flash-native-audio-preview-12-2025` (newer, may have issues)

### 3. Beta API Access

Gemini Realtime is accessed via `google.beta.realtime` - ensure you're using the beta namespace:

```typescript
import * as google from '@livekit/agents-plugin-google'

// Correct
const model = new google.beta.realtime.RealtimeModel({...})

// Incorrect
const model = new google.realtime.RealtimeModel({...}) // This won't exist
```

### 4. Turn Detection Configuration

Gemini may require explicit turn detection configuration:

```typescript
const model = new google.beta.realtime.RealtimeModel({
  model: 'gemini-2.0-flash-live-001',
  voice: 'Puck',
  realtimeInputConfig: {
    automaticActivityDetection: {
      disabled: false, // Enable server VAD
    },
  },
})
```

### 5. Session Event Differences

Gemini emits different events than OpenAI. Add debugging:

```typescript
// These events are Gemini-specific
session.on('input_speech_started', () => console.log('🎤 Speech started'))
session.on('input_speech_stopped', () => console.log('🎤 Speech stopped'))
session.on('generation_created', () => console.log('🤖 Generation started'))
session.on('error', (ev) => console.error('❌ Error:', ev))
```

### 6. Connection Issues

Gemini uses WebSocket with Google's infrastructure. Check for:

- Network/firewall issues blocking Google APIs
- API quota limits
- Region restrictions

### 7. Audio Input Issues

Gemini requires 16kHz input audio (vs OpenAI's 24kHz). The SDK should handle resampling, but verify audio is being received:

```typescript
// Add to session events
session.on('input_audio_transcription_completed', (ev) => {
  console.log('📝 Transcribed:', ev.transcript)
})
```

---

## Recommended Code Changes

### 1. Enhanced Model Configuration

```typescript
function createModel(provider: string) {
  if (provider === 'gemini') {
    console.log('📱 Using Gemini Live API')
    console.log('🔑 GOOGLE_API_KEY:', process.env.GOOGLE_API_KEY ? 'set' : 'NOT SET')

    const model = new google.beta.realtime.RealtimeModel({
      model: 'gemini-2.0-flash-live-001', // Use stable model
      voice: 'Puck',
      language: 'en-US',
      inputAudioTranscription: {},  // Enable for debugging
      outputAudioTranscription: {}, // Enable for debugging
    })

    console.log('✅ Gemini model created')
    return model
  } else {
    console.log('📱 Using OpenAI Realtime API')
    console.log('🔑 OPENAI_API_KEY:', process.env.OPENAI_API_KEY ? 'set' : 'NOT SET')

    const model = new openai.realtime.RealtimeModel({
      voice: 'alloy',
      turnDetection: {
        type: 'semantic_vad',
        eagerness: 'medium',
        create_response: true,
        interrupt_response: true,
      },
    })

    console.log('✅ OpenAI model created')
    return model
  }
}
```

### 2. Enhanced Session Configuration

```typescript
const session = new voice.AgentSession({
  llm: model,
  turnDetection: 'realtime_llm', // Use the realtime model's turn detection
  voiceOptions: {
    allowInterruptions: true,
    minInterruptionDuration: 500,
    minEndpointingDelay: 500,
    maxEndpointingDelay: 6000,
  },
})
```

### 3. Provider-Specific Event Handling

```typescript
// Add after session creation
if (provider === 'gemini') {
  // Gemini-specific: Handle goAway events for session management
  session.on('error' as any, (ev: any) => {
    if (ev.error?.message?.includes('goAway')) {
      console.log('🔄 Gemini requesting session refresh...')
    }
  })
}

// Universal debugging events
session.on('input_speech_started' as any, () => {
  console.log('🎤 User started speaking')
})

session.on('input_speech_stopped' as any, () => {
  console.log('🎤 User stopped speaking')
})

session.on('generation_created' as any, () => {
  console.log('🤖 Agent generating response')
})

session.on('metrics_collected' as any, (metrics: any) => {
  console.log(`📊 Metrics [${provider}]:`, {
    ttftMs: metrics.ttftMs,
    durationMs: metrics.durationMs,
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
  })
})
```

### 4. Startup Validation

```typescript
function validateProvider(provider: string) {
  if (provider === 'gemini') {
    if (!process.env.GOOGLE_API_KEY) {
      throw new Error('❌ GOOGLE_API_KEY environment variable is required for Gemini')
    }
  } else if (provider === 'openai') {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('❌ OPENAI_API_KEY environment variable is required for OpenAI')
    }
  }
}

// Call in entry function
export default defineAgent({
  entry: async (ctx: JobContext) => {
    // ... existing code ...

    const provider = getProviderFromParticipant(participant.metadata)
    validateProvider(provider) // Add this

    const model = createModel(provider)
    // ...
  },
})
```

---

## Testing Steps

### Step 1: Verify Environment

```bash
# Check API keys
echo "OpenAI: ${OPENAI_API_KEY:0:10}..."
echo "Google: ${GOOGLE_API_KEY:0:10}..."
```

### Step 2: Test with Stable Gemini Model

Change the model to `gemini-2.0-flash-live-001` and test.

### Step 3: Enable Debug Logging

```bash
export DEBUG_LIVEKIT=true
```

### Step 4: Check LiveKit Agent Logs

Look for:
- "Connecting to Gemini Realtime API..."
- "Gemini Live session error:"
- "Gemini Live session closed:"

### Step 5: Compare Audio Flow

Test with OpenAI first to confirm audio pipeline works, then switch to Gemini.

---

## Priority Implementation Order

### High Priority (Do First)
1. [ ] Validate `GOOGLE_API_KEY` is set and valid
2. [ ] Switch to stable model `gemini-2.0-flash-live-001`
3. [ ] Add comprehensive session event logging
4. [ ] Add startup validation for environment variables

### Medium Priority
5. [ ] Enable audio transcription for debugging
6. [ ] Configure turn detection explicitly
7. [ ] Add metrics collection logging
8. [ ] Handle Gemini-specific error events

### Low Priority
9. [ ] Add voice selection UI support
10. [ ] Implement session resumption for long sessions
11. [ ] Add context window compression configuration

---

## Known Limitations

### Gemini-Specific
1. **No message truncation** - Cannot truncate messages mid-stream
2. **Beta status** - May have stability issues
3. **Manual context tracking** - No server-side history view
4. **Different interruption model** - Uses activity-based rather than event-based

### OpenAI-Specific
1. **20-minute session limit** - Requires reconnection for longer sessions
2. **Higher cost** - ~$0.10/minute vs free for Gemini preview

---

## References

### LiveKit Documentation
- [LiveKit Agents Overview](https://docs.livekit.io/agents/overview/)
- [Gemini Plugin Docs](https://docs.livekit.io/agents/models/realtime/plugins/gemini/)
- [OpenAI Plugin Docs](https://docs.livekit.io/agents/models/realtime/plugins/openai/)

### Source Code (Local)
- `agent/node_modules/@livekit/agents-plugin-google/src/beta/realtime/realtime_api.ts`
- `agent/node_modules/@livekit/agents-plugin-openai/src/realtime/realtime_model.ts`
- `agent/node_modules/@livekit/agents/src/voice/agent_session.ts`

### API Documentation
- [Google AI Studio API Keys](https://aistudio.google.com/apikey)
- [Gemini Live Supported Languages](https://ai.google.dev/gemini-api/docs/live#supported-languages)

---

## Next Steps

1. Apply the recommended code changes above
2. Run with `DEBUG_LIVEKIT=true` to capture detailed logs
3. Compare behavior between OpenAI and Gemini
4. Report specific error messages for further debugging
