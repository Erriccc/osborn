# Osborn - Voice AI Coding Assistant Progress

## Project Overview
Voice-enabled coding assistant using LiveKit + Claude Code + Fast LLM (Groq)

## Current Status: ✅ Claude Code WORKING - Voice Response Fixed

---

## What's Working vs What's Not

| Component | Status | Notes |
|-----------|--------|-------|
| Frontend (Next.js + LiveKit) | ✅ Working | Voice UI, room connection |
| Agent (LiveKit) | ✅ Working | Receives/sends voice |
| OpenAI Realtime | ✅ Working | GPT-4 voice responses |
| **Claude Code Integration** | 🔧 WIRED UP | Waiting for test |
| **Claude Agent SDK** | 🔧 WIRED UP | `claude-handler.ts` called on coding tasks |
| **Fast LLM (Groq)** | 🔧 WIRED UP | `fast-llm.ts` used for intent detection |
| Permissions | ⚠️ acceptEdits mode | Auto-accepts file edits |
| Room code pairing | ❌ Not implemented | |

**🔧 Flow: Speech → Groq (intent) → Coding tasks route to Claude Code, chat stays with GPT-4**

---

## Test Results (2026-01-02)

### Verified Working
- [x] Frontend starts on localhost:3000
- [x] Agent registers with LiveKit Cloud (US Central)
- [x] Room connection between frontend and agent
- [x] Voice input detected (onInputSpeechStarted/Stopped)
- [x] Voice output via OpenAI Realtime TTS
- [x] Two-way voice conversation

### Not Yet Tested (Claude Code not connected)
- [ ] File read/write via voice
- [ ] Terminal commands via voice
- [ ] Permission prompts
- [ ] Claude Code tool use
- [ ] Fast LLM acknowledgment

---

## MVP Features - Implementation Status

From MVP_SPEC.md:

### US1: Voice Conversation with Fast Acknowledgment
- [x] User speaks into microphone
- [ ] Within 200ms, fast LLM acknowledges ← **NOT IMPLEMENTED**
- [x] Audio response plays
- [ ] Claude Code starts in background ← **NOT IMPLEMENTED**

### US2: Claude Code Integration
- [ ] Claude reads files ← **NOT CONNECTED**
- [ ] Claude makes edits ← **NOT CONNECTED**
- [ ] User notified when complete
- [ ] User sees what changed

### US3: Mid-Conversation Context Addition
- [ ] Context queue ← **NOT IMPLEMENTED**
- [ ] Fast LLM acknowledges additions
- [ ] Context injected to Claude

### US4: Permission Handling
- [ ] Permission requests via voice ← **NOT IMPLEMENTED**
- [ ] Voice approval ("yes", "no")
- [ ] UI approval buttons

### US5: Chat Interface
- [ ] Text input fallback ← **NOT IMPLEMENTED**
- [ ] Tool usage display

---

## What Claude Code / Agent SDK CAN Do (when connected)

```
✅ Read files (any file in working directory)
✅ Write/Edit files
✅ Run terminal commands (Bash)
✅ Search code (Glob, Grep)
✅ Full file system access
✅ Permission system (ask before dangerous ops)
✅ Session persistence (--continue flag)
```

---

## Next Steps to Connect Claude Code

### 1. Modify agent/src/index.ts
```typescript
// Current: Only uses OpenAI Realtime
const session = new voice.AgentSession({
  llm: new openai.realtime.RealtimeModel({ voice: 'alloy' }),
})

// Need: Add Claude Code handler
import { ClaudeHandler } from './claude-handler'

// On user speech, route coding tasks to Claude
session.on('user_speech_committed', async (text) => {
  const isCodingTask = detectCodingIntent(text)
  if (isCodingTask) {
    const claude = new ClaudeHandler({ workingDirectory: '/path/to/project' })
    const result = await claude.run(text)
    // Speak result back
  }
})
```

### 2. Add Intent Detection (fast-llm.ts)
- Use Groq to classify: coding task vs general chat
- Sub-200ms response time

### 3. Wire Up Permissions
- Claude Code emits permission events
- Route to voice/UI for approval

---

## Commands to Run

**Terminal 1 (Frontend):**
```bash
cd /Users/newupgrade/Desktop/Developer/osborn/frontend
npm run dev
```

**Terminal 2 (Agent):**
```bash
cd /Users/newupgrade/Desktop/Developer/osborn/agent
npm run dev
```

**Test URL:** http://localhost:3000

---

## Key Files

