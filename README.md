# Osborn - Voice AI Research & Development Assistant

Voice-enabled research and coding assistant powered by LiveKit + Claude Agent SDK. Talk to your code, research deeply, and build plans before executing.

## Features

- **Voice Interface**: Real-time voice conversation using LiveKit
- **Multi-Provider Voice**: OpenAI Realtime, Gemini Live, Direct (STT + Claude + TTS), or Pipeline (Direct + parallel fast brain)
- **Persistent Session**: Single Claude subprocess per voice session — no JSONL replay after first message. Uses `query()` with `AsyncIterable<SDKUserMessage>` for instant follow-up messages.
- **Multi-Agent Orchestration**: Sonnet orchestrator delegates to three named sub-agents — researcher (Sonnet), reasoner (Opus), writer (Sonnet with verify-first workflow)
- **Research Mode**: Read code, search web, run commands, fetch YouTube transcripts, save findings to session workspace
- **Claude Agent SDK v0.2.91**: Full tool access (Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch) with `agentProgressSummaries` for background Task progress
- **Permission System**: Approve/deny operations via voice or UI. Writer sub-agent gets full write access; all others restricted to workspace.
- **Session Management**: Resume, switch, and browse previous conversations
- **Fast Brain**: ~2s session-aware Q&A via direct API calls (Anthropic Haiku / Gemini Flash fallback)
- **Pipeline Fast Brain**: Gemini Flash AFC observer runs in parallel with Claude — emergency stop + agent restart capability
- **Meeting Integration**: Recall.ai bot joins Zoom/Google Meet, routes real-time transcripts to Claude
- **JSONL Session Access**: Full untruncated tool results read directly from Claude Agent SDK session files
- **Non-Blocking Research**: Ask follow-up questions while research is running — the SDK queues tasks internally
- **Parallel Sub-Agents**: Orchestrator spawns Task sub-agents for concurrent work (e.g., researching 3 topics simultaneously)
- **Gemini Auto-Recovery**: Automatic session recovery from crashes (3s interval) with voice notification
- **MCP Integration**: Extend with GitHub, YouTube, filesystem, and custom MCP servers (Smithery cloud proxy)
- **Research Artifacts**: Plans, diagrams (mermaid), notes, and analysis files — persist across session resumes
- **OAuth Token Persistence**: `claude setup-token` output captured and persisted to volume for Fly.io deployments
- **Full-Width UI**: Responsive layout with always-visible Files panel, meeting controls, and syntax-highlighted code

## Research Mode

The agent operates in a single **research** mode. It reads code, searches the web, runs commands, fetches YouTube transcripts, and saves findings to a session workspace (`.osborn/sessions/`). Write operations are restricted to the workspace directory for safety. Research artifacts (plans, diagrams, notes) appear in the always-visible Files panel.

## Architecture

```
Frontend (Next.js)  <-->  LiveKit Cloud  <-->  Agent (local machine)
                                                ├── Claude Agent SDK v0.2.91 (persistent session)
                                                │   ├── researcher sub-agent (Sonnet)
                                                │   ├── reasoner sub-agent (Opus)
                                                │   └── writer sub-agent (Sonnet)
                                                ├── Pipeline Fast Brain (Gemini Flash observer)
                                                ├── OpenAI/Gemini Realtime (voice)
                                                ├── Recall.ai (meeting bot integration)
                                                └── MCP Servers (extensions)
```

## Quick Start

### Option 1: Using Hosted Frontend

```bash
# Install and run the agent
npx osborn

# Copy the room code shown (e.g., "abc123")
# Visit https://osborn.app
# Enter the room code and click Join
```

### Option 2: Local Development

1. Clone and install:
```bash
git clone https://github.com/Erriccc/osborn.git
cd osborn
cd agent && npm install
cd ../frontend && npm install
```

2. Configure environment variables:

**agent/.env:**
```env
LIVEKIT_URL=wss://your-livekit-url
LIVEKIT_API_KEY=your-api-key
LIVEKIT_API_SECRET=your-api-secret
OPENAI_API_KEY=your-openai-key
GOOGLE_API_KEY=your-google-key
ANTHROPIC_API_KEY=your-anthropic-key
# Optional:
RECALL_API_KEY=your-recall-key    # For Zoom/Google Meet bot integration
SMITHERY_API_KEY=your-smithery-key # For cloud MCP servers
```

**frontend/.env.local:**
```env
NEXT_PUBLIC_LIVEKIT_URL=wss://your-livekit-url
LIVEKIT_API_KEY=your-api-key
LIVEKIT_API_SECRET=your-api-secret
```

3. Run:
```bash
# Terminal 1: Agent
cd agent && npm run dev

# Terminal 2: Frontend
cd frontend && npm run dev
# Open http://localhost:3000
```

## Configuration

Create `~/.osborn/config.yaml`:

