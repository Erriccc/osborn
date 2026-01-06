# Osborn Voice Architecture V3 - Simplified Event-Driven Design

**Status**: Implemented ✅

## Overview

This document defines the simplified architecture for Osborn, focusing on:
1. **Gemini as the conversation manager** (fast voice I/O)
2. **Claude Code as the coding brain** (background worker with event streaming)
3. **Event-based feedback loop** (Claude events → Gemini → User)

## What Changed (from V2)

- ❌ Removed `conversation-brain.ts` - Gemini handles conversation directly
- ❌ Removed `thinkAndDecideTool` - simplified to just `run_code`
- ✅ Simplified `bridge-llm.ts` - only createBridgeLLM function
- ✅ Changed STT to **OpenAI Whisper** for better accuracy
- ✅ Kept agent pool (3 Plan + 1 Execute) for parallel research
- ✅ Kept both realtime and pipelined modes

---

## Core Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           FRONTEND (React/Next.js)                          │
│  • LiveKit Client SDK for WebRTC                                            │
│  • Voice visualization, chat UI                                             │
│  • Permission approval buttons                                              │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │ WebRTC
                                  ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│                        LIVEKIT AGENT (Node.js)                              │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                    VOICE SESSION (Pipeline or Realtime)                 ││
│  │                                                                         ││
│  │  PIPELINE MODE:                                                         ││
│  │  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐                ││
│  │  │ OpenAI STT   │ → │ Gemini 2.5   │ → │ Gemini TTS   │                ││
│  │  │ (Whisper)    │   │ Pro (Bridge) │   │ (Puck voice) │                ││
│  │  └──────────────┘   └──────┬───────┘   └──────────────┘                ││
│  │                            │                                            ││
│  │  REALTIME MODE:            │ Tools                                      ││
│  │  ┌──────────────────────┐  │                                            ││
│  │  │ Gemini 2.5 Pro Live  │  │                                            ││
│  │  │ (Speech-to-Speech)   │──┘                                            ││
│  │  └──────────────────────┘                                               ││
│  │         OR                                                              ││
│  │  ┌──────────────────────┐                                               ││
│  │  │ OpenAI Realtime      │                                               ││
│  │  │ (gpt-4o-realtime)    │                                               ││
│  │  └──────────────────────┘                                               ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                    │                                        │
│                                    ↓ Tool: run_code / research              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                      CLAUDE CODE HANDLER                                ││
│  │                                                                         ││
│  │  • Maintains session with Claude Agent SDK                              ││
│  │  • Emits events via EventEmitter:                                       ││
│  │    - tool_use: "Reading auth.ts..."                                     ││
│  │    - tool_result: "Found 3 type errors"                                 ││
│  │    - thinking: "Analyzing the authentication flow"                      ││
│  │    - complete: "Fixed the bug in login()"                               ││
│  │                                                                         ││
│  │  • Receives context injection via hooks:                                ││
│  │    - Stop hook: Add user's new context                                  ││
│  │    - UserPromptSubmit: Prepend additional info                          ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                    │                                        │
│                                    ↓ Events stream back                     │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                      EVENT → SPEECH BRIDGE                              ││
│  │                                                                         ││
│  │  Claude Event                    Gemini Action                          ││
│  │  ────────────────────────────────────────────────────                   ││
│  │  tool_use(Read, auth.ts)    →    session.say("Reading auth.ts...")      ││
│  │  tool_use(Edit, auth.ts)    →    session.say("Editing auth.ts...")      ││
│  │  tool_result(success)       →    session.say("Done, found 3 issues")    ││
│  │  thinking(analysis)         →    session.say("Analyzing the code...")   ││
│  │  complete(result)           →    session.say("Here's what I found...")  ││
│  │                                                                         ││
│  │  Note: In realtime mode, we queue these for next turn                   ││
│  │  In pipeline mode, we can session.say() immediately                     ││
│  └─────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Voice Mode Configurations

### Pipeline Mode (Current Default)
```typescript
// In index.ts createPipelinedSession()
const pipelinedSession = {
  stt: 'openai-whisper',      // Best accuracy for coding terms
  llm: 'gemini-2.5-pro',      // Smart conversation manager
  tts: 'gemini',              // Free tier (Puck voice)
}
```

**Advantages:**
- Can `session.say()` anytime (including during Claude Code execution)
- Full control over speech output
- Event-based updates work naturally

**Disadvantages:**
- Higher latency than realtime (STT + LLM + TTS round trips)

### Realtime Mode (Gemini)
```typescript
const realtimeSession = {
  model: 'gemini-2.5-pro',
  modalities: ['AUDIO'],      // Native speech-to-speech
}
```

