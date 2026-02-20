# Osborn Changelog

## What Was Working

### Voice Providers
- **OpenAI Realtime**: Working (greeting, transcription, tool calls)
- **Gemini Live**: Was working before multi-agent refactor

### Known Issues (Current)

1. **Gemini idle timeout**: Gemini Live API crashes with WebSocket code 1008 ("BidiGenerateContent session not found") every ~2 hours when no user interaction. Auto-recovery handles it, but loops endlessly if user is away — each recovery creates a new session that times out again.

2. **Gemini `interrupt()` causes state hang**: Calling `session.interrupt()` on Gemini disrupts its internal state machine — model gets stuck in `speaking` state and never transitions back to `listening`. All `interrupt()` calls must be guarded with `if (currentProvider !== 'gemini')`.

3. **Room code not passed correctly** ✅ FIXED in v0.1.3
   - Use: `npm run room <code>` or `npm run dev -- --room <code>`

4. **OpenAI permission speech conflicts** ✅ FIXED in v0.1.3
   - Was: `conversation_already_has_active_response` errors
   - Fix: Track actual agent state, only speak when `listening`

5. **Gemini not responding** ✅ FIXED in v0.1.3
   - Reverted to exact model name from working commit: `gemini-2.5-flash-native-audio-preview-12-2025`
   - Removed experimental options (proactivity, enableAffectiveDialog) that broke it
   - **Note**: If Gemini appears unresponsive, restart the agent - usually a stale session issue, not a bug

## Version History

### v0.4.6 (Current) — Gemini Research Relay: Anti-Hallucination, Task Queuing, Voice Queue Fix

#### Anti-Hallucination Prompts
- **Generalized fact-fidelity rules**: Removed tech-specific examples ("TypeScript/Python/Django") that Gemini treated as style hints rather than constraints. Replaced with universal rules: "only state facts from findings, don't add from your own knowledge"
- Updated across 4 prompt locations: `[RESEARCH COMPLETE]` injection, anti-hallucination rules, research complete handling guidance, notifications quick-ref

#### Follow-Up Research Task Queuing
- **`pendingResearchTask` queue**: When research is already running, follow-up `ask_agent` calls store the task instead of rejecting. After current research completes, queued task auto-executes with 2s delay
- **`executeResearch()` extraction**: Core research logic extracted from `ask_agent` execute body into a named function, callable by both `ask_agent` and the pending task chain
- **SDK auto-context**: Claude Agent SDK auto-resumes via `sessionId` — follow-up tasks inherit all prior research context without manual session management

#### Voice Queue Flooding Fix
- **`isProcessingQueue` guard**: Prevents concurrent `generateReply` calls. Cleared on every `agent_state_changed` event
- **30s safety timeout**: If `agent_state_changed` never fires (e.g. Gemini state machine hang), clears the guard and retries the queue
- **Drop-not-requeue**: On `generateReply` error, items are dropped instead of re-queued — prevents infinite retry cascades. Frontend still has updates via `claude_output` events
- **8s research batch debounce** (was 3s): Reduces voice queue flooding during active research
- **3-update cap per task**: `voiceUpdateCount` limits voice injections per research task — prevents chatty updates on long research
- **500ms queue retry delay** (was 50ms): Longer settle time after model enters `listening` state

#### Enriched Research Updates
- **`onToolUse` includes parameters**: "Reading config.ts", "Running: ls -la", "Searching for 'pinecone' in files", "Fetching content from github.com" — instead of generic "Using Read"
- **`onToolResult` no longer doubles**: Removed from `pendingUpdates` — eliminates "Reading config.ts. Read completed." pairs in voice updates
- **MCP tool formatting**: `mcp__youtube__search` → "Using youtube: search"

#### Gemini interrupt() Constraint
- `interrupt()` kept Gemini-guarded in both `processVoiceQueue()` and `user_text` handler — re-enabling causes Gemini's state machine to hang in `speaking` state indefinitely

---

### v0.4.5 — Gemini 1008 Crash Fix + Auto-Recovery