```yaml
workingDirectory: /path/to/project
voiceMode: direct        # or 'realtime'
defaultProvider: openai  # or 'gemini' (for realtime mode)

realtime:
  provider: openai
  openaiVoice: alloy

direct:
  stt:
    provider: deepgram
  tts:
    provider: deepgram
    voice: aura-asteria-en

mcpServers:
  github:
    enabled: true
    command: npx
    args: ['-y', '@modelcontextprotocol/server-github']
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: ${GITHUB_TOKEN}
```

## Voice Commands

### Research
- "Research how authentication works in this project"
- "Show me the data flow from API to database"
- "Create a diagram of the component architecture"
- "Write up a plan for adding OAuth"
- "Search for best practices on rate limiting"
- "What dependencies does this project use?"
- "Get the transcript for this YouTube video"

## Project Structure

```
osborn/
├── agent/                          # LiveKit voice agent (backend)
│   ├── src/
│   │   ├── index.ts                # Agent entry, room events, meeting webhooks, voice queue
│   │   ├── claude-llm.ts           # Claude Agent SDK persistent session wrapper, multi-agent config
│   │   ├── pipeline-direct-llm.ts  # Pipeline mode: ClaudeLLM + parallel Gemini fast brain
│   │   ├── pipeline-fastbrain.ts   # Gemini Flash AFC agent with emergency stop
│   │   ├── summary-index.ts        # BM25 searchable index over JSONL session files
│   │   ├── fast-brain.ts           # Fast brain (~2s Q&A, JSONL consolidation)
│   │   ├── session-access.ts       # JSONL session file reader (15 functions)
│   │   ├── prompts.ts              # Centralized prompt definitions (13+ exports)
│   │   ├── config.ts               # Config, sessions, workspace helpers
│   │   ├── recall-client.ts        # Recall.ai meeting bot integration
│   │   ├── claude-auth.ts          # OAuth token capture + volume persistence
│   │   ├── smithery-proxy.ts       # Smithery cloud MCP proxy
│   │   ├── voice-io.ts             # STT/TTS/VAD/Realtime model factory
│   │   └── meeting-output.html     # Recall.ai bot audio output page
│   └── package.json
├── frontend/                       # Next.js web frontend
│   ├── src/
│   │   ├── components/
│   │   │   ├── VoiceRoom.tsx       # Main voice UI + meeting controls
│   │   │   ├── MarkdownMessage.tsx # Markdown renderer
│   │   │   └── SessionBrowser.tsx  # Session browser
│   │   └── app/
│   │       ├── api/token/route.ts  # LiveKit JWT token generation
│   │       └── page.tsx            # Landing page
│   └── package.json
├── CLAUDE.md                       # AI coding assistant guidance
├── CHANGELOG.md                    # Version history
└── README.md
```

## Current Status

| Component | Status |
|-----------|--------|
| Voice Interface (LiveKit) | Working |
| Persistent Session (no per-message JSONL replay) | Working |
| Multi-Agent Orchestration (researcher/reasoner/writer) | Working |
| Pipeline Mode (Claude + Gemini fast brain observer) | Working |
| OpenAI Realtime | Working |
| Gemini Live | Working |
| Direct Mode (STT + Claude + TTS) | Working |
| Claude Agent SDK v0.2.91 | Working |
| Permission System (agent_type-aware) | Working |
| Research Mode | Working |
| Session Management | Working |
| Research Artifacts | Working |
| Recall.ai Meeting Integration | Working |
| Non-blocking research (SDK-managed queuing) | Working |
| Named sub-agents (researcher, reasoner, writer) | Working |
| Fast Brain (~2s Q&A via ask_haiku) | Working |
| Pipeline Fast Brain (Gemini observer + emergency stop) | Working |
| JSONL Session Access (full untruncated data) | Working |
| Post-Research JSONL Consolidation | Working |
| OAuth Token Persistence (Fly.io volume) | Working |
| Gemini Auto-Recovery (3s interval) | Working |
| Files Panel (always visible, persists on resume) | Working |
| MCP Integration (Smithery cloud proxy) | Working |

## Tech Stack

- **Voice**: LiveKit Agents SDK + RTCNode
- **Realtime AI**: OpenAI Realtime API / Gemini Live API
- **Coding Agent**: Claude via @anthropic-ai/claude-agent-sdk v0.2.91
- **Sub-Agents**: researcher (Sonnet), reasoner (Opus), writer (Sonnet)
- **Fast Brain**: Anthropic Haiku / Gemini Flash (direct API + pipeline AFC observer)
- **Meeting**: Recall.ai (Zoom/Google Meet bot integration)
- **Frontend**: Next.js 14 + React + Tailwind CSS
- **STT**: Deepgram Flux (semantic turn detection)
- **TTS**: OpenAI TTS-1, with Deepgram/ElevenLabs/Gemini options

## License

MIT
