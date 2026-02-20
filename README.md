# Osborn - Voice AI Research & Development Assistant

Voice-enabled research and coding assistant powered by LiveKit + Claude Agent SDK. Talk to your code, research deeply, and build plans before executing.

## Features

- **Voice Interface**: Real-time voice conversation using LiveKit
- **Multi-Provider Voice**: OpenAI Realtime, Gemini Live, or Direct (STT + Claude + TTS)
- **Research Mode**: Read code, search web, run commands, fetch YouTube transcripts, save findings to session workspace
- **Claude Agent SDK**: Full tool access (Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch)
- **Permission System**: Approve/deny operations via voice or UI
- **Session Management**: Resume, switch, and browse previous conversations
- **Follow-Up Research Queuing**: Ask follow-up questions while research is running — they chain automatically
- **Gemini Auto-Recovery**: Automatic session recovery from Gemini 1008 crashes with voice notification
- **MCP Integration**: Extend with GitHub, YouTube, filesystem, and custom MCP servers (Smithery cloud proxy)
- **Research Artifacts**: Plans, diagrams (mermaid), notes, and analysis files — persist across session resumes
- **Full-Width UI**: Responsive layout with always-visible Files panel and syntax-highlighted code

## Research Mode

The agent operates in a single **research** mode. It reads code, searches the web, runs commands, fetches YouTube transcripts, and saves findings to a session workspace (`.osborn/sessions/`). Write operations are restricted to the workspace directory for safety. Research artifacts (plans, diagrams, notes) appear in the always-visible Files panel.

## Architecture

```
Frontend (Next.js)  <-->  LiveKit Cloud  <-->  Agent (local machine)
                                                ├── Claude Agent SDK (tools)
                                                ├── OpenAI/Gemini Realtime (voice)
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
├── agent/                  # LiveKit voice agent (backend)
│   ├── src/
│   │   ├── index.ts        # Agent entry, room events, data handlers
│   │   ├── claude-llm.ts   # Claude Agent SDK wrapper, mode filtering
│   │   ├── config.ts          # Config, sessions, workspace helpers
│   │   ├── smithery-proxy.ts  # Smithery cloud MCP proxy
│   │   └── voice-io.ts       # STT/TTS/VAD/Realtime model factory
│   └── package.json
├── frontend/               # Next.js web frontend
│   ├── src/
│   │   ├── components/
│   │   │   ├── VoiceRoom.tsx       # Main voice UI
│   │   │   ├── MarkdownMessage.tsx # Markdown renderer
│   │   │   └── SessionBrowser.tsx  # Session browser
│   │   └── lib/
│   │       └── sessions.ts         # Session utilities
│   └── package.json
├── PROGRESS.md             # Development progress
└── README.md
```

## Current Status

| Component | Status |
|-----------|--------|
| Voice Interface (LiveKit) | Working |
| OpenAI Realtime | Working |
| Gemini Live | Working |
| Direct Mode (STT + Claude + TTS) | Working |
| Claude Agent SDK Tools | Working |
| Permission System | Working |
| Research Mode | Working |
| Session Management | Working |
| Research Artifacts | Working |
| Research Task Queuing (follow-up chains) | Working |
| Gemini Auto-Recovery (1008 crash) | Working |
| Files Panel (always visible, persists on resume) | Working |
| MCP Integration (Smithery cloud proxy) | Working |
| Full-Width Responsive Layout | Working |

## Tech Stack

- **Voice**: LiveKit Agents SDK + RTCNode
- **Realtime AI**: OpenAI Realtime API / Gemini Live API
- **Coding Agent**: Claude via @anthropic-ai/claude-agent-sdk
- **Frontend**: Next.js 14 + React + Tailwind CSS
- **STT/TTS**: Deepgram (default), with OpenAI/ElevenLabs/Gemini options

## License

MIT
