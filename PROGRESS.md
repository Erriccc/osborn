# Osborn v0.4.9 - Voice AI Research Assistant

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
| Auto-approve workspace writes (no permission prompt) | Working |
| Permission system (voice + UI approval) | Working |
| Room code connection system | Working |
| Text input fallback | Working |
| Session management (resume, switch, browse) | Working |
| Session gate (startup session selection) | Working |
| Single research mode (write-safe) | Working |
| Session workspace (`.osborn/sessions/`) | Working |
| File explorer persistence on resume | Working |
| Full-width responsive UI layout | Working |
| MCP server integration (GitHub, YouTube, etc.) | Working |
| Smithery cloud MCP proxy (`type: 'sdk'`) | Working |
| MCP proxy reconnection across queries | Working |
| `ask_agent` tool (non-blocking, realtime → Claude) | Working |
| Unified voice injection queue | Working |
| Research event batching + voice queue | Working |
| Specificity prompts (no vague summaries) | Working |
| Adaptive verbosity (BRIEF/STANDARD/DETAILED/FULL) | Working |
| Anti-hallucination prompt (realtime mode) | Working |
| Gemini auto-recovery (1008/1011 crash) + context injection | Working |
| Non-blocking research (SDK-managed queuing) | Working |
| Parallel sub-agents (Task tool for concurrent research) | Working |
| Research progress prompt (no false completions) | Working |
| Enriched research progress (file paths, commands) | Working |
| Voice queue flood protection (`isProcessingQueue` + cap) | Working |
| Markdown rendering in chat | Working |
| Task deduplication guard | Working |

---

## Key Files

| File | Purpose |
|------|---------|
| `agent/src/index.ts` | Main entry, room events, session creation, voice queue, data handlers |
| `agent/src/claude-llm.ts` | Claude Agent SDK wrapper, research mode systemPrompt, PreToolUse write safety, auto-approve workspace writes |
| `agent/src/config.ts` | Config loading, session management, workspace helpers |
| `agent/src/smithery-proxy.ts` | In-process MCP proxy for Smithery cloud servers |
| `agent/src/voice-io.ts` | STT/TTS/VAD/Realtime model factory |
| `frontend/src/components/VoiceRoom.tsx` | Main UI component |
| `frontend/src/components/MarkdownMessage.tsx` | Markdown renderer |
| `frontend/src/components/SessionBrowser.tsx` | Session browser component |
| `frontend/src/lib/sessions.ts` | Session utilities (formatTime, groupSessionsByDate) |

---

## v0.4.9 Changes — Remove Research Blocking, Parallel Sub-Agents, Fix False Completions

### Research Blocking Removed
- Removed `if (activeResearch)` guard in `ask_agent` — new tasks go straight to the SDK
- Removed `pendingResearchTask` variable and all chaining logic
- Claude SDK handles sequential queries internally via session resume
- Old research listeners cleaned up before starting new task (prevents duplicate event handlers)

### Parallel Sub-Agents
- System prompt now instructs research agent to use `Task` tool for parallel work
- Multiple Task calls in same response spawn concurrent sub-agents
- Example: researching 3 technologies simultaneously instead of sequentially

### False Completion Fix
- Research update prompt changed from `[RESEARCH UPDATE]` to `[RESEARCH UPDATE — STILL IN PROGRESS]`
- Explicit instruction: "do NOT say complete, done, or finished" — prevents Gemini from announcing research as complete while SDK is still running tools
- Voice model now says progress language ("I'm looking into...", "The agent is reading...") instead of false completion announcements

### Files Modified
| File | Changes |
|------|---------|
| `agent/src/index.ts` | Removed blocking guard, removed `pendingResearchTask`, cleanup old listeners, fixed update prompt |
| `agent/src/claude-llm.ts` | Added `PARALLEL SUB-AGENTS` section to research system prompt |

---

## v0.4.8 Changes — Strict Write Rules, Auto-Approve, Recovery Context

### Write Safety
- Strict `FILE WRITING` prompt: full absolute paths, read before edit, never hallucinate writes
- `canUseTool` auto-approves Write/Edit to `.osborn/sessions/` and `.osborn/research/`
- `canUseTool` auto-denies `EnterPlanMode`/`ExitPlanMode`
- Removed writer sub-agent (permission + latency + voice queue issues)

### Anti-Hallucination
- Realtime prompt rule #7: specific code questions (variable names, line numbers) MUST delegate to `ask_agent`

