# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Osborn is a voice AI research assistant. Users speak through a Next.js frontend; audio routes through LiveKit Cloud to a local TypeScript agent that researches topics, explores codebases, and documents findings via the Claude Agent SDK.

## Development Commands

### Agent (from `agent/`)
```bash
npm install
npm run dev              # Start agent with tsx (auto-reload)
npm run dev -- --room X  # Join a specific LiveKit room
npm run room X           # Shortcut for above
npm run build            # TypeScript compile to dist/
```

### Frontend (from `frontend/`)
```bash
npm install
npm run dev    # Next.js dev server on :3000
npm run build  # Production build
npm run lint   # ESLint via next lint
```

There is no test suite.

### Deployment
Frontend deploys to Railway (nixpacks, Node 22). Build: `cd frontend && npm install && npm run build`. Start: `cd frontend && npm run start`.

### Required Environment

Agent needs: `agent/.env` with `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `ANTHROPIC_API_KEY`, and at least one of `OPENAI_API_KEY` / `GOOGLE_API_KEY`. Optional: `SMITHERY_API_KEY` for cloud-hosted MCP servers (YouTube, GitHub via Smithery).

Frontend needs: `frontend/.env.local` with `NEXT_PUBLIC_LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.

## Architecture

```
Frontend (Next.js 14) <-> LiveKit Cloud <-> Agent (Node.js/tsx on local machine)
                                              ├── Claude Agent SDK (coding tools)
                                              ├── OpenAI/Gemini Realtime (voice)
                                              └── MCP Servers (extensions)
```

### Two Voice Modes
- **direct**: STT (Deepgram) → Claude Agent SDK → TTS (Deepgram). Full tool access, all research capabilities.
- **realtime**: OpenAI/Gemini native speech-to-speech. Low-latency voice; delegates research tasks to Claude via `ask_agent` tool.

### Research Mode

The agent operates in a single **research** mode. It can read any file, search the web, run commands, fetch YouTube transcripts, and save findings to a per-session workspace. There are no plan/execute or read-only/edit mode toggles.

**Write safety**: A `PreToolUse` hook in `claude-llm.ts` blocks `Write`/`Edit` outside `.osborn/sessions/` (and legacy `.osborn/research/`). All other tools are unrestricted. The `permissionMode` is `'default'` — the SDK prompts for dangerous operations.

**Session workspace** (created per session):
```
<workingDir>/.osborn/sessions/<full-session-uuid>/
  spec.md        # Evolving specification document
  library/       # Downloaded docs, transcripts, notes, code samples
```

**System prompt**: Always injected via `systemPrompt` field in `claude-llm.ts`. Describes research mode, workspace paths, write rules, and research workflow.

**Legacy types**: `EditMode` and `AgentMode` are still exported from `config.ts` for backward compatibility with old `.session-meta.json` files, but are not used in the active code path.

### Key Source Files

