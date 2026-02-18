# Osborn v0.4.3 - Voice AI Research Assistant

## Architecture

Osborn is a voice AI assistant for software research and development. It uses LiveKit for real-time voice communication, Claude Agent SDK for research capabilities, and OpenAI/Gemini for native speech-to-speech interaction.

### Dual Voice Modes

| Mode | Stack | Best For |
|------|-------|----------|
| **Direct** | STT (Deepgram) → Claude Agent SDK → TTS (Deepgram) | Full research tasks, maximum tool access |
| **Realtime** | OpenAI Realtime / Gemini Live native speech-to-speech | Fast conversation, voice-first UX, delegates to Claude via `ask_agent` |

### Single Research Mode

No plan/execute/edit mode toggles. The agent operates in a single **research** mode with write safety (Write/Edit blocked outside `.osborn/sessions/`).

### System Diagram

```
Frontend (Next.js)  ←→  LiveKit Cloud  ←→  Agent (local machine)
                                              ├── Claude Agent SDK (research tools)
                                              ├── OpenAI/Gemini Realtime (voice)
                                              └── MCP Servers (GitHub, YouTube, etc.)
```

---

## Current Features

| Feature | Status |
|---------|--------|
| Voice interface (LiveKit) | Working |
| OpenAI Realtime voice | Working |
| Gemini Live voice | Working |
| Direct mode (STT → Claude → TTS) | Working |
| Claude Agent SDK tools (Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch) | Working |
| Permission system (voice + UI approval) | Working |
| Room code connection system | Working |
| Text input fallback | Working |
| Session management (resume, switch, browse) | Working |
| Session gate (startup session selection) | Working |
| Single research mode (write-safe) | Working |
| Session workspace (`.osborn/sessions/<uuid>/`) | Working |
| MCP server integration (GitHub, YouTube, etc.) | Working |
| Smithery cloud MCP proxy (`type: 'sdk'`) | Working |
| `ask_agent` tool (non-blocking, realtime → Claude) | Working |
| Unified voice injection queue | Working |
| Research event batching + voice queue | Working |
| Specificity prompts (no vague summaries) | Working |
| Adaptive verbosity (BRIEF/STANDARD/DETAILED/FULL) | Working |
| Anti-hallucination prompt (realtime mode) | Working |
| Markdown rendering in chat | Working |
| Task deduplication guard | Working |

---

## Key Files

| File | Purpose |
|------|---------|
| `agent/src/index.ts` | Main entry, room events, session creation, voice queue, data handlers |
| `agent/src/claude-llm.ts` | Claude Agent SDK wrapper, research mode systemPrompt, PreToolUse write safety |
| `agent/src/config.ts` | Config loading, session management, workspace helpers |
| `agent/src/smithery-proxy.ts` | In-process MCP proxy for Smithery cloud servers |
| `agent/src/voice-io.ts` | STT/TTS/VAD/Realtime model factory |
| `frontend/src/components/VoiceRoom.tsx` | Main UI component |
| `frontend/src/components/MarkdownMessage.tsx` | Markdown renderer |
| `frontend/src/components/SessionBrowser.tsx` | Session browser component |
| `frontend/src/lib/sessions.ts` | Session utilities (formatTime, groupSessionsByDate) |

---

## v0.4.3 Changes — Unified Voice Injection Queue

### Problem
Multiple code paths called `generateReply` independently (research updates, research complete, notifications, errors) without checking model availability. This caused `generateReply timed out waiting for generation_created event` errors when the model was busy speaking. The old system used `drainResearchQueue()` with `drainInFlight` guards and separate immediate/deferred `[RESEARCH COMPLETE]` injection paths, but these still raced.

### Solution
- **Unified `voiceQueue[]`**: Single queue for ALL system injections. `queueVoiceInjection()` adds items, `processVoiceQueue()` drains them.
- **State-machine gating**: `processVoiceQueue()` only calls `generateReply` when `agentState === 'listening'`. After the call, the model transitions to `thinking/speaking` → `listening`, which triggers `processVoiceQueue()` again via `agent_state_changed`.
- **Batched delivery**: Multiple queued items are combined into one `generateReply({ instructions, toolChoice: 'none' })` call.
- **Research batching**: `scheduleResearchBatch()` debounces rapid tool events (3s), formats as `[RESEARCH UPDATE]`, pushes to voice queue.
- **Specificity prompts**: `[RESEARCH COMPLETE]` mandates naming specific tools, packages, URLs. Adaptive verbosity defaults research to DETAILED tier (6-10 sentences).
- **Removed**: `drainResearchQueue()`, `scheduleDrain()`, `drainDebounceTimer`, `drainInFlight`, immediate/deferred dual paths, `.catch()` workarounds.

### Files Modified
| File | Changes |
|------|---------|
| `agent/src/index.ts` | Replaced drain system with `voiceQueue`/`queueVoiceInjection`/`processVoiceQueue`/`scheduleResearchBatch`. Updated `announceViaVoice()`, `[RESEARCH COMPLETE]`, error handler, cleanup paths. Added specificity prompts. |

---

## Configuration

### Environment Variables (agent/.env)
```env
LIVEKIT_URL=wss://your-livekit-url
LIVEKIT_API_KEY=your-api-key
LIVEKIT_API_SECRET=your-api-secret
OPENAI_API_KEY=your-openai-key
GOOGLE_API_KEY=your-google-key
ANTHROPIC_API_KEY=your-anthropic-key
SMITHERY_API_KEY=your-smithery-key  # Optional, for cloud MCP
```

### Config File (~/.osborn/config.yaml)
```yaml
workingDirectory: /path/to/project
defaultProvider: openai
voiceMode: realtime  # or 'direct'

realtime:
  provider: openai  # or 'gemini'
  openaiVoice: alloy
  geminiVoice: Puck

direct:
  stt:
    provider: deepgram
  tts:
    provider: deepgram
    voice: aura-asteria-en

mcpServers:
  github:
    enabled: true
```

---

Last Updated: 2025-02-17
