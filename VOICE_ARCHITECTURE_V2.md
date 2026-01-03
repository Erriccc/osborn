# Voice Architecture V2 - Siri-like Experience

## Vision

Build a **truly conversational voice interface** for AI coding assistants (Claude Code, Gemini CLI, Codex CLI) with:
- Sub-200ms response latency for acknowledgments
- Natural multi-turn conversations
- Ability to interrupt and add context mid-conversation
- CLI-agnostic design (works with any AI CLI tool)
- React-based hosted frontend that connects via WebSocket
- Fast LLM as "conversation manager" alongside Claude as "engineer"

---

## Priorities

### P0 - Core Experience
1. **Fast acknowledgment** - User hears "got it" within 200ms of finishing speaking
2. **Continuous listening** - No need to press buttons between turns
3. **Interrupt support** - Can add more context while AI is processing
4. **Multi-CLI support** - Claude Code, Gemini CLI, Codex CLI as backends

### P1 - Smart Routing
1. **Fast orchestration layer** - Lightweight LLM for instant responses
2. **Context accumulation** - Gather multiple utterances before sending to heavy model
3. **Sub-agent dispatch** - Fast model can spawn research tasks while conversing

### P2 - UX Polish
1. **Visual UI** - Browser-based interface with conversation history
2. **Voice responses** - AI speaks back using fast TTS
3. **Status indicators** - Show when AI is thinking vs. ready

---

## Architecture Comparison

### Current (VS Code Extension)
```
User Voice → VS Code Webview → Extension Host → Claude CLI
                    ↓
              Extra layer of complexity
              Limited by VS Code's architecture
              Can't work with other CLIs
```

### Proposed (MCP + Browser)
```
User Voice → Browser (Web Speech API) → WebSocket → MCP Server → Hooks → Any CLI
                    ↓
              Direct integration
              CLI-agnostic
              Sub-200ms to CLI awareness
```

---

## Key Insights from mcp-voice-hooks

### 1. Hook-Based Integration (The Secret Sauce)

Claude Code hooks intercept events and can inject voice input directly:

```json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "curl -s -X POST http://localhost:5111/api/hooks/stop"
      }]
    }],
    "PostToolUse": [{
      "matcher": "^(?!.*_voice-hooks__)",
      "hooks": [{
        "type": "command",
        "command": "curl -s -X POST http://localhost:5111/api/hooks/post-tool"
      }]
    }]
  }
}
```

**Stop Hook**: When Claude tries to finish, check for pending voice input first.
**PostToolUse Hook**: After any tool, check if user has spoken.

### 2. Browser-Native Speech (No API Keys)

```javascript
// Speech Recognition - runs locally in browser
const recognition = new webkitSpeechRecognition();
recognition.continuous = true;
recognition.interimResults = true;  // Real-time streaming

// Text-to-Speech - also local
const utterance = new SpeechSynthesisUtterance(text);
speechSynthesis.speak(utterance);
```

**Benefits**:
- No Whisper API calls = no latency
- No TTS API calls = instant playback
- No API keys required
- Works offline

### 3. Utterance State Machine

```
pending → delivered → responded
   ↑          ↑           ↑
User speaks  Hook fires   TTS plays
```

Three states ensure nothing is lost and responses are tracked.

### 4. Server-Sent Events for TTS

```javascript
// Server pushes speech to browser
app.get('/api/tts-events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  // Notify all connected browsers
});
```

No polling - browser receives speech immediately.

---

## Multi-Tier LLM Architecture

### The Problem
Claude/GPT-4/Gemini are slow (2-10 seconds per response).
For Siri-like UX, we need instant acknowledgment.

### The Solution: Fast Orchestrator Pattern

```
┌─────────────────────────────────────────────────────────────────┐
│                    Fast Orchestrator (Haiku/Gemini Flash)        │
│                                                                  │
│  • Acknowledges user instantly ("Got it, let me check...")      │
│  • Accumulates context from multiple utterances                  │
│  • Decides when to dispatch to heavy model                       │
│  • Manages conversation state                                    │
│  • ~100-200ms response time                                      │
└──────────────────────────────┬──────────────────────────────────┘
                               │
              ┌────────────────┼────────────────┐
              ↓                ↓                ↓
     ┌────────────────┐ ┌────────────────┐ ┌────────────────┐
     │  Claude Code   │ │  Gemini CLI    │ │  Codex CLI     │
     │  (Opus/Sonnet) │ │  (Gemini Pro)  │ │  (GPT-4)       │
     │                │ │                │ │                │
     │  Heavy lifting │ │  Heavy lifting │ │  Heavy lifting │
     │  Code gen/edit │ │  Research      │ │  Code review   │
     └────────────────┘ └────────────────┘ └────────────────┘
```

### Fast Model Options

| Model | Latency | Cost | Best For |
|-------|---------|------|----------|
| Claude Haiku | ~150ms | $0.25/M | Acknowledgment, routing |
| Gemini Flash | ~100ms | Free tier | Real-time conversation |
| GPT-4o-mini | ~200ms | $0.15/M | Quick responses |
| Groq (Llama 3) | ~50ms | Free tier | Ultra-fast inference |
| Local (Ollama) | ~100ms | Free | Privacy, offline |

### Conversation Flow