**Agent:**
- `agent/src/index.ts` — Main entry: LiveKit room events, session creation (`createDirectSession`/`createRealtimeSession`), all DataReceived handlers, HTTP API server (port 8741)
- `agent/src/claude-llm.ts` — `ClaudeLLM` class extending `llm.LLM`: wraps Claude Agent SDK `query()`, research mode system prompt, session resume, MCP servers, checkpoints, permission flow
- `agent/src/config.ts` — `OsbornConfig` loading from `~/.osborn/config.yaml`, session management (list/get/history), session workspace helpers, `listWorkspaceArtifacts()` for file explorer persistence, MCP catalog with Smithery cloud support
- `agent/src/smithery-proxy.ts` — In-process MCP proxy for Smithery cloud servers. Bypasses Claude Agent SDK HTTP bug (#18296) by using `@smithery/api/mcp` `createConnection()` + MCP SDK `Client` to get a working transport, then wraps in local `McpServer` as `type: 'sdk'`
- `agent/src/voice-io.ts` — Factory functions for STT, TTS, VAD, and realtime model creation

**Frontend:**
- `frontend/src/components/VoiceRoom.tsx` — Main UI component (~2000 lines): voice visualization, chat, permission UI, session management, MCP toggles, always-visible files panel with session artifact persistence
- `frontend/src/components/MarkdownMessage.tsx` — Markdown renderer with syntax highlighting (highlight.js + rehype). `CodeBlock` accepts `React.ReactNode` children (not `String()`) to preserve rehype-highlight spans. `extractText()` walks React tree for copy button
- `frontend/src/components/SessionBrowser.tsx` — Past session browser
- `frontend/src/app/api/token/route.ts` — LiveKit JWT token generation with metadata (provider, voiceArch, sessionId)
- `frontend/src/app/page.tsx` — Landing page: room join, provider/session selection

### Data Channel Protocol

Frontend ↔ Agent communication uses LiveKit data channels:
- **Agent → Frontend** (`topic: 'osborn-updates'`): `tool_use`, `tool_result`, `tool_blocked`, `agent_state`, `agent_ready`, `permission_request`, `claude_output`, `assistant_response`, `task_completed`, `plan_file_updated`, `research_artifact_updated`, `session_resume_set`, `session_artifacts`, `mcp_toggle_result`, `mcp_servers_changed`, `mcp_status`, `checkpoint_captured`
- **Frontend → Agent** (`topic: 'user-input'`): `permission_response`, `user_text`, `resume_session`, `continue_session`, `switch_session`, `mcp_toggle`, `get_mcp_status`, `session_selected`, `get_plan_file`, `get_research_artifact`, `get_session_artifacts`

### Session & File Storage
- Sessions: `~/.claude/projects/<project-path>/` as `.jsonl` files + `.session-meta.json`
- Session workspace: `<workingDir>/.osborn/sessions/<full-session-uuid>/` (spec.md + library/)
- Legacy research dir: `<workingDir>/.osborn/research/` (still accepted by write hook)
- Plan files: `~/.claude/plans/`
- Config: `~/.osborn/config.yaml` (auto-created on first run)

### MCP Server System

MCP servers extend Claude with external tools (GitHub, YouTube, etc.). Three transport types:
- **stdio** (local): Spawns a local process (`npx -y @modelcontextprotocol/server-...`). No auth needed.
- **http** (cloud): Standard Streamable HTTP MCP endpoints. **Note:** Claude Agent SDK has a known bug (#18296, #7290) where `type: 'http'` forces OAuth discovery on all HTTP servers, ignoring configured auth headers. As a workaround, Smithery servers use the `sdk` proxy (see below).
- **sdk** (in-process proxy): Used for Smithery cloud servers via `smithery-proxy.ts`. Uses `@smithery/api/mcp` `createConnection()` to get a working `StreamableHTTPClientTransport`, connects an MCP `Client`, lists remote tools, then wraps them in a local `McpServer` passed as `{ type: 'sdk', name, instance }` to the Claude SDK.

**Catalog** (`MCP_CATALOG` in `config.ts`): Built-in server definitions. `McpCatalogEntry` supports stdio (`command`, `args`, `env`) and http (`transport`, `url`, `requiredHeaders`) fields. For Smithery servers, the URL is used by `smithery-proxy.ts` to extract namespace/connectionId.

**Key functions** in `config.ts`:
- `buildMcpServersForKeys()` — Merges catalog defaults with user config overrides for non-Smithery servers (stdio)
- `getMcpServerStatusList()` — Returns availability status for UI toggles. Checks env vars for stdio, headers for http
- `getMcpToolPatterns()` — Returns `mcp__<name>__*` glob patterns for `allowedTools`

**Smithery proxy** (`smithery-proxy.ts`):
- `createSmitheryProxy(config)` — Async. Connects to Smithery, discovers tools, creates proxy `McpServer`. Returns `McpSdkServerConfigWithInstance`
- `destroySmitheryProxy(name)` — Cleans up client/server connections
- `parseSmitheryUrl(url)` — Extracts `{namespace, connectionId}` from `api.smithery.ai/connect/.../mcp` URLs
- `isSmitheryUrl(url)` — Checks if a URL is a Smithery Connect endpoint

**Toggle flow**: Frontend sends `mcp_toggle` → `index.ts` checks if Smithery URL → if yes, `createSmitheryProxy()` builds `type: 'sdk'` config → `currentLLM.enableMcpServer(key, config)` → next `query()` call includes the server

**Init logging**: `ClaudeLLMStream.run()` logs `✅ MCP server <name>: connected` or `❌ MCP server <name>: <status>` from the SDK's system init message.

## Critical Patterns

- **opts sync**: When updating ClaudeLLM state (`setResumeSessionId`, `setContinueSession`, `resetForSessionSwitch`), always sync to both the instance field AND `this.#opts` — otherwise `ClaudeLLMStream` won't see the update.
- **Unified voice injection queue**: ALL system injections (research updates, completions, notifications, errors) go through `voiceQueue[]` + `queueVoiceInjection()` + `processVoiceQueue()`. Never call `generateReply` directly for injections. The queue only processes when `agentState === 'listening'`. Multiple items are batched into one `generateReply({ instructions, toolChoice: 'none' })` call. The `agent_state_changed` → `listening` event triggers `processVoiceQueue()` again after the model finishes speaking.
- **Voice announcements in realtime mode**: Use `queueVoiceInjection()` (which gates on model availability) not `session.generateReply()` directly, and not `session.say()` (no standalone TTS in realtime). Use `[NOTIFICATION]` prefix + "Do NOT call any tools" to prevent feedback loops.
- **Feedback loop prevention**: Never pass system messages through `generateReply({ userInput })` in realtime — Gemini/OpenAI treats them as new user requests. Use dedup guard (`lastTaskRequest`/`lastTaskTime` with 10s window).
- **ReactMarkdown**: Must receive content as children (`<ReactMarkdown>{content}</ReactMarkdown>`), not self-closing.
- **extractTextContent()**: Use this helper (in `config.ts`) when reading conversation history to avoid dumping raw tool_use/tool_result JSON.
- **PostToolUse must emit `input`**: The `PostToolUse` hook emits `tool_result` events with `{ name, input: input?.tool_input || {} }`. The `input` field is required — `index.ts` checks `data.input?.file_path` to detect session workspace writes (both `.osborn/sessions/` and `.osborn/research/`).
- **Non-blocking `ask_agent`**: The `ask_agent` tool returns immediately ("Research started...") and runs Claude research in the background. Progress updates are queued in `activeResearch.pendingUpdates`, debounced by `scheduleResearchBatch()` (3s), and pushed to the unified `voiceQueue`. Final results are pushed via `queueVoiceInjection('[RESEARCH COMPLETE] ...')`. The voice queue gates all injections on `agentState === 'listening'` — no more immediate/deferred dual paths or `generateReply timed out` errors. The `activeResearch` guard prevents concurrent research tasks.
- **Smithery proxy for cloud MCP**: Claude Agent SDK's `type: 'http'` transport has a bug (#18296) that forces OAuth on all HTTP servers. Smithery servers are connected via in-process proxy (`smithery-proxy.ts`) using `createSmitheryProxy()` which returns `type: 'sdk'` config. The proxy uses `@smithery/api/mcp` `createConnection()` for the working transport. The proxy patches both `McpServer.connect` and `Server._server.connect` to handle reconnection across SDK `query()` calls.
- **Research event batching**: During background `ask_agent` execution, tool_use/tool_result/assistant_text events push to both `researchLog` (full history) and `pendingUpdates` (queue). `scheduleResearchBatch()` debounces (3s), formats the batch as a `[RESEARCH UPDATE]`, and pushes to `voiceQueue`. Final result includes research log + 2500-char findings.
- **SWC parser quirk**: Next.js SWC parser chokes on `> 0` inside template literals in JSX `className`. Use truthy checks (`arr.length` not `arr.length > 0`) in template expressions.

## Prompt System (for performance tracking)

The system has layered prompts at different levels:

| Layer | Location | When | Content |
|---|---|---|---|
| **Realtime voice model** | `index.ts` | Realtime sessions | Large prompt: Osborn persona, `ask_agent` delegation rules, anti-hallucination rules, clarifying questions, live research updates (`[RESEARCH UPDATE]`/`[RESEARCH COMPLETE]`), adaptive verbosity (brief/standard/detailed/full), notification handling |
| **Direct voice agent** | `index.ts` | Direct sessions | Short: "You are Osborn, a voice AI research assistant..." |
| **Claude SDK research mode** | `claude-llm.ts` | Always | Injected via `systemPrompt` field: research mode rules, session workspace path, write rules, spec.md workflow, library artifact guidance |
| **`ask_agent` tool desc** | `index.ts` | Realtime sessions | Full capability list (research, bash, MCP tools, code analysis). Non-blocking: returns immediately, injects progress + final results via `generateReply()` |
| **Notifications** | `announceViaVoice()` → `queueVoiceInjection()` in `index.ts` | Any mode | `[NOTIFICATION] {text}. Acknowledge briefly. Do NOT call any tools.` |
| **Research progress** | `scheduleResearchBatch()` + `queueVoiceInjection()` in `index.ts` | During research | `[RESEARCH UPDATE]` batched (3s debounce) + `[RESEARCH COMPLETE]` with specificity mandate. All go through unified `voiceQueue`, gated on `listening` state. Uses `toolChoice: 'none'` |
| **Session context** | `buildContextBriefing()` → `generateReply()` | Session resume/switch | `[SESSION RESUMED]` or `[SESSION SWITCHED]` with conversation history summary |
| **Fresh greeting** | `index.ts` | New connections | "The user just connected. Briefly greet them as Osborn..." |

## TypeScript Config Notes
- Agent: `strict: false`, ESM (`module: ESNext`, `moduleResolution: bundler`, `target: ES2022`)
- Frontend: `strict: true`, path alias `@/*` → `./src/*`
- `dotenv/config` must be the first import in `agent/src/index.ts` (env vars needed before other modules load)
