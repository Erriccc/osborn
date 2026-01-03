# Osborn Implementation Plan

## Current Issues & Fixes

### 1. Connection Stuck Issue (CRITICAL)

**Problem**: Agent waits for participant before creating the model, but LiveKit jobs may dispatch before the user fully joins.

**Fix**: Use LiveKit's built-in `waitForParticipant` or check existing participants properly.

```typescript
// Current (broken)
const participant = await new Promise((resolve) => {
  const existing = Array.from(ctx.room.remoteParticipants.values())[0]
  // Race condition: event listener may miss participant
})

// Fixed
await ctx.waitForParticipant()  // LiveKit built-in
const participant = Array.from(ctx.room.remoteParticipants.values())[0]
```

### 2. Gemini Live API Setup

**Requirements**:
- `@google/genai` package (included in `@livekit/agents-plugin-google`)
- `GOOGLE_API_KEY` from [Google AI Studio](https://aistudio.google.com/apikey)
- Model: `gemini-2.0-flash-live-001`

**Key Differences from OpenAI**:
| Feature | OpenAI Realtime | Gemini Live |
|---------|-----------------|-------------|
| Model | `gpt-4o-realtime` | `gemini-2.0-flash-live-001` |
| Voices | `alloy`, `echo`, `shimmer` | `Puck`, `Charon`, `Kore`, `Fenrir`, `Aoede` |
| Turn detection | Native | Silero VAD recommended |
| Tool calling | Mature | Good but newer |
| Pricing | ~$0.10/min | Free during preview |

### 3. Permission System (Claude Agent SDK)

**Current Issue**: Using hooks for permissions but auto-approving after 30s timeout.

**Proper Solution**: Use `canUseTool` callback for interactive approval:

```typescript
const result = await query({
  prompt,
  options: {
    permissionMode: 'default',
    canUseTool: async (toolName, input) => {
      // Emit event to voice UI
      emitPermissionRequest(toolName, input)

      // Wait for user response via voice/UI
      const decision = await waitForUserDecision()

      return {
        behavior: decision.approved ? 'allow' : 'deny',
        message: decision.reason
      }
    }
  }
})
```

**Permission Flow**:
```
Tool Request → canUseTool callback → Voice prompt to user →
User says "allow"/"deny" → Callback resolves → Tool executes/blocks
```

---

## Feature: OpenAI Codex Integration

### Overview
OpenAI Codex has a proper SDK (`@openai/codex-sdk`) that provides programmatic control, similar to Claude Agent SDK.

### Installation
```bash
npm install @openai/codex-sdk
```

### SDK Usage (Recommended)
```typescript
import { Codex } from "@openai/codex-sdk";

// Create Codex instance
const codex = new Codex({
  workingDirectory: '/path/to/project',
});

// Start a thread (conversation)
const thread = codex.startThread();

// Run a prompt
const result = await thread.run("Fix the bug in auth.ts");
console.log(result.finalResponse);

// Continue the conversation
const result2 = await thread.run("Now add tests for it");

// Resume a previous thread
const previousThread = codex.resumeThread("<thread-id>");
```

### Streaming Events
```typescript
// Use runStreamed() for real-time updates
for await (const event of thread.runStreamed("Refactor this code")) {
  if (event.type === 'tool_call') {
    console.log('Tool:', event.name);
  } else if (event.type === 'response') {
    console.log('Response:', event.text);
  }
}
```

### CodexHandler Class (To Implement)
```typescript
import { Codex, Thread } from "@openai/codex-sdk";
import { EventEmitter } from 'events';

export class CodexHandler extends EventEmitter {
  private codex: Codex;
  private thread: Thread | null = null;

  constructor(options: { workingDirectory?: string }) {
    super();
    this.codex = new Codex({
      workingDirectory: options.workingDirectory,
    });
  }

  async run(prompt: string): Promise<string> {
    if (!this.thread) {
      this.thread = this.codex.startThread();
    }

    let response = '';
    for await (const event of this.thread.runStreamed(prompt)) {
      this.emit('event', event);
      if (event.type === 'response') {
        response += event.text;
      }
    }
    return response;
  }

  clearSession(): void {
    this.thread = null;
  }
}
```

### MCP Server (Alternative)
For multi-agent workflows, Codex can also run as an MCP server:
```bash
codex mcp-server
```

Exposes tools:
- `codex(prompt, options)` - Start a conversation
- `codex-reply(prompt, conversationId)` - Continue conversation

### Provider Selection UI
```
┌─────────────────────────────────────────────────┐
│              Voice Model                        │
│  ┌──────────────┐  ┌──────────────┐            │
│  │ OpenAI       │  │ Gemini Live  │            │
│  └──────────────┘  └──────────────┘            │
│                                                 │
│              Coding Agent                       │
│  ┌──────────────┐  ┌──────────────┐            │
│  │ Claude Code  │  │ OpenAI Codex │            │
│  └──────────────┘  └──────────────┘            │
│                                                 │
│         [Connect to Voice]                      │
└─────────────────────────────────────────────────┘
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         Frontend                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │ Voice Model  │  │ Coding Agent │  │ Connect Btn  │       │
│  │ Selector     │  │ Selector     │  │              │       │
│  └──────────────┘  └──────────────┘  └──────────────┘       │
│                           │                                  │
│                    Token Request                             │
│                    (provider, agent)                         │
└───────────────────────────┼─────────────────────────────────┘
                            ▼
┌───────────────────────────────────────────────────────────┐
│                      Token API                             │
│  - Validates provider (openai/gemini)                     │
│  - Validates agent (claude/codex)                         │
│  - Includes in participant metadata                       │
└───────────────────────────┼───────────────────────────────┘
                            ▼
┌───────────────────────────────────────────────────────────┐
│                    LiveKit Agent                           │
│                                                            │
│  1. Connect to room                                        │
│  2. Wait for participant                                   │
│  3. Read metadata: { provider, agent }                     │
│  4. Create voice model (OpenAI or Gemini)                  │
│  5. Create coding agent (Claude or Codex)                  │
│  6. Start session                                          │
│                                                            │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ Voice Model        │        Coding Agent            │  │
│  │ (OpenAI/Gemini)    │        (Claude/Codex)          │  │
│  │                    │                                 │  │
│  │ Audio In/Out  ────►│────►  Code Tasks               │  │
│  │ Turn Detection     │        File Operations         │  │
│  │ Tool Calling       │        Terminal Commands       │  │
│  └─────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────┘
```

---

## Permission System Design

### Voice-Based Approval Flow

```
┌──────────────────────────────────────────────────────────┐
│ User: "Create a new file called app.js"                   │
└───────────────────────────┬──────────────────────────────┘
                            ▼
┌──────────────────────────────────────────────────────────┐
│ Claude requests: Write tool for /path/to/app.js          │
└───────────────────────────┬──────────────────────────────┘
                            ▼
┌──────────────────────────────────────────────────────────┐
│ canUseTool callback fires                                 │
│ Agent speaks: "I need to create a file at app.js.        │
│               Should I proceed? Say allow or deny."       │
└───────────────────────────┬──────────────────────────────┘
                            ▼
┌──────────────────────────────────────────────────────────┐
│ User: "Allow" / "Always allow" / "Deny"                   │
└───────────────────────────┬──────────────────────────────┘
                            ▼
┌──────────────────────────────────────────────────────────┐
│ callback returns: { behavior: 'allow' | 'deny' }          │
│ Tool executes or is blocked                               │
└──────────────────────────────────────────────────────────┘
```

### Permission Options
- **Allow** - Approve this specific request
- **Always Allow** - Add to allowlist for session
- **Deny** - Block this request
- **Always Deny** - Add to denylist for session

---

## Implementation Steps

### Phase 1: Fix Critical Issues (Now)
1. ✅ Fix model name (`gemini-2.0-flash-live-001`)
2. ⏳ Fix connection stuck issue (use `waitForParticipant`)
3. ⏳ Add proper error handling for Gemini connection

### Phase 2: Permission System
1. Replace hook-based permissions with `canUseTool` callback
2. Add voice prompts for permission requests
3. Implement "Allow", "Always Allow", "Deny" options
4. Store session allowlists/denylists

### Phase 3: OpenAI Codex Integration
1. Add agent selector to frontend
2. Create CodexHandler class (similar to ClaudeHandler)
3. Pass agent choice in metadata
4. Dynamically create appropriate agent

### Phase 4: Polish
1. Add voice selection for each provider
2. Add session management (clear context, etc.)
3. Add cost tracking display
4. Add latency metrics display

---

## References

- [LiveKit Gemini Plugin](https://docs.livekit.io/agents/models/realtime/plugins/gemini/)
- [LiveKit Google Integration](https://docs.livekit.io/agents/integrations/google/)
- [Claude Agent SDK Permissions](https://platform.claude.com/docs/en/agent-sdk/permissions)
- [OpenAI Codex CLI](https://github.com/openai/codex)
- [OpenAI Codex with Agents SDK](https://developers.openai.com/codex/guides/agents-sdk/)