#### Root Cause
Gemini Live API (`gemini-2.5-flash-native-audio-preview-12-2025`) crashes with WebSocket code 1008 during user interruptions + tool calls. SDK marks code 1008 as `retryable: false`, `recoverable: false` — kills the session with no auto-reconnect.

#### Fixes
- **Skip `interrupt()` for Gemini**: `processVoiceQueue()` and `user_text` handler guard with `if (currentProvider !== 'gemini')`. Gemini handles interruptions internally via `activityStart`/`activityEnd`
- **Auto-recovery**: `wireSessionEvents()` extracted from `ParticipantConnected`. On session close with `reason === 'error'`, automatically recreates realtime session, re-wires events, starts new session, notifies user via voice. `lastRecoveryTime` guard prevents loops (10s minimum between recoveries)
- **Skip `updateChatCtx` for Gemini**: `injectIntoChatCtx()` and `loadSessionHistoryIntoChatCtx()` skip when `currentProvider === 'gemini'` — Gemini doesn't support `updateChatCtx` (crashes with 1008)
- **`generateReply({ instructions })` not `userInput`**: All session resume paths use `instructions` parameter to avoid `updateChatCtx` calls
- **LiveKit SDK update**: Packages 1.0.31→1.0.45, rtc-node 0.13.22→0.13.24

---

### v0.4.4 — Full-Width UI, File Explorer Persistence, MCP Proxy Fix

#### UI Layout Overhaul
- **Full-width layout**: Removed `max-w-2xl` constraint from `page.tsx` and `max-w-3xl` default from `VoiceRoom.tsx`. UI now uses full viewport width (`max-w-[90rem]`)
- **Files panel always visible**: `showFilesPanel` defaults to `true`. Panel shows "No files yet" empty state when no artifacts exist. Toggle button always visible (not gated on file count)
- **Code block rendering fix**: `MarkdownMessage.tsx` `CodeBlock` now accepts `React.ReactNode` children instead of `String()` — fixes `[object Object]` rendering when `rehype-highlight` transforms code into syntax-highlighted `<span>` elements. Added `extractText()` helper for copy button plain text extraction

#### File Explorer Session Persistence
- **Workspace artifact loading on resume**: When resuming/switching sessions, the agent scans `.osborn/sessions/` for existing files and sends them to frontend via new `session_artifacts` event
- **All resume paths covered**: Artifact emission added to 4 code paths — `session_selected` (session gate), `resume_session`, `continue_session`, `switch_session`
- **New `listWorkspaceArtifacts()`**: Scans flat `.osborn/sessions/` directory (where Claude actually writes) instead of per-session subdirectory. Recursive — includes `library/` contents
- **New `get_session_artifacts` handler**: Frontend can request artifacts on demand
- **File clearing on session switch**: `generatedFiles` and `selectedFilePath` reset before loading new session's artifacts
- **Content lazy-loading**: Only metadata sent initially; content fetched on-demand when file is selected

#### Smithery MCP Proxy Reconnection Fix
- **Fixed "Already connected to a transport" error**: On second `query()` call, the SDK tried to reconnect the proxy `McpServer` which threw. Proxy now patches both `McpServer.connect()` and inner `Server._server.connect()` to auto-close existing transport before accepting a new one
- **YouTube MCP confirmed working**: 7 tools discovered and used natively across multiple queries

#### Data Channel Protocol
- **New events**: `session_artifacts` (Agent → Frontend), `get_session_artifacts` (Frontend → Agent)

---