**Advantages:**
- Lowest latency for conversation
- Natural voice interaction

**Disadvantages:**
- Cannot `session.say()` mid-tool (must wait for tool completion)
- Events need to be queued for next turn

### Realtime Mode (OpenAI)
```typescript
const realtimeSession = {
  model: 'gpt-4o-realtime-preview',
  modalities: ['audio', 'text'],
}
```

**Advantages:**
- Very fast, natural conversation
- Good for quick back-and-forth

**Disadvantages:**
- Expensive ($0.06/min audio)
- Same mid-tool limitation as Gemini realtime

---

## Event-Based Feedback Loop

### Claude Code → Gemini Flow

```typescript
// In claude-handler.ts (already implemented)
class ClaudeHandler extends EventEmitter {
  async run(prompt: string) {
    for await (const message of query({ prompt, options })) {
      // Emit events for each action
      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'tool_use') {
            this.emit('tool_use', {
              name: block.name,
              input: block.input,
              description: this.describeToolUse(block)
            });
          }
          if (block.type === 'text') {
            this.emit('thinking', { content: block.text });
          }
        }
      }
    }
  }
}

// In index.ts - Event listener bridge
claudeHandler.on('tool_use', async (event) => {
  const message = `${event.description}`;

  if (currentVoiceArch === 'pipelined') {
    // Speak immediately
    await currentSession.say(message);
  } else {
    // Queue for next turn (realtime mode)
    pendingUpdates.push(message);
  }

  // Also send to frontend for visual display
  await sendToFrontend({ type: 'progress_update', text: message });
});
```

### Context Injection (User → Claude Code)

```typescript
// When user speaks while Claude is working
async function injectContext(newContext: string) {
  // Option 1: Queue for next Claude turn
  pendingContext.push(newContext);

  // Option 2: Use Stop hook to inject immediately
  // (If Claude is at a stopping point)

  // Acknowledge to user
  if (currentVoiceArch === 'pipelined') {
    await currentSession.say("Got it, I'll let Claude know");
  }
}

// In Claude handler hooks
hooks: {
  Stop: [{
    hooks: [async (input, id, { signal }) => {
      if (pendingContext.length > 0) {
        const context = pendingContext.join('\n');
        pendingContext = [];
        return {
          decision: 'block',
          reason: `User added context: ${context}`
        };
      }
      return {};
    }]
  }]
}
```

---

## Current Code Structure

```
agent/src/
├── index.ts              # Main entry, voice session management, agent pool
├── voice-io.ts           # STT/TTS/VAD factory functions
├── bridge-llm.ts         # Bridge LLM factory (Gemini/GPT-4o for pipelined mode)
├── claude-handler.ts     # Claude Agent SDK wrapper with event streaming
├── codex-handler.ts      # Codex SDK wrapper (optional)
├── status-manager.ts     # Progress tracking for research tasks
└── config.ts             # Configuration management
```

### Removed Files
- ❌ `conversation-brain.ts` - Was extra layer, now Gemini handles directly

---

## Implementation Phases

### Phase 1: Simplify (This Session)
1. Remove unused code (ConversationBrain, bridge-llm)
2. Simplify agent pool to 1 Claude instance
3. Clean up redundant event handlers
4. Update STT to OpenAI Whisper

### Phase 2: Event Bridge (This Session)
1. Implement Claude event → Gemini speech bridge
2. Add context injection via Stop hook
3. Test pipeline mode with event streaming

### Phase 3: Polish (Next Session)
1. Add Codex SDK support with same event pattern
2. Implement realtime mode event queuing
3. Add research agent instances (optional)

---

## Configuration

### config.yaml
```yaml
voice:
  defaultMode: pipelined    # or 'realtime'
  defaultProvider: gemini   # or 'openai'

pipelined:
  stt:
    provider: openai-whisper
    model: whisper-1
  llm:
    provider: gemini
    model: gemini-2.5-pro
  tts:
    provider: gemini
    voice: Puck

realtime:
  gemini:
    model: gemini-2.5-pro
  openai:
    model: gpt-4o-realtime-preview

coding:
  agent: claude             # or 'codex'
  enableEvents: true
  eventVerbosity: normal    # 'minimal', 'normal', 'verbose'
```

---

## Open Questions

1. **Rate Limits**: Gemini TTS has 10 req/min limit. Should we:
   - Batch updates?
   - Fall back to OpenAI TTS?
   - Use shorter update messages?

2. **Agent Pool**: Should we keep multiple Claude instances for:
   - Parallel research?
   - Separate contexts?
   - Or simplify to single instance?

3. **Realtime Event Queuing**: How to present queued events when tool completes?
   - Single summary?
   - List of actions?
   - Only final result?