### Auto-Recovery Context Injection
- After Gemini crash recovery, `buildContextBriefing()` loads last 10 exchanges and injects as `[SESSION RECOVERED]`
- Previously: new session started blank. Now: Gemini knows what was discussed before crash

### Files Modified
| File | Changes |
|------|---------|
| `agent/src/claude-llm.ts` | Strict write prompt, auto-approve workspace writes, auto-deny plan mode |
| `agent/src/index.ts` | Recovery context injection, anti-hallucination rule #7 |

---

## v0.4.6 Changes — Gemini Research Relay Fixes

### Anti-Hallucination
- Generalized fact-fidelity rules across 4 prompt locations (removed tech-specific examples)

### Research Task Queuing
- `pendingResearchTask` stores follow-up tasks while research is running
- `executeResearch()` extracted from `ask_agent` body — called by both tool and pending chain
- Queued task auto-executes after current completes (2s delay, SDK auto-resumes context)

### Voice Queue Fix
- `isProcessingQueue` guard prevents concurrent `generateReply` calls
- 30s safety timeout clears stuck guard (Gemini state machine hang edge case)
- Drop items on error instead of re-queuing (prevents infinite cascades)
- Research debounce 3s → 8s, capped at 3 voice updates per task

### Enriched Research Updates
- `onToolUse` includes file paths, commands, search queries instead of generic tool names
- `onToolResult` removed from voice updates (eliminates "Read done" doubling)

### Files Modified
| File | Changes |
|------|---------|
| `agent/src/index.ts` | `executeResearch()` extraction, `pendingResearchTask` queue, `isProcessingQueue` guard, enriched `onToolUse`/`onToolResult`, generalized anti-hallucination prompts, 8s debounce, 3-update cap |

---

## v0.4.5 Changes — Gemini 1008 Crash Fix + Auto-Recovery

### Problem
Gemini Live API crashes with WebSocket code 1008 during interruptions. SDK kills the session with no auto-reconnect.

### Solution
- Skip `interrupt()` for Gemini provider in `processVoiceQueue()` and `user_text` handler
- `wireSessionEvents()` extracted for reuse during auto-recovery
- On crash: auto-recreates realtime session, re-wires events, notifies user via voice
- `lastRecoveryTime` guard (10s min between recoveries) prevents infinite loops
- Skip `updateChatCtx` for Gemini (crashes with 1008)
- LiveKit SDK update 1.0.31→1.0.45

### Files Modified
| File | Changes |
|------|---------|
| `agent/src/index.ts` | Gemini interrupt guard, `wireSessionEvents()` extraction, auto-recovery handler, ChatCtx skip for Gemini |

---

## v0.4.4 Changes — Full-Width UI, File Explorer Persistence, MCP Fix

### UI Layout
- Removed `max-w-2xl` parent constraint (672px cap) → full viewport width
- Files panel always visible with empty state; toggle button always shown
- Fixed `[object Object]` in code blocks — `CodeBlock` accepts React nodes, `extractText()` for copy

### File Explorer Persistence
- `listWorkspaceArtifacts()` scans flat `.osborn/sessions/` recursively (where Claude actually writes)
- `session_artifacts` event sent on all 4 resume paths (session gate, resume, continue, switch)
- `get_session_artifacts` handler for on-demand requests
- Files cleared on session switch before loading new session's artifacts

### MCP Proxy Fix
- Smithery proxy patches `McpServer.connect()` + inner `Server._server.connect()` for reconnection
- Fixes "Already connected to a transport" on second `query()` call

### Files Modified
| File | Changes |
|------|---------|
| `agent/src/index.ts` | Import `listWorkspaceArtifacts`, emit `session_artifacts` on 4 resume paths, add `get_session_artifacts` handler |
| `agent/src/config.ts` | Add `listWorkspaceArtifacts()`, refactor `listResearchArtifacts()` to use shared `scanDirForArtifacts()` |
| `agent/src/smithery-proxy.ts` | Patch `McpServer.connect` + `Server._server.connect` for reconnection |
| `frontend/src/app/page.tsx` | Remove `max-w-2xl` constraint |
| `frontend/src/components/VoiceRoom.tsx` | Full-width layout, files panel default on, `session_artifacts` handler, file clearing on switch |
| `frontend/src/components/MarkdownMessage.tsx` | `CodeBlock` accepts `React.ReactNode`, add `extractText()` for copy |

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

Last Updated: 2026-02-21