### v0.4.3 — Unified Voice Injection Queue + Specificity Prompts
- **Unified voice injection queue**: ALL system injections (`[RESEARCH UPDATE]`, `[RESEARCH COMPLETE]`, notifications, errors) go through a single `voiceQueue[]` gated by `agentState === 'listening'`. Eliminates `generateReply timed out` errors caused by calling `generateReply` while the model is busy.
- **State-machine driven processing**: `processVoiceQueue()` only fires when model is `listening`. After calling `generateReply`, model naturally transitions to `thinking/speaking` → `listening`, which triggers the next batch. No timers, no `drainInFlight` guards, no deferred one-shot listeners.
- **Batched voice injections**: Multiple queued items (e.g. 3 research updates + 1 completion) are combined into a single `generateReply` call, reducing model interruptions.
- **Research event batching**: `scheduleResearchBatch()` debounces rapid tool events (3s), formats them as a single `[RESEARCH UPDATE]`, and pushes to the voice queue.
- **Specificity prompts**: `[RESEARCH COMPLETE]` injection now mandates naming specific tools, packages, numbers, and URLs — no more vague "various tools" summaries. Adaptive verbosity defaults research results to DETAILED (6-10 sentences).
- **Removed**: `drainResearchQueue()`, `scheduleDrain()`, `drainDebounceTimer`, `drainInFlight`, immediate/deferred dual injection paths, `.catch()` workarounds on `generateReply` return values.

---

### v0.4.2 — Non-Blocking Research + Live Progress
- **Non-blocking `ask_agent`**: Tool returns immediately, runs Claude research in background
- **Queue-based progress injection**: Research events (tool_use, tool_result, assistant_text) push to `pendingUpdates` queue; drains when voice model enters `listening` state via `agent_state_changed` event
- **`[RESEARCH UPDATE]` injections**: Batched progress sent to realtime voice model via `generateReply({ instructions, toolChoice: 'none' })` — model speaks natural status updates
- **`[RESEARCH COMPLETE]` injection**: Final results with research log injected when research finishes; deferred to next `listening` state if model is busy
- **Frontend visibility**: Progress drains and final results emit `claude_output` events with `agentRole: 'research-progress'` for chat panel visibility
- **`activeResearch` guard**: Prevents concurrent research tasks; cleaned up on disconnect/reconnect

---

### v0.4.1 — Voice UX Fixes
- **Double summarization fix**: `ask_agent` return value increased from 500 → 2500 chars with sentence-boundary truncation
- **Research log batching**: tool_use/tool_result/assistant_text events collected during execution, appended as `[RESEARCH LOG]` to tool return
- **Adaptive verbosity**: Realtime prompt guidance: BRIEF (1-3 sentences), STANDARD (3-6), DETAILED (6-10), FULL (all details)
- **Streaming research text**: `assistant_text` events wired to frontend as `claude_output` during `ask_agent`
- **Session workspace paths**: Full Claude session UUID instead of 8-char truncation (`.osborn/sessions/<full-uuid>/`)
- **Smithery proxy reconnection**: Patch covers both `McpServer.connect` and inner `Server._server.connect`

---

### v0.4.0 — Research Mode Refactor (Phase 1a)
- **Removed plan/execute/edit mode system**: ~200 lines of enforcement code deleted
- **Single research mode**: `RESEARCH_TOOLS` array replaces `PLAN_TOOLS`/`EDIT_TOOLS`/`DEFAULT_ALLOWED_TOOLS`
- **Simplified PreToolUse hook**: ~10 lines, only blocks Write/Edit outside `.osborn/sessions/` and `.osborn/research/`
- **Session workspace**: `.osborn/sessions/<id>/` with `spec.md` + `library/` structure
- **Always-on systemPrompt**: Research mode instructions injected via Claude SDK `systemPrompt` field
- **Frontend cleanup**: Removed Mode tab, Execute button, AgentModeState — static "Research" label
- **Data channel cleanup**: Removed `agent_mode_changed`, `edit_mode_changed`, `toggle_agent_mode`, `approve_plan`, `reject_plan`

---

### v0.3.0 — Enhanced Plan Mode
- **`PLAN_TOOLS`** replaces `READ_ONLY_TOOLS`: includes Write, Edit, Bash (filtered by PreToolUse hook)
- **Path filtering**: Write/Edit only to `.osborn/research/` and `.claude/plans/`
- **Bash deny-list**: Blocks destructive commands (rm, npm install, git push), allows read-only (ls, git log, cat)
- **`permissionMode: 'default'`**: Fixed from `'plan'` which blocked ALL tools
- **Research directory**: Per-session at `.osborn/research/<session-id-prefix>/`
- **Unified Files panel**: `GeneratedFile` replaces `PlanFile` — shows both plans and research artifacts
- **Claude SDK `systemPrompt`**: Plan mode injects write rules and artifact creation guidance

