# Osborn - Voice AI Coding Assistant

Voice-enabled coding assistant powered by LiveKit + Claude Code. Talk to your code.

## Features

- **Voice Interface**: Real-time voice conversation using LiveKit
- **Multi-Provider Support**: Choose between OpenAI Realtime or Gemini Live for voice
- **Claude Code Integration**: File operations, code editing, terminal commands via voice
- **Dual Agent System**: Plan agent (research) + Execute agent (implementation)
- **Permission System**: Approve/deny file operations via voice or UI
- **Direct Connection**: Agent runs locally, connects to cloud-hosted frontend via room codes

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Hosted Frontend (osborn.app or localhost)                              │
│  └── Displays room code, connects to LiveKit Cloud                      │
└────────────────────────────┬────────────────────────────────────────────┘
                             │ WebRTC
                             ↓
┌─────────────────────────────────────────────────────────────────────────┐
│  LiveKit Cloud                                                           │
│  └── Routes audio/data between frontend and agent                       │
└────────────────────────────┬────────────────────────────────────────────┘
                             │ WebRTC
                             ↓
┌─────────────────────────────────────────────────────────────────────────┐
│  User's Machine (CLI)                                                    │
│  └── npx osborn --room abc123                                           │
│  └── Runs Claude Code with access to local filesystem                   │
│  └── Uses your API keys (never sent to cloud)                           │
└─────────────────────────────────────────────────────────────────────────┘
```

## Quick Start

### Option 1: Using Hosted Frontend (Recommended)

```bash
# Install and run the agent
npx osborn

# Copy the room code shown (e.g., "abc123")
# Visit https://osborn.app
# Enter the room code and click Join
```

### Option 2: Local Development

1. Clone the repository
```bash
git clone https://github.com/Erriccc/osborn.git
cd osborn
```

2. Install dependencies
```bash
# Agent
cd agent && npm install

# Frontend
cd ../frontend && npm install
```

3. Configure environment variables

**agent/.env:**
```env
LIVEKIT_URL=wss://your-livekit-url
LIVEKIT_API_KEY=your-api-key
LIVEKIT_API_SECRET=your-api-secret
OPENAI_API_KEY=your-openai-key
GOOGLE_API_KEY=your-google-key
```

**frontend/.env.local:**
```env
NEXT_PUBLIC_LIVEKIT_URL=wss://your-livekit-url
LIVEKIT_API_KEY=your-api-key
LIVEKIT_API_SECRET=your-api-secret
```

4. Run the application
```bash
# Terminal 1: Start agent
cd agent && npm run dev
# Note the room code (e.g., "g63yut")

# Terminal 2: Start frontend
cd frontend && npm run dev

# Open http://localhost:3000
# Enter the room code from Terminal 1
```

## Configuration

Create `~/.osborn/config.yaml` for custom settings:

```yaml
workingDirectory: /path/to/your/project
defaultProvider: gemini  # or openai
defaultCodingAgent: claude

mcpServers:
  github:
    enabled: true
    command: npx
    args: ['@modelcontextprotocol/server-github']
    env:
      GITHUB_TOKEN: ${GITHUB_TOKEN}
```

## Voice Commands

Once connected, try:
- "What files are in this project?"
- "Read the package.json file"
- "Create a file called hello.txt with hello world"
- "Run npm test"
- "Find where the User class is defined"

## Current Status

| Component | Status |
|-----------|--------|
| Voice Interface (LiveKit) | ✅ Working |
| OpenAI Realtime | ✅ Working |
| Gemini Live | ✅ Working |
| Claude Code Tools | ✅ Working |
| Permission Prompts | ✅ Working |
| Room Code System | ✅ Working |
| Text Input | ✅ Working |
| Dual Agent Routing | ✅ Working |

## Tech Stack

- **Voice**: LiveKit Agents SDK + RTCNode
- **Realtime AI**: OpenAI Realtime API / Gemini Live API
- **Coding Agent**: Claude Code via @anthropic-ai/claude-agent-sdk
- **Frontend**: Next.js + React + Tailwind CSS

## Project Structure

```
osborn/
├── agent/                 # LiveKit voice agent (npm package)
│   ├── src/
│   │   ├── index.ts       # Agent entry point
│   │   └── claude-handler.ts  # Claude Agent SDK wrapper
│   └── package.json
├── frontend/              # Next.js web frontend
│   ├── src/
│   │   └── components/    # React components
│   └── package.json
└── CHANGELOG.md          # Version history
```

## License

MIT
