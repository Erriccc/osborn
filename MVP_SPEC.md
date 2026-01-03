# Voice AI Coding Assistant - MVP Specification

## Overview

Build a voice-enabled coding assistant with fast conversational responses and Claude Code backend.

**MVP Goal**: Multi-turn voice conversation with instant acknowledgment, Claude Code integration, and chat UI.

---

## Core User Stories

### US1: Voice Conversation with Fast Acknowledgment
**As a** developer
**I want** to speak to the assistant and get instant acknowledgment
**So that** I know my request was heard before Claude starts working

**Acceptance Criteria:**
- [ ] User speaks into microphone
- [ ] Within 200ms of speech ending, user hears "Got it, let me work on that"
- [ ] Fast LLM provides acknowledgment
- [ ] Claude Code starts processing in background
- [ ] User sees progress in chat interface

### US2: Claude Code Integration
**As a** developer
**I want** the assistant to actually edit my code
**So that** I can accomplish real coding tasks via voice

**Acceptance Criteria:**
- [ ] User can say "Fix the bug in auth.py"
- [ ] Claude Code reads the file
- [ ] Claude Code makes edits
- [ ] User is notified when complete
- [ ] User can see what was changed

### US3: Mid-Conversation Context Addition
**As a** developer
**I want** to add context while Claude is working
**So that** I can refine my request without starting over

**Acceptance Criteria:**
- [ ] While Claude is processing, user can speak
- [ ] New context is queued
- [ ] Fast LLM acknowledges: "Got it, I'll let Claude know"
- [ ] Context is injected into Claude's workflow (via hooks or next turn)

### US4: Permission Handling via Voice and UI
**As a** developer
**I want** to approve tool permissions via voice or button
**So that** I maintain control over what Claude does

**Acceptance Criteria:**
- [ ] When Claude requests permission, user is notified
- [ ] User can say "yes", "no", "always allow"
- [ ] User can click approval button in UI
- [ ] Permission response is sent to Claude

### US5: Chat Interface
**As a** developer
**I want** a visual chat interface alongside voice
**So that** I can see conversation history and type when needed

**Acceptance Criteria:**
- [ ] Chat shows transcribed user speech
- [ ] Chat shows Claude's responses
- [ ] User can type messages instead of speaking
- [ ] Chat shows tool usage (files read, edits made)

---