---

### v0.2.2
**Frontend Updates & Agent Intelligence**

#### Frontend Fixes
- **Fixed assistant messages not displaying**: Messages were being received but content wasn't rendering due to aggressive markdown parsing stripping content
- **Improved message parsing**: Conservative approach to parsing - only removes explicit reasoning blocks, preserves all other content
- **Better duplicate detection**: Tracks last 5 messages per role instead of just the last one
- **Added status_update handler**: Frontend now displays background task status updates
- **Debug logging**: Added comprehensive logging throughout message pipeline for troubleshooting

#### Agent Improvements
- **Internet access awareness**: Agent now knows it has full internet access for web search, fetching URLs, and API calls
- **Fixed task ID tracking**: Status manager now uses brain's task IDs to prevent ID mismatch between systems
- **Added registerTask()**: New method to register tasks with specific IDs from brain
- **Source tracking**: All messages now include source field for debugging (tool_result, direct_command, research_complete, etc.)
- **System status messages**: Shows "Running: ...", "Researching: ...", "Executing: ..." progress updates
- **No markdown in speech**: Updated instructions to prevent Gemini from adding **bold** headers in voice responses

---

### v0.2.1
**Bug Fixes & UI Improvements**

#### Bug Fixes
- **Fixed Claude Agent SDK warmup error**: Improved warmup prompt from minimal `'ready'` to proper instruction, with graceful error handling
- **Fixed agent speech not appearing in chat**: Added `playout_completed` event handler for Gemini realtime mode
- **Fixed user transcript not sending**: Added `input_speech_stopped` fallback handler for accumulated transcripts
- **Fixed mute button missing**: Added mute/unmute toggle button with microphone icons
- **Fixed button visibility**: Restructured header layout with compact visualizer (h-12 w-24)

#### UI Improvements
- Added mute button with visual feedback (red when muted)
- Improved header layout with better button spacing
- Status badge shows agent state properly

---

### v0.2.0
**Three-Layer Voice Architecture & UI Overhaul**

This release introduces a major architectural improvement and enhanced UI.

#### New Features

**Three-Layer Voice Architecture (Pipelined Mode)**
- **Layer 1 - Voice I/O**: Separate STT (Deepgram) and TTS (Gemini) for flexible voice handling
- **Layer 2 - Bridge LLM**: Gemini 2.5 Pro for intelligent conversation management, greetings, and context bridging
- **Layer 3 - Coding Agent**: Claude Code with Plan (read-only) and Execute (write) agents
- **Voice Mode Selection**: Choose between `realtime` (OpenAI/Gemini speech-to-speech) or `pipelined` (STT+LLM+TTS)
- **Smart Summarization**: Bridge LLM summarizes technical results for natural voice responses
- **Solves Gemini Greeting**: TTS speaks directly in pipelined mode - no more silent starts

**Improved Configuration**
- New `voiceMode` option: `'realtime'` (default) or `'pipelined'`
- Configurable pipelined providers: STT, Bridge LLM, and TTS
- Full config via `~/.osborn/config.yaml`

**Frontend UI Overhaul**
- **Markdown Rendering**: Assistant messages now render with full markdown support
- **Syntax Highlighting**: Code blocks with language badges and copy buttons
- **Better Status Indicators**: Animated status badges for listening/thinking/speaking states
- **Rich Text Support**: Headers, lists, links, tables, blockquotes rendered beautifully
- **GitHub-Dark Theme**: Code blocks styled with highlight.js github-dark theme

#### Backend Changes
- New `voice-io.ts`: STT/TTS factory with provider abstraction
- New `bridge-llm.ts`: Bridge LLM with context tracking and tools
- Updated `config.ts`: New types and helpers for pipelined config
- Updated `index.ts`: Dual-mode session creation and improved speech queue

