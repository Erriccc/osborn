# Osborn Changelog

## What Was Working

### Voice Providers
- **OpenAI Realtime**: Working (greeting, transcription, tool calls)
- **Gemini Live**: Was working before multi-agent refactor

### Known Issues (Current)

1. **Room code not passed correctly** ✅ FIXED in v0.1.3
   - Use: `npm run room <code>` or `npm run dev -- --room <code>`

2. **OpenAI permission speech conflicts** ✅ FIXED in v0.1.3
   - Was: `conversation_already_has_active_response` errors
   - Fix: Track actual agent state, only speak when `listening`

3. **Gemini not responding** ✅ FIXED in v0.1.3
   - Reverted to exact model name from working commit: `gemini-2.5-flash-native-audio-preview-12-2025`
   - Removed experimental options (proactivity, enableAffectiveDialog) that broke it
   - **Note**: If Gemini appears unresponsive, restart the agent - usually a stale session issue, not a bug

## Version History

### v0.2.2 (Current)
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
    voice: Zephyr
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