## Technical Specifications

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Frontend (React/Next.js on Vercel)                             │
│  • LiveKit Client SDK for WebRTC                                │
│  • Chat UI with @livekit/components-react                       │
│  • Text input for typed messages                                │
│  • Permission approval buttons                                   │
└─────────────────────────┬───────────────────────────────────────┘
                          │ WebRTC
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│  LiveKit Cloud (or self-hosted)                                 │
│  • Audio routing                                                │
│  • Room management                                              │
└─────────────────────────┬───────────────────────────────────────┘
                          │ WebRTC
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│  LiveKit Agent (Node.js on user's machine or cloud)             │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │  Custom LLM Node                                           │ │
│  │  • Fast LLM (Groq/Haiku) for acknowledgment               │ │
│  │  • Routing logic to Claude                                 │ │
│  │  • Context queue for mid-conversation additions           │ │
│  └─────────────────────────────┬─────────────────────────────┘ │
│                                │                                │
│  ┌─────────────────────────────┴─────────────────────────────┐ │
│  │  Claude Agent SDK                                          │ │
│  │  • @anthropic-ai/claude-agent-sdk                         │ │
│  │  • Hooks: PreToolUse, PostToolUse, Stop                   │ │
│  │  • Permission callbacks                                    │ │
│  │  • Session management                                      │ │
│  └───────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### Components

#### 1. Frontend (Next.js + LiveKit Components)

**Files:**
```
frontend/
├── app/
│   ├── page.tsx              # Main voice UI
│   └── api/
│       └── livekit/          # Token generation
├── components/
│   ├── VoiceChat.tsx         # Main voice component
│   ├── ChatHistory.tsx       # Message display
│   ├── PermissionModal.tsx   # Approval UI
│   └── StatusIndicator.tsx   # Working/ready state
└── lib/
    └── livekit.ts            # LiveKit client setup
```

**LiveKit Components Used:**
- `<LiveKitRoom />` - Room connection
- `<RoomAudioRenderer />` - Audio playback
- `<ControlBar />` - Mute/unmute controls
- `<Chat />` - Built-in chat (or custom)

#### 2. LiveKit Agent (Node.js)

**Files:**
```
agent/
├── src/
│   ├── index.ts              # Agent entry point
│   ├── agent.ts              # Custom agent class
│   ├── llm-node.ts           # Custom LLM processing
│   ├── fast-llm.ts           # Groq/Haiku integration
│   ├── claude-integration.ts # Claude Agent SDK wrapper
│   └── context-queue.ts      # Mid-conversation context
├── package.json
└── tsconfig.json
```

**Key Dependencies:**
```json
{
  "@livekit/agents": "^0.x",
  "@anthropic-ai/claude-agent-sdk": "^1.x",
  "groq-sdk": "^0.x"
}
```

#### 3. Claude Agent SDK Integration

**Permission Handling:**
```typescript
import { query, ClaudeAgentOptions, HookMatcher } from "@anthropic-ai/claude-agent-sdk";

const preToolHook = async (input, toolUseId, context) => {
  // Send permission request to frontend
  await sendPermissionRequest(input.tool_name, input.tool_input);

  // Wait for user response
  const response = await waitForPermissionResponse(toolUseId);

  return response.approved ? {} : { decision: "block", reason: "User denied" };
};

for await (const message of query({
  prompt: userRequest,
  options: {
    allowedTools: ["Read", "Edit", "Bash", "Glob", "Grep"],
    hooks: {
      PreToolUse: [{ matcher: ".*", hooks: [preToolHook] }]
    }
  }
})) {
  // Stream to frontend
  sendToFrontend(message);
}
```

---

## Test Scenarios

### T1: Basic Voice Input
```
GIVEN: User opens the app and microphone is enabled
WHEN: User says "Hello"
THEN: Transcription appears in chat
AND: Fast LLM responds within 500ms
AND: Audio response plays
```

### T2: Fast Acknowledgment
```
GIVEN: User is connected
WHEN: User says "Fix the type error in utils.ts"
THEN: Within 200ms, user hears "Got it, let me check that file"
AND: Claude Code starts in background
AND: Chat shows "Reading utils.ts..."
```

### T3: Claude Code Execution
```
GIVEN: User has a file utils.ts with a type error
WHEN: User says "Fix the type error in utils.ts"
THEN: Claude reads utils.ts
AND: Claude identifies the error
AND: Claude edits the file
AND: User hears summary of what was fixed
AND: Chat shows the diff
```

### T4: Permission Request
```
GIVEN: Claude wants to run a bash command
WHEN: Permission is required
THEN: User hears "Claude wants to run: npm test. Should I allow it?"
AND: Permission modal appears with Allow/Deny buttons
AND: User can say "yes" or click Allow
AND: Claude proceeds or stops based on response
```

### T5: Mid-Conversation Addition
```
GIVEN: Claude is analyzing utils.ts
WHEN: User says "also check helpers.ts"
THEN: User hears "Got it, I'll include that"
AND: New context is queued
AND: On Claude's next turn, helpers.ts is included
```

### T6: Text Input Fallback
```
GIVEN: User is in public and can't speak
WHEN: User types in the chat input
THEN: Message is sent to Claude
AND: Response appears in chat
AND: No audio is played (optional setting)
```

### T7: Session Continuity
```
GIVEN: User has an ongoing conversation
WHEN: User refreshes the page
THEN: Previous context is restored
AND: User can continue the conversation
```

---

## API Contracts

### Frontend → Agent Messages

```typescript
interface UserMessage {
  type: 'user_speech' | 'user_text' | 'permission_response';
  content?: string;
  permissionId?: string;
  approved?: boolean;
  alwaysAllow?: boolean;
}
```

### Agent → Frontend Messages

```typescript
interface AgentMessage {
  type: 'transcription' | 'fast_response' | 'claude_response' |
        'permission_request' | 'tool_use' | 'status' | 'error';
  content?: string;
  toolName?: string;
  toolInput?: any;
  permissionId?: string;
  status?: 'thinking' | 'working' | 'ready';
}
```

---

## Success Metrics

| Metric | Target |
|--------|--------|
| Time to first audio response | < 500ms |
| Fast LLM acknowledgment | < 200ms |
| Permission request latency | < 1s |
| End-to-end voice command | < 10s for simple tasks |

---

## Phase 2: Codex SDK Support

### Architecture Addition

```typescript
// agent/src/cli-adapters/codex-adapter.ts
import { Codex } from "@openai/codex-sdk";

export class CodexAdapter {
  private codex: Codex;
  private thread: Thread;

  async initialize() {
    this.codex = new Codex();
    this.thread = this.codex.startThread();
  }

  async runStreamed(prompt: string) {
    for await (const event of this.thread.runStreamed(prompt)) {
      yield this.transformEvent(event);
    }
  }
}
```

### CLI Selection UI
```typescript
interface CLIConfig {
  type: 'claude' | 'codex' | 'gemini';
  enabled: boolean;
}

// User can select which CLI to use
// Default: Claude (full hook support)
// Option: Codex (thread-based, limited hooks)
// Future: Gemini (spawn-based)
```

### Test Scenario: Codex Support
```
GIVEN: User selects "Codex" as the CLI backend
WHEN: User says "Fix the type error in utils.ts"
THEN: Codex SDK is used instead of Claude
AND: Thread is maintained for multi-turn
AND: Responses stream to frontend
```

---

## Out of Scope for MVP

- [ ] Screen sharing / vision
- [ ] Gemini CLI support (no SDK yet, needs spawn)
- [ ] Multiple pre-warmed Claude instances
- [ ] Telephony (phone calls)
- [ ] Video capture
- [ ] File/image upload (future)

---

## Next Steps

1. Set up LiveKit Cloud account
2. Create Next.js frontend with LiveKit components
3. Build Node.js agent with custom LLM node
4. Integrate Claude Agent SDK
5. Implement permission flow
6. Add fast LLM layer (Groq)
7. Test all scenarios
8. Deploy frontend to Vercel
9. Document deployment for local agent

---

## Dependencies

### Frontend
- Next.js 14+
- @livekit/components-react
- @livekit/client
- tailwindcss (styling)

### Agent
- @livekit/agents
- @anthropic-ai/claude-agent-sdk
- groq-sdk (or @anthropic-ai/sdk for Haiku)

### Services
- LiveKit Cloud (free tier: 1000 min/month)
- Anthropic API (for Claude)
- Groq API (free tier available) or Anthropic (for Haiku)