#### Frontend Changes
- New `MarkdownMessage.tsx`: Full markdown renderer with syntax highlighting
- Updated `VoiceRoom.tsx`: Markdown integration and animated status badges
- Added dependencies: `react-markdown`, `remark-gfm`, `rehype-highlight`

#### Config Example
```yaml
# ~/.osborn/config.yaml
workingDirectory: /path/to/project
voiceMode: pipelined  # or 'realtime'

pipelined:
  stt:
    provider: deepgram
  llm:
    provider: gemini-pro
  tts:
    provider: gemini
    voice: Aoede
```

---

### v0.1.6
**Context Management & Voice Intelligence**
- **Dynamic Instructions**: Voice LLM now knows working directory and project context
- **Shared Context**: Actions and discovered files tracked between voice and coding agents
- **Improved Tool Routing**: Voice agent now properly delegates all coding tasks to Claude
- **Better Tool Description**: Clearer guidance for when to use `run_code` tool
- **Persistent Ready Signal**: Agent sends ready signal every 2s for 20s to ensure frontend receives it
- **Result Summarization**: Long coding results truncated for voice response

### v0.1.5
**MAJOR: Direct Connection Architecture**
- **Rewrite**: Agent now connects directly to rooms (no worker dispatch)
- **Works with cloud-hosted frontend**: Agent joins room first, waits for user
- **Self-generating room codes**: Run `npm run dev` to auto-generate code
- **Join existing room**: Run `npm run room abc123` to join specific room
- **Architecture**: Agent creates its own token, connects to LiveKit Cloud directly
- **Simplified**: Removed cli.runApp() worker pattern, cleaner code
- **Fixed**: Frontend room input to join agent-created rooms
- **Fixed**: Logger initialization for direct connection mode
- **Fixed**: localParticipant assignment for data channel communication

**How it works:**
```
Local Agent ─────► LiveKit Cloud ◄───── Hosted Frontend
     │                   │                    │
     └──── Same Room (osborn-abc123) ────────┘
```

**Testing Locally (both frontend + agent):**
```bash
# Terminal 1: Start the agent
cd agent
npm run dev
# Note the room code shown (e.g., "abc123")

# Terminal 2: Start the frontend
cd frontend
npm run dev
# Opens at http://localhost:3000

# In browser:
# 1. Enter the room code from Terminal 1
# 2. Click "Join"
# 3. Speak to test voice
```

### v0.1.4
- **Fixed**: VoiceRoom no longer remounts when agent connects (was causing immediate disconnect)
- **Fixed**: Room name properly accessed after connect() call
- **Fixed**: Session cleanup avoids WritableStream errors
- **Improved**: Unified waiting/connected states to keep VoiceRoom mounted
- **Architecture**: Dual agent system (Plan + Execute) with smart routing

### v0.1.3
- **Fixed**: Speech queue now tracks actual agent state (`listening`, `speaking`, etc.)
- **Fixed**: Permissions/status only spoken when agent is truly idle
- **Fixed**: Room code parsing with `npm run room <code>` script
- **Fixed**: Gemini model restored to working config (`gemini-2.5-flash-native-audio-preview-12-2025`)
- Better logging for speech queue debugging

**Frontend UX Improvements:**
- Auto-detect agent connection (no more manual "Agent Connected?" button)
- Persist provider/agent selection in localStorage
- File attachment support (images, code files)
- Improved audio visualization with state badges
- Better waiting screen with live connection status
- Agent sends heartbeat when ready

### v0.1.2
- Multi-agent pool (2 Claude handlers)
- Streaming feedback to voice LLM
- Smart silence mode ("let me know when done")
- Gemini greeting via instructions (not working)

### v0.1.1
- Tool logging to terminal
- All tools require permission by default
- npm package setup (`npx osborn`)

### v0.1.0
- Initial release
- OpenAI Realtime + Gemini Live support
- Claude Code + Codex backend options
- Room code system for hosted frontend
- Basic permission handling via UI buttons
