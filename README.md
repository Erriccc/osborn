# Osborn - Voice AI Coding Assistant

Voice-enabled coding assistant powered by LiveKit + Claude Code. Talk to your code.

## Features

- **Voice Interface**: Real-time voice conversation using LiveKit
- **Multi-Provider Support**: Choose between OpenAI Realtime or Gemini Live
- **Claude Code Integration**: File operations, code editing, terminal commands via voice
- **Permission System**: Approve/deny file operations via voice or UI
- **Session Persistence**: Claude maintains context across interactions

## Architecture

```
User speaks → LiveKit → Voice Agent → [OpenAI/Gemini Realtime API]
                                           ↓
                                    Claude Code (coding tasks)
                                           ↓
                                    Voice response back to user
```

## Current Status

| Component | Status |
|-----------|--------|
| Voice Interface (LiveKit) | Working |
| OpenAI Realtime | Working |
| Gemini Live | Working |
| Claude Code Tools | Working |
| Permission Prompts | Backend working, UI pending |
| Text Input | Pending |

## Quick Start

### Prerequisites

- Node.js 18+
- LiveKit Cloud account (or local server)
- API Keys: OpenAI and/or Google AI, plus Claude Code authenticated

### Setup

1. Clone the repository
```bash
git clone https://github.com/your-username/osborn.git
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
LLM_PROVIDER=openai  # or gemini
```

**frontend/.env.local:**
```env
NEXT_PUBLIC_LIVEKIT_URL=wss://your-livekit-url
LIVEKIT_API_KEY=your-api-key
LIVEKIT_API_SECRET=your-api-secret
```

4. Run the application
```bash
# Terminal 1: Agent
cd agent && npm run dev

# Terminal 2: Frontend
cd frontend && npm run dev
```

5. Open http://localhost:3000

## Project Structure

```
osborn/
├── agent/                 # LiveKit voice agent
│   ├── src/
│   │   ├── index.ts       # Agent entry point
│   │   └── claude-handler.ts  # Claude Agent SDK wrapper
│   └── package.json
├── frontend/              # Next.js web frontend
│   ├── src/
│   │   └── components/    # React components
│   └── package.json
├── MVP_SPEC.md           # User stories & test scenarios
├── PROGRESS.md           # Development progress
└── VOICE_PRD.md          # Product requirements
```

## Voice Commands

Once connected, try:
- "What files are in this project?"
- "Read the package.json file"
- "Create a file called hello.txt with hello world"
- "Run npm install"

## Tech Stack

- **Voice**: LiveKit Agents (TypeScript)
- **Realtime AI**: OpenAI Realtime API / Gemini Live API
- **Coding Agent**: Claude Code via @anthropic-ai/claude-agent-sdk
- **Frontend**: Next.js + React + Tailwind CSS

## Roadmap

- [ ] Permission UI buttons (approve/deny/always allow)
- [ ] Voice-prompted permission requests
- [ ] Text input support
- [ ] Reconnect without page refresh
- [ ] Hot-swap model switching
- [ ] Codex SDK integration

## License

MIT