| File | Purpose | Status |
|------|---------|--------|
| `agent/src/index.ts` | LiveKit agent entry | ✅ Working (OpenAI only) |
| `agent/src/claude-handler.ts` | Claude SDK wrapper | 📝 Written, not called |
| `agent/src/fast-llm.ts` | Groq intent detection | 📝 Written, not called |
| `frontend/src/components/VoiceRoom.tsx` | Voice UI | ✅ Working |

---

## Architecture (Target vs Current)

### Current (Working)
```
User speaks → LiveKit → Agent → OpenAI Realtime → Response → User hears
```

### Target (MVP)
```
User speaks → LiveKit → Agent → Fast LLM (Groq) → Acknowledgment
                                    ↓
                              Claude Code → File ops → Summary → TTS → User hears
```

---

Last Updated: 2026-01-02 19:30

---

## Claude Agent SDK Deep Research (2026-01-02)

### Key Finding: TWO Different Packages!

| Package | Purpose |
|---------|---------|
| `@anthropic-ai/claude-code` | CLI tool only (no SDK exports) |
| `@anthropic-ai/claude-agent-sdk` | **Proper SDK with `query()` function** ✅ |

### SDK Capabilities

The Claude Agent SDK provides:

```typescript
import { query, ClaudeAgentOptions } from '@anthropic-ai/claude-agent-sdk'

// Built-in tools (no implementation needed!)
// Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch

// Permission modes
// 'default' - asks for each tool
// 'acceptEdits' - auto-accepts file edits
// 'bypassPermissions' - allows everything

// Hooks for interception
// PreToolUse, PostToolUse, Stop, SessionStart, SessionEnd

// Session management with resume
// Resume from session_id for multi-turn conversations

// MCP server support
// Connect external tools via Model Context Protocol
```

### SDK Usage Example

```typescript
for await (const message of query({
  prompt: "Find and fix the bug in auth.py",
  options: {
    allowedTools: ["Read", "Edit", "Bash"],
    permissionMode: "acceptEdits",
    cwd: "/path/to/project",
    hooks: {
      PreToolUse: [{
        matcher: ".*",
        hooks: [async (input) => {
          console.log(`Using tool: ${input.tool_name}`)
          return {} // allow
        }]
      }]
    }
  }
})) {
  if (message.type === 'assistant') {
    // Handle Claude's response
  }
  if (message.type === 'result') {
    // Query complete
  }
}
```

### Permission Handling Options

| Mode | Behavior |
|------|----------|
| `default` | Shows permission UI for each tool |
| `acceptEdits` | Auto-accepts Read/Write/Edit, asks for Bash |
| `bypassPermissions` | Allows everything (dangerous!) |

For voice, we can use hooks to intercept permission requests and route to voice/UI.

### Context Injection via Hooks

```typescript
// PreToolUse hook can block and add context
hooks: {
  PreToolUse: [{
    matcher: ".*",
    hooks: [async (input) => {
      if (needsContext) {
        return {
          decision: "block",
          reason: "User added: also check the tests"
        }
      }
      return {}
    }]
  }]
}
```

### Resources

- [Official Docs](https://platform.claude.com/docs/en/agent-sdk/overview)
- [TypeScript SDK GitHub](https://github.com/anthropics/claude-agent-sdk-typescript)
- [Demo Examples](https://github.com/anthropics/claude-agent-sdk-demos)
- [NPM Package](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)

---

## Latest Changes

### Fixed SDK Integration (2026-01-02 19:30)
- **Changed package**: `@anthropic-ai/claude-code` → `@anthropic-ai/claude-agent-sdk`
- Rewrote `claude-handler.ts` to use proper SDK `query()` function
- Added PreToolUse/PostToolUse hooks for observability
- Session management ready for multi-turn conversations

### Claude Working + TTS Fix (2026-01-02 19:15)
- Claude Code successfully executes tool calls (Bash, Glob, etc.)
- Fixed TTS error: `session.say()` doesn't work with OpenAI Realtime
- Solution: Use `session.generateReply({ instructions: ... })` instead
- This tells GPT-4 what to say and it speaks it via its built-in TTS

### Pre-warming Added (2026-01-02 19:20)
- Claude now pre-warms on agent start
- Runs a simple query in background to initialize session
- First real coding request is faster because Claude is already running

### To Install & Test
```bash
cd /Users/newupgrade/Desktop/Developer/osborn/agent
npm install  # Installs the correct SDK
npm run dev
```

### Test Commands to Verify
Say these to test Claude Agent SDK integration:
1. "What files are in this project?" (should trigger Glob tool)
2. "Read the package.json file" (should use Read tool)
3. "Create a test file called hello.txt with hello world" (should use Write tool)