```
User: "Hey, I need to refactor the auth module"
Fast LLM: "Got it! What specifically about auth needs work?"

User: "The login flow is messy and..."
Fast LLM: [accumulating context...]

User: "...also the session handling is broken"
Fast LLM: "Understood - login flow cleanup and session fix. Should I have Claude analyze the auth module now?"

User: "Yes"
Fast LLM: [dispatches to Claude Code with full context]
Claude: [starts deep analysis]
Fast LLM: "Claude is looking at it now. Anything else to add while it works?"

User: "Also check the tests"
Fast LLM: [adds to context, will include when Claude responds]
```

---

## Implementation Plan

### Phase 1: Core MCP Server
- [ ] Node.js/TypeScript MCP server
- [ ] HTTP endpoints for voice input
- [ ] Hook handlers (Stop, PostToolUse)
- [ ] SSE for TTS streaming
- [ ] Utterance queue with state machine

### Phase 2: Browser Frontend
- [ ] Web Speech API integration
- [ ] Real-time transcription display
- [ ] Conversation history
- [ ] Voice response playback
- [ ] Status indicators

### Phase 3: Multi-CLI Support
- [ ] Claude Code hooks
- [ ] Gemini CLI integration (if hooks available)
- [ ] Generic CLI wrapper for others

### Phase 4: Fast Orchestrator
- [ ] Haiku/Flash integration for instant responses
- [ ] Context accumulation logic
- [ ] Dispatch decision engine
- [ ] Parallel sub-agent spawning

---

## Key Technical Decisions

### Why MCP over VS Code Extension?
1. **CLI-agnostic** - Works with any terminal-based AI
2. **Simpler architecture** - No VS Code webview layer
3. **Hook integration** - Direct interrupt-driven flow
4. **Browser freedom** - Full Web Speech API access

### Why Browser-Native Speech?
1. **Zero latency** - No API round trips
2. **No API keys** - Works out of box
3. **Offline capable** - Local speech recognition
4. **Better voices** - Modern browsers have quality TTS

### Why SSE over WebSockets?
1. **Simpler** - One-way server→client for TTS
2. **Auto-reconnect** - Built into EventSource
3. **Sufficient** - Voice input goes via HTTP POST

---

## Communication Protocol Comparison

### Option A: Claude Code Hooks + MCP Server

**How it works**: Claude Code runs first, MCP server registered via `claude mcp add`, hooks configured in settings.

```
User installs MCP server → Runs `claude` → MCP tools available
                                    ↓
                         Hooks intercept events
                                    ↓
                         Voice input injected via hook response
```

**Pros**:
- ✅ Official Claude Code integration pattern
- ✅ Hooks provide interrupt-driven flow (sub-200ms)
- ✅ MCP tools can be called by Claude naturally
- ✅ Simple installation via `npx`

**Cons**:
- ❌ Claude must run first, then you connect
- ❌ Hard to manage from hosted frontend
- ❌ Can't easily switch between CLIs
- ❌ MCP registration is per-project

**Complexity**: Medium
**Best for**: Local development, single CLI

---

### Option B: Wrapper Service (stream-json Protocol)

**How it works**: Our service runs first, spawns Claude Code as subprocess, communicates via JSON over stdio.

```
Our Server runs → User connects via browser
                        ↓
              Service spawns `claude --output-format stream-json`
                        ↓
              JSON messages piped via stdin/stdout
                        ↓
              Permissions handled via control_request/control_response
```

**Protocol Details** (from claude-code-chat):
```typescript
// Send message to Claude
const userMessage = {
  type: 'user',
  session_id: sessionId,
  message: {
    role: 'user',
    content: [{ type: 'text', text: message }]
  }
};
claudeProcess.stdin.write(JSON.stringify(userMessage) + '\n');

// Receive from Claude
claudeProcess.stdout.on('data', (data) => {
  const jsonData = JSON.parse(line);

  if (jsonData.type === 'control_request') {
    // Permission request - show UI
    // subtype: 'can_use_tool'
  }

  if (jsonData.type === 'assistant') {
    // Claude's response streaming
  }

  if (jsonData.type === 'result') {
    // Done
  }
});

// Respond to permission
const response = {
  type: 'control_response',
  request_id: requestId,
  response: { approved: true }
};
claudeProcess.stdin.write(JSON.stringify(response) + '\n');
```

**Pros**:
- ✅ Full control over Claude Code lifecycle
- ✅ Can add MCP servers programmatically
- ✅ Easy to swap CLI backends (Gemini, Codex)
- ✅ Works with hosted frontend
- ✅ Fast LLM layer fits naturally

**Cons**:
- ❌ More code to write
- ❌ Need to handle process management
- ❌ No hook-based interrupts (must wait for turn)

**Complexity**: Higher initially, cleaner long-term
**Best for**: Production, multi-CLI, hosted frontend

---

### Option C: Hybrid (Wrapper + Hooks)

**How it works**: Wrapper service spawns Claude, also configures hooks for interrupt capability.

```
Our Server runs → Configures .claude/settings.local.json with hooks
                        ↓
              Spawns Claude with hook endpoints pointing to us
                        ↓
              Both stream-json AND hooks working together
```

**Pros**:
- ✅ Best of both worlds
- ✅ Interrupt capability via hooks
- ✅ Full control via wrapper
- ✅ Fast LLM can use hooks too

**Cons**:
- ❌ Most complex to implement
- ❌ Must manage hook configuration

**Complexity**: Highest
**Best for**: Full-featured production system

---

## Recommended Approach: Option B → Option C

Start with **Option B** (wrapper) for MVP:
1. Simple, works with hosted frontend
2. Easy to add fast LLM layer
3. Can switch between CLIs

Evolve to **Option C** (hybrid) for v2:
1. Add hooks for interrupt capability
2. Sub-200ms voice injection
3. True Siri-like experience

---

## Fast LLM Architecture ("Conversation Manager")

The fast LLM is NOT a replacement for Claude. It's a **conversation manager** that:

### Responsibilities

1. **Keep conversation alive** - Instant acknowledgment ("Got it, working on that...")
2. **Observe Claude's stream** - Summarize what Claude is doing
3. **Route voice input** - Decide: respond directly OR send to Claude
4. **Alert on permissions** - "Claude needs permission to run this command"
5. **Answer context questions** - Quick Q&A about what's happening

### Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              Browser (React Frontend)                         │
│  • Web Speech API for voice input/output                                      │
│  • Conversation UI                                                            │
│  • Permission approval buttons                                                │
│  • Hosted on Vercel/Netlify/etc                                               │
└─────────────────────────────┬────────────────────────────────────────────────┘
                              │ WebSocket
                              ↓
┌──────────────────────────────────────────────────────────────────────────────┐
│                           Voice Server (Node.js)                              │
│                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                    Fast LLM Layer (Haiku/Groq/Flash)                    │ │
│  │                                                                          │ │
│  │  • Receives all voice input first                                        │ │
│  │  • Instant responses for simple queries                                  │ │
│  │  • Observes Claude's output stream (read-only)                          │ │
│  │  • Maintains conversation context                                        │ │
│  │  • Decides when to invoke Claude                                         │ │
│  │  • Formats permission requests for user                                  │ │
│  └─────────────────────────────────────┬───────────────────────────────────┘ │
│                                        │                                      │
│                          ┌─────────────┴─────────────┐                       │
│                          ↓                           ↓                        │
│  ┌─────────────────────────────────┐ ┌─────────────────────────────────────┐ │
│  │     Claude Code (subprocess)    │ │     Other CLIs (optional)           │ │
│  │                                 │ │                                      │ │
│  │  • stream-json protocol         │ │  • Gemini CLI                        │ │
│  │  • stdin/stdout pipes           │ │  • Codex CLI                         │ │
│  │  • control_request/response     │ │  • Custom wrappers                   │ │
│  │  • MCP servers attached         │ │                                      │ │
│  └─────────────────────────────────┘ └─────────────────────────────────────┘ │
│                                                                               │
│  Can run: locally, GitHub Codespaces, cloud VPS, etc.                        │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Conversation Flow Example

```
User: "Hey, can you help me refactor the auth module?"

Fast LLM: (instant) "Sure! What specifically about the auth module needs work?"
[No Claude invoked yet - simple conversation]

User: "The login flow is messy and the session handling has a bug"

Fast LLM: (instant) "Got it - login flow cleanup and session bug fix.
          Want me to have Claude analyze the auth module now?"

User: "Yes"

Fast LLM: (instant) "Starting analysis..."
[Spawns Claude Code with context]
[Observes Claude's stream]

Fast LLM: (while Claude works) "Claude is reading your auth files now..."

Claude: (via stream) [tool_use: Read auth/login.ts]

Fast LLM: "Found login.ts, analyzing the flow..."

Claude: (permission request) "Can I run the tests?"

Fast LLM: "Claude wants to run the test suite. Allow?"

User: "Yes, allow all for this session"

Fast LLM: [Approves, stores preference]

Claude: (completes analysis) "Here's what I found..."

Fast LLM: "Analysis complete! Here's the summary: [brief version].
          Claude found 3 issues. Want me to read the full details?"
```

### Fast LLM Model Options

| Model | Latency | Cost | Context | Best For |
|-------|---------|------|---------|----------|
| **Groq Llama 3.1 70B** | ~50ms | Free tier | 128K | Ultra-fast, good reasoning |
| **Gemini Flash** | ~100ms | Free tier | 1M | Large context, fast |
| **Claude Haiku** | ~150ms | $0.25/M | 200K | Best reasoning for price |
| **GPT-4o-mini** | ~200ms | $0.15/M | 128K | Good balance |
| **Local Ollama** | ~100ms | Free | Varies | Privacy, offline |

### Context Management

Fast LLM maintains:
1. **Conversation history** - What user and Claude have said
2. **Claude's current state** - What Claude is doing right now
3. **Pending decisions** - Permissions waiting for approval
4. **User preferences** - "Always allow X", session settings

This context is passed to fast LLM on each turn, enabling coherent conversation.

---

## Files to Create

```
voice-mcp/
├── src/
│   ├── server.ts           # Main MCP + HTTP server
│   ├── hooks.ts            # Hook handlers
│   ├── queue.ts            # Utterance queue + state machine
│   ├── orchestrator.ts     # Fast LLM routing layer
│   └── cli-adapters/
│       ├── claude.ts       # Claude Code integration
│       ├── gemini.ts       # Gemini CLI integration
│       └── generic.ts      # Generic CLI wrapper
├── public/
│   ├── index.html          # Browser UI
│   ├── app.js              # Web Speech + conversation logic
│   └── styles.css          # UI styling
├── plugin/
│   └── hooks/
│       └── hooks.json      # Claude Code hooks config
├── package.json
└── README.md
```

---

## Performance Research & Roadblocks

### Claude Code Startup Latency

**Measured on macOS:**
- `claude --version`: ~1.5 seconds
- First API response: ~5-8 seconds additional
- **Total cold start**: 7-10 seconds

**Implication**: Spawning new Claude instances mid-conversation adds unacceptable latency.

### Session Persistence (Key Finding)

Claude Code supports persistent sessions:
- `claude --continue` - Resume most recent conversation
- `claude --resume` - Pick from previous sessions
- `claude --resume <id>` - Resume specific session

**What persists:**
- Full message history
- Tool calls and file references
- Background processes (run_in_background: true)
- Working directory and permissions
- Shell IDs preserved

**Limitations:**
- Sessions don't survive system reboot
- Local to the machine (can't transfer)
- Old sessions may be auto-cleaned

### Hook Injection Capability (Critical Finding)

Hooks CAN inject content into the conversation:

```json
// Stop hook can block and add reason to conversation
{
  "decision": "block",
  "reason": "User wants to add: also check the weather API"
}
```

```json
// UserPromptSubmit can add context
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "Additional context here"
  }
}
```

**This means**: We CAN interrupt mid-conversation via hooks. The Stop hook's "reason" becomes part of Claude's context.

### Pre-Warming Strategy (Recommended)

Instead of spawning Claude instances on-demand, **pre-warm at session start**:

```
Session Start
    ↓
Fast LLM greets user
    ↓
Background: Spawn 2-3 Claude instances
    ├── Instance 1: Primary coder (with hooks)
    ├── Instance 2: Researcher (different working dir)
    └── Instance 3: Reviewer (optional)
    ↓
Instances ready (~8 seconds)
    ↓
Fast LLM: "All systems ready. What are we working on?"
```

**Benefits:**
- Zero latency when user actually needs Claude
- Parallel processing for complex tasks
- Each instance can have different MCP servers attached

---

## LiveKit Integration

### What is LiveKit?

LiveKit is an **open-source WebRTC infrastructure** for real-time voice/video:
- Powers OpenAI's ChatGPT Advanced Voice Mode
- ~1000ms global latency
- Built-in turn detection and interruption handling
- 99% uptime, HIPAA/SOC2 compliant

### Why LiveKit for Voice AI?

| Feature | Web Speech API | LiveKit |
|---------|---------------|---------|
| Latency | Good locally | Ultra-low globally |
| Reliability | Browser-dependent | Production-grade |
| Turn detection | Manual | Automatic |
| Interruption | Manual | Built-in |
| Mobile support | Limited | Excellent |
| Telephony | No | Yes (dial-in/out) |

### LiveKit Architecture for Our Use Case

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         React Frontend (Vercel)                              │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │  LiveKit Client SDK                                                     ││
│  │  • Real-time audio capture                                              ││
│  │  • Turn detection (knows when user stops speaking)                      ││
│  │  • Interruption handling (user can interrupt AI)                        ││
│  │  • Audio playback with queue                                            ││
│  └─────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │ WebRTC (low-latency)
                                  ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│                      LiveKit Server (Cloud or Self-hosted)                   │
│                                                                              │
│  • SFU (Selective Forwarding Unit)                                          │
│  • NAT traversal handled                                                     │
│  • Global edge network                                                       │
│  • Room management                                                           │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │ WebRTC/WebSocket
                                  ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│                   LiveKit Agent (Our Voice Server)                           │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │  LiveKit Agents Framework                                               ││
│  │  • Joins room as participant                                            ││
│  │  • STT → Fast LLM → TTS pipeline                                        ││
│  │  • Automatic turn-taking                                                ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                  │                                           │
│                    ┌─────────────┴─────────────┐                            │
│                    ↓                           ↓                             │
│  ┌─────────────────────────┐ ┌─────────────────────────────────────────────┐│
│  │ Fast LLM (Groq/Flash)   │ │ Pre-warmed Claude Instances                 ││
│  │                         │ │                                              ││
│  │ • Instant responses     │ │ Instance 1: Primary coder                   ││
│  │ • Routing decisions     │ │ Instance 2: Researcher                      ││
│  │ • Context management    │ │ Instance 3: Reviewer                        ││
│  └─────────────────────────┘ └─────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────┘
```

### LiveKit Integration Steps

1. **Set up LiveKit Cloud account** (free tier: 1000 min/month)
2. **Create Next.js frontend** with LiveKit React SDK
3. **Build LiveKit Agent** in Python or Node.js
4. **Connect agent to Claude Code** via wrapper
5. **Add fast LLM layer** for instant responses

### LiveKit Agent Code Structure

```python
# Using LiveKit Agents Framework (Python)
from livekit import agents
from livekit.agents import llm, stt, tts

class VoiceAgent(agents.Agent):
    def __init__(self):
        self.fast_llm = GroqClient()
        self.claude_instances = []

    async def on_session_start(self):
        # Pre-warm Claude instances
        self.claude_instances = await self.spawn_claude_instances(3)

    async def on_user_speech(self, text: str):
        # Fast LLM responds first
        response = await self.fast_llm.chat(text)
        await self.speak(response)

        # Route to Claude if needed
        if self.should_invoke_claude(text):
            claude_response = await self.route_to_claude(text)
            await self.speak(claude_response)
```

### LiveKit vs Pure WebSocket

| Aspect | Pure WebSocket | LiveKit |
|--------|---------------|---------|
| Setup complexity | Lower | Higher |
| Audio quality | Manual handling | Optimized |
| Turn detection | Build yourself | Built-in |
| Scaling | Manual | Automatic |
| Mobile | Manual | SDK ready |
| Cost | Free (self-host) | Free tier + paid |
| Latency | Good | Better |

**Recommendation**: Start with **pure WebSocket** for MVP (simpler), upgrade to **LiveKit** for production (better UX).

---

## Multi-Instance Claude Architecture

### Pre-Warming Pattern

```
┌──────────────────────────────────────────────────────────────┐
│                    Session Initialization                     │
│                                                               │
│  1. User opens browser UI                                     │
│  2. WebSocket connects to Voice Server                        │
│  3. Fast LLM greets user                                      │
│  4. Background: spawn Claude instances with different configs │
│     ├── claude --resume <session1> (Primary coder)           │
│     ├── claude --resume <session2> (Researcher)              │
│     └── claude --resume <session3> (Reviewer)                │
│  5. ~8 seconds: All instances warm                           │
│  6. Ready indicator shown in UI                              │
└──────────────────────────────────────────────────────────────┘
```

### Instance Specialization

| Instance | Purpose | MCP Servers | Hooks |
|----------|---------|-------------|-------|
| Primary | Code editing, main conversation | filesystem, git | Stop, PostToolUse |
| Researcher | Background research, docs | web-search, firecrawl | None (async) |
| Reviewer | Code review, suggestions | None | None (on-demand) |

### Routing Logic

```typescript
function routeToInstance(userIntent: string, context: Context): Instance {
  if (isResearchQuery(userIntent)) {
    return instances.researcher;
  }
  if (isReviewRequest(userIntent)) {
    return instances.reviewer;
  }
  return instances.primary;
}
```

### Hook-Based Context Injection

When user adds context mid-conversation:

```
User speaks while Claude is working
        ↓
Fast LLM: "Got it, I'll let Claude know"
        ↓
Server queues the addition
        ↓
Stop hook fires when Claude pauses
        ↓
Hook returns: { decision: "block", reason: "User added: [context]" }
        ↓
Claude sees the new context and continues
```

---

## Open Questions

1. **Gemini CLI hooks?** - Does Gemini CLI support hooks like Claude Code?
2. **Codex CLI integration?** - How to integrate with OpenAI's Codex CLI?
3. **Fast model selection?** - Should user choose or auto-select based on task?
4. **Context window management?** - How much conversation history to keep?
5. **Multi-browser tabs?** - Support multiple concurrent voice sessions?
6. **LiveKit vs WebSocket?** - When to upgrade to LiveKit?
7. **Instance count?** - How many pre-warmed instances are optimal?

---

## References

### Voice Projects
- [mcp-voice-hooks](https://github.com/johnmatthewtennant/mcp-voice-hooks) - Hook-based voice integration
- [VoiceMode MCP](https://github.com/mbailey/voicemode) - MCP-based voice mode
- [claude-code-voice](https://github.com/Erriccc/claude-code-voice) - VS Code voice extension
- [claude-code-chat](https://github.com/andrepimenta/claude-code-chat) - VS Code chat interface

### LiveKit
- [LiveKit](https://livekit.io/) - Real-time communication platform
- [LiveKit Docs](https://docs.livekit.io/) - Full documentation
- [LiveKit Agents](https://docs.livekit.io/agents/overview/) - AI agent framework
- [LiveKit Next.js](https://docs.livekit.io/realtime/quickstarts/nextjs/) - React integration

### Claude Code
- [Claude Code Hooks](https://code.claude.com/docs/en/hooks) - Hook reference
- [Session Persistence](https://github.com/ruvnet/claude-flow/wiki/session-persistence) - Session management

### APIs
- [Web Speech API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API) - Browser speech
- [Groq API](https://groq.com/) - Ultra-fast LLM inference
- [Gemini Flash](https://ai.google.dev/) - Google's fast model

---

## CLI Hook Support Comparison

### Claude Code Hooks ✅ FULL SUPPORT

**8 Hook Events:**
- Stop, PreToolUse, PostToolUse, UserPromptSubmit
- SessionStart, SessionEnd, SubagentStop, PreCompact

**Injection Capability:**
```json
{
  "decision": "block",
  "reason": "User added context: [text injected into conversation]"
}
```

**Documentation:** [Claude Code Hooks](https://code.claude.com/docs/en/hooks)

---

### Gemini CLI Hooks ✅ FULL SUPPORT

**Similar Hook System to Claude Code!**

**Hook Events:**
- BeforeTool, AfterTool, BeforeToolSelection
- BeforeModel, AfterModel (key for injection!)
- BeforeAgentLoop, AfterAgentLoop
- SessionStart, SessionEnd
- BeforeCompression, Notification

**Injection Capability:**
BeforeModel hook can "modify prompts, inject context, or control model parameters"

**Configuration:**
```json
{
  "hooks": {
    "BeforeModel": [{ "command": "inject-context.sh" }]
  }
}
```

**Documentation:**
- [Gemini CLI Hooks](https://geminicli.com/docs/hooks/)
- [Writing Hooks](https://geminicli.com/docs/hooks/writing-hooks/)
- [Hooks Reference](https://geminicli.com/docs/hooks/reference/)
- [Feature Request: Comprehensive Hooking System](https://github.com/google-gemini/gemini-cli/issues/9070)

---

### OpenAI Codex CLI ⚠️ LIMITED SUPPORT

**Limited Event System:**
- `agent-turn-complete` notification only
- No mid-conversation injection via hooks

**Alternative: MCP Server Mode**
Codex can run AS an MCP server, allowing orchestration from another agent.

```bash
codex mcp-server  # Run Codex as MCP server
```

**Context Injection via:**
- AGENTS.md file (static context)
- MCP servers (tools, not conversation injection)
- Codex SDK for programmatic control

**Documentation:**
- [Codex CLI Features](https://developers.openai.com/codex/cli/features/)
- [Codex Config](https://github.com/openai/codex/blob/main/docs/config.md)

---

### CLI Hook Comparison Table

| Feature | Claude Code | Gemini CLI | Codex CLI |
|---------|-------------|------------|-----------|
| Hook system | ✅ Full | ✅ Full | ⚠️ Limited |
| Stop/pause hooks | ✅ | ✅ | ❌ |
| Before model hook | ✅ | ✅ BeforeModel | ❌ |
| Context injection | ✅ via reason | ✅ via BeforeModel | ⚠️ MCP only |
| Tool use hooks | ✅ Pre/Post | ✅ Pre/Post | ❌ |
| Session hooks | ✅ | ✅ | ❌ |
| Run as MCP server | ❌ | ❌ | ✅ |

**Conclusion:** Claude Code and Gemini CLI have equivalent hook systems. Codex requires a different approach (MCP server mode or SDK).

---

## LiveKit Technical Workflows

### Workflow 1: Voice Conversation with Claude Code

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 1: Browser Connects                                                    │
│                                                                              │
│  React Frontend (Vercel) → WebRTC → LiveKit Cloud → WebRTC → LiveKit Agent │
│                                                                              │
│  User opens app → Joins LiveKit room → Agent joins same room                │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 2: User Speaks                                                         │
│                                                                              │
│  Browser Mic → WebRTC audio stream → LiveKit SFU → Agent receives audio     │
│                                                                              │
│  LiveKit handles: NAT traversal, packet loss, jitter buffering              │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 3: Speech-to-Text (Agent)                                              │
│                                                                              │
│  Audio → STT Plugin (Deepgram/Whisper/AssemblyAI) → Text transcript         │
│                                                                              │
│  Turn detection: Model knows when user stops speaking                        │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 4: Fast LLM Response                                                   │
│                                                                              │
│  Transcript → Fast LLM (Groq/Haiku) → Instant acknowledgment                │
│                                                                              │
│  "Got it, let me have Claude look at that..."                               │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 5: Route to Claude Code                                                │
│                                                                              │
│  Fast LLM decides: needs Claude → Send to pre-warmed Claude instance        │
│                                                                              │
│  claudeProcess.stdin.write(JSON.stringify(userMessage))                      │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 6: Claude Works                                                        │
│                                                                              │
│  Claude stream → Agent observes → Fast LLM summarizes for user              │
│                                                                              │
│  "Claude is reading your files... found 3 issues..."                        │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 7: Text-to-Speech                                                      │
│                                                                              │
│  Response text → TTS Plugin (OpenAI/ElevenLabs) → Audio stream              │
│                                                                              │
│  Agent → WebRTC → LiveKit SFU → WebRTC → Browser speakers                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### Workflow 2: Screen Sharing for Code Review

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 1: User Shares Screen                                                  │
│                                                                              │
│  Browser: navigator.mediaDevices.getDisplayMedia()                           │
│  → Screen capture stream → WebRTC → LiveKit → Agent                         │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 2: Agent Receives Video Frames                                         │
│                                                                              │
│  LiveKit samples frames: 1 FPS during speech, 0.3 FPS otherwise             │
│  Frames encoded as JPEG, max 1024x1024                                       │
│                                                                              │
│  Agent has access to: room.video_tracks[user].frames                        │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 3: Vision Model Processing                                             │
│                                                                              │
│  Frame + Audio transcript → Multimodal LLM (Gemini/Claude Vision)           │
│                                                                              │
│  User: "What's wrong with this code?"                                        │
│  Agent sees: Screenshot of code editor                                       │
│  Agent: "I see a null pointer on line 42..."                                │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 4: Route to Claude Code for Fix                                        │
│                                                                              │
│  Agent extracts: file path, line numbers, issue description                  │
│  → Sends to Claude Code: "Fix null pointer in /src/auth.ts line 42"         │
│  → Claude edits file directly                                                │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### Workflow 3: LiveKit MCP Integration

**Note:** LiveKit has NATIVE MCP support - not Claude Code MCP, but general MCP.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 1: Configure MCP Servers in Agent                                      │
│                                                                              │
│  from livekit.agents.mcp import MCPServerStdio                               │
│                                                                              │
│  mcp_server = MCPServerStdio(                                                │
│      command="npx",                                                          │
│      args=["@anthropic-ai/claude-code-mcp"]  # or any MCP server            │
│  )                                                                           │
│                                                                              │
│  agent.add_mcp_server(mcp_server)  # One line!                              │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 2: LLM Calls MCP Tools                                                 │
│                                                                              │
│  User: "Search the web for React best practices"                             │
│                                                                              │
│  LLM (via LiveKit pipeline):                                                 │
│    → Sees available MCP tools: [web_search, firecrawl, ...]                 │
│    → Calls: web_search(query="React best practices 2025")                   │
│    → MCP server executes search                                              │
│    → Results returned to LLM                                                 │
│    → LLM responds to user                                                    │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 3: Combining MCP + Claude Code                                         │
│                                                                              │
│  Agent has:                                                                  │
│    - MCP servers for tools (web search, file ops, etc.)                     │
│    - Claude Code subprocess for heavy coding                                 │
│                                                                              │
│  Fast LLM routes:                                                            │
│    - Quick tool calls → MCP                                                  │
│    - Complex coding → Claude Code                                            │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### Workflow 4: Zoom-like Call with AI (Conceptual)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  OPTION A: LiveKit Meet (Their Open-Source Zoom Alternative)                 │
│                                                                              │
│  Multiple humans join LiveKit room                                           │
│      ↓                                                                       │
│  AI Agent also joins as participant                                          │
│      ↓                                                                       │
│  Humans talk to each other AND to AI                                         │
│  AI can see shared screens, hear conversations                               │
│                                                                              │
│  Use case: Team standup with AI note-taker + code assistant                 │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│  OPTION B: Zoom Integration via SIP/PSTN                                     │
│                                                                              │
│  LiveKit telephony can dial into Zoom via phone number                       │
│      ↓                                                                       │
│  AI agent joins Zoom call as phone participant                               │
│      ↓                                                                       │
│  Limited: Audio only, no screen share access                                 │
│                                                                              │
│  Better: Have users join LiveKit room instead of Zoom                        │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│  OPTION C: Custom Integration (agents-zoom-integration repo)                 │
│                                                                              │
│  There's a GitHub project for Zoom + LiveKit Agents integration             │
│  Not officially maintained by LiveKit                                        │
│                                                                              │
│  See: github.com/ginjaninja78/agents-zoom-integration                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Fast LLM: Do We Still Need It With LiveKit?

### The Question
LiveKit has a built-in STT → LLM → TTS pipeline. Does that replace our fast LLM layer?

### The Answer: It Depends on the Approach

**Approach A: LiveKit LLM IS the Fast Layer**

Use LiveKit's `llm_node()` with a fast model (Groq/Haiku), then route to Claude Code:

```
User speaks → STT → Fast LLM (via LiveKit pipeline) → TTS response
                            ↓
                   Route to Claude Code if needed
```

**Pros:**
- Simpler architecture
- LiveKit handles context management via ChatContext
- Built-in turn detection and interruption

**Cons:**
- Less control over routing logic
- Claude Code integration is "outside" the pipeline

---

**Approach B: Parallel SLM + LLM Pattern**

Use LiveKit's parallel execution to run both fast and slow models:

```
User speaks → STT → ┬→ Fast LLM (instant acknowledgment)
                    └→ Claude Code (heavy processing)
                            ↓
              Merge responses → TTS
```

**Pros:**
- True Siri-like instant response
- Claude Code works in parallel
- Best UX

**Cons:**
- More complex to implement
- Must merge context between models

---

**Approach C: Custom Pipeline Nodes**

Override LiveKit's `llm_node()` with custom logic:

```python
class VoiceAgent(Agent):
    async def llm_node(self, context):
        # 1. Quick acknowledgment from fast model
        fast_response = await self.fast_llm.respond(context)
        yield fast_response

        # 2. Route to Claude Code if needed
        if self.should_use_claude(context):
            claude_response = await self.claude_code.process(context)
            yield claude_response
```

**Pros:**
- Full control within LiveKit's framework
- Best of both worlds
- Clean separation of concerns

**Cons:**
- Requires understanding LiveKit internals

---

### Recommendation: Approach C (Custom Pipeline)

LiveKit's pipeline nodes are the perfect place to integrate our fast LLM + Claude Code pattern:

1. **STT node**: Keep default (Deepgram/Whisper)
2. **LLM node**: Custom - fast LLM first, then Claude Code
3. **TTS node**: Keep default (OpenAI/ElevenLabs)

This way:
- LiveKit handles all the hard stuff (WebRTC, turn detection, streaming)
- We just customize the LLM node for our routing logic
- Context management comes free via ChatContext

---

### Multi-Turn Conversation with LiveKit

LiveKit automatically manages conversation context:

```python
# Context is maintained per session
chat_context = ChatContext()

# Each turn adds to history
chat_context.messages.append(user_message)
chat_context.messages.append(assistant_response)

# RAG injection in on_user_turn_completed hook
async def on_user_turn_completed(self, message):
    # Add Claude Code context
    relevant_files = await self.claude_code.get_context()
    message.context = relevant_files
```

**Key insight**: We don't need a separate conversation manager - LiveKit's ChatContext handles it. We just need to sync it with Claude Code's session.

---

## Workflow Comparison: All Approaches

### Pure WebSocket (No LiveKit)

```
┌────────────────────────────────────────────────────────────────────┐
│  Browser                                                            │
│  └→ Web Speech API (STT) → WebSocket → Our Server                  │
│                                                  ↓                  │
│                                    Fast LLM → Claude Code          │
│                                                  ↓                  │
│  Browser ←────────── WebSocket ←── TTS Audio (OpenAI API)          │
└────────────────────────────────────────────────────────────────────┘

Pros: Simple, no external dependencies
Cons: Must build turn detection, handle audio quality, manage connections
Effort: High
Best for: Simple MVP, privacy-focused
```

---

### MCP + Hooks (mcp-voice-hooks style)

```
┌────────────────────────────────────────────────────────────────────┐
│  Browser (Web Speech API)                                           │
│  └→ WebSocket → MCP Server → Claude Code (with hooks)              │
│                                         ↓                           │
│                            Stop hook intercepts                     │
│                            Injects voice input                      │
│                                         ↓                           │
│  Browser ←────────── SSE ←── TTS response                          │
└────────────────────────────────────────────────────────────────────┘

Pros: Sub-200ms injection via hooks, official pattern
Cons: Claude must run first, harder to add fast LLM layer
Effort: Medium
Best for: Local development, single CLI
```

---

### Wrapper Service (claude-code-chat style)

```
┌────────────────────────────────────────────────────────────────────┐
│  Browser                                                            │
│  └→ WebSocket → Our Server                                         │
│                      ↓                                              │
│         Fast LLM (conversation manager)                            │
│                      ↓                                              │
│         Claude Code (spawned subprocess)                           │
│                      ↓                                              │
│  Browser ←── WebSocket ←── TTS response                            │
└────────────────────────────────────────────────────────────────────┘

Pros: Full control, multi-CLI support, hosted frontend works
Cons: Must wait for Claude's turn (no interrupt injection)
Effort: Medium-High
Best for: Production, multi-CLI, hosted frontend
```

---

### LiveKit (Recommended)

```
┌────────────────────────────────────────────────────────────────────┐
│  Browser (LiveKit Client SDK)                                       │
│  └→ WebRTC → LiveKit Cloud → WebRTC → LiveKit Agent                │
│                                              ↓                      │
│                              STT (Deepgram/Whisper)                │
│                                              ↓                      │
│                              Custom LLM Node:                       │
│                              ├→ Fast LLM (instant)                 │
│                              └→ Claude Code (heavy)                │
│                                              ↓                      │
│                              TTS (OpenAI/ElevenLabs)               │
│                                              ↓                      │
│  Browser ←───── WebRTC audio stream ←── LiveKit Agent              │
└────────────────────────────────────────────────────────────────────┘

Pros:
- Turn detection built-in
- Audio quality handled
- Mobile support
- Screen sharing
- Parallel model execution
- Native MCP support
- Context management included

Cons:
- External service (though free tier available)
- Learning curve

Effort: Medium (using their starter templates)
Best for: Production-quality Siri-like experience
```

---

### Hybrid: LiveKit + Hooks

```
┌────────────────────────────────────────────────────────────────────┐
│  Browser (LiveKit Client)                                           │
│  └→ WebRTC → LiveKit Cloud → LiveKit Agent                         │
│                                     ↓                               │
│                     Custom LLM Node + Hooks                         │
│                     ├→ Fast LLM (conversation)                     │
│                     └→ Claude Code (with Stop hooks)               │
│                                     ↓                               │
│                     Hooks enable mid-processing injection           │
│                                     ↓                               │
│  Browser ←───── WebRTC ←── TTS stream                              │
└────────────────────────────────────────────────────────────────────┘

Pros: Best of everything - LiveKit UX + hook injection
Cons: Most complex
Effort: High
Best for: Full-featured production system with interrupt capability
```

---

## Final Recommendation

**For MVP (Week 1-2):**
Use LiveKit with custom LLM node. Let LiveKit handle WebRTC, turn detection, and context. We just customize the LLM processing.

**For V2 (Week 3-4):**
Add Claude Code hooks for mid-conversation injection. This gives true Siri-like interrupt capability.

**Key Insight:**
LiveKit replaces the need for a SEPARATE conversation manager. But we still benefit from having a fast LLM in the pipeline for instant acknowledgments. The fast LLM lives INSIDE the LiveKit pipeline, not outside it.

---

## LiveKit Implementation Plan

### Phase 1: Basic Voice Agent (Week 1 MVP)

```
1. Set up LiveKit Cloud account (free tier)
2. Create Next.js frontend with @livekit/components-react
3. Build Node.js agent with @livekit/agents
4. Connect agent to pre-warmed Claude Code process
5. Basic voice conversation working
```

### Phase 2: Add Fast LLM Layer (Week 2)

```
1. Integrate Groq/Haiku for instant responses
2. Implement routing logic (fast LLM vs Claude)
3. Context management between layers
4. Permission handling via voice
```

### Phase 3: Screen Sharing + Vision (Week 3)

```
1. Enable screen capture in frontend
2. Add vision model (Gemini/Claude Vision)
3. Extract code context from screenshots
4. Route visual context to Claude Code
```

### Phase 4: Multi-CLI Support (Week 4)

```
1. Add Gemini CLI adapter with hooks
2. Add Codex CLI adapter (MCP mode)
3. CLI selection UI in frontend
4. Unified context across CLIs
```

---

## Additional GitHub Resources

### LiveKit Examples
- [livekit/agents](https://github.com/livekit/agents) - Main agents framework (8.8K stars)
- [livekit/agents-js](https://github.com/livekit/agents-js) - Node.js agent framework
- [livekit-examples/agent-starter-node](https://github.com/livekit-examples/agent-starter-node) - Node.js starter template
- [livekit-examples/vision-demo](https://github.com/livekit-examples/vision-demo) - Vision + voice demo with iOS frontend
- [livekit-examples/node-agents-examples](https://github.com/livekit-examples/node-agents-examples) - Multiple Node.js examples

### Zoom Integration
- [ginjaninja78/agents-zoom-integration](https://github.com/ginjaninja78/agents-zoom-integration) - Community Zoom integration

### Voice Projects (Referenced Earlier)
- [mcp-voice-hooks](https://github.com/johnmatthewtennant/mcp-voice-hooks) - Claude Code hook-based voice
- [voicemode](https://github.com/mbailey/voicemode) - MCP-based voice mode
- [claude-code-voice](https://github.com/Erriccc/claude-code-voice) - Our VS Code extension
- [claude-code-chat](https://github.com/andrepimenta/claude-code-chat) - VS Code chat wrapper

### Gemini CLI
- [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) - Official Gemini CLI
- [Hooks System DeepWiki](https://deepwiki.com/google-gemini/gemini-cli/3.10-hooks-system) - Hooks documentation
