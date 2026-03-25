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

**Write safety**: A `PreToolUse` hook in `claude-llm.ts` blocks `Write`/`Edit` outside `.osborn/sessions/` (and legacy `.osborn/research/`). The `canUseTool` callback auto-approves writes to the session workspace (no permission prompt), while all other tools use `permissionMode: 'default'`. The system prompt has strict file writing rules (full absolute paths, no hallucinated writes).

**Session workspace** (created per session, includes default `spec.md` template):
```
<workingDir>/.osborn/sessions/<full-session-uuid>/
  spec.md        # Portable research output: goal, user context, open questions (bidirectional), decisions, findings, plan
  library/       # Offloaded research: transcripts, guides, factual deep dives, code samples
```

The fast brain (`fast-brain.ts`) maintains `spec.md` and `library/` — reading FULL untruncated data from Claude's JSONL session files via `session-access.ts` after research completes. The research agent focuses on thorough investigation; the fast brain consolidates findings into the workspace.

**System prompt**: Defined in `prompts.ts` via `getResearchSystemPrompt()`, injected via `systemPrompt` field in `claude-llm.ts`. The research agent reads `spec.md` for context but does NOT write to it — the fast brain handles all spec/library writes via `updateSpecFromJSONL()`.

**Legacy types**: `EditMode` and `AgentMode` are still exported from `config.ts` for backward compatibility with old `.session-meta.json` files, but are not used in the active code path.

### Key Source Files

**Agent:**
- `agent/src/index.ts` — Main entry: LiveKit room events, session creation (`createDirectSession`/`createRealtimeSession`), all DataReceived handlers, HTTP API server (port 8741). Five-tier intelligence routing: `read_spec` (instant), `ask_haiku` (~2s fast brain), `generate_document` (~3s visual docs), `ask_agent` (deep research). Post-research JSONL refinement via `updateSpecFromJSONL()`. Proactive conversational loop during research (15s interval, 4-prompt cap). Research updates contextualized through fast brain before voice relay.
- `agent/src/claude-llm.ts` — `ClaudeLLM` class extending `llm.LLM`: wraps Claude Agent SDK `query()`, session resume, MCP servers, checkpoints, permission flow, configurable model (default Sonnet), auto-approve workspace writes in `canUseTool`. Research system prompt imported from `prompts.ts`
- `agent/src/fast-brain.ts` — Fast intermediary brain (~2s responses): `askHaiku()` for session-aware Q&A, `updateSpecFromJSONL()` for post-research spec consolidation via JSONL, `contextualizeResearchUpdate()` for natural voice progress updates, `generateProactivePrompt()` for conversation during research silence, `generateVisualDocument()` for structured markdown docs (Mermaid diagrams, comparison tables, analysis). Auth chain: `ANTHROPIC_API_KEY` → `ANTHROPIC_AUTH_TOKEN` → Gemini Flash fallback. 10 tools: `read_file`, `write_file`, `list_library`, `read_agent_results`, `read_agent_text`, `web_search`, `read_subagents`, `search_jsonl`, `read_conversation`, `get_full_transcript`
- `agent/src/session-access.ts` — Programmatic access to Claude Agent SDK JSONL session files. 15 exported functions: `readSessionHistory()`, `getRecentToolResults()`, `getSubagentTranscripts()`, `getSessionTranscripts()`, `searchSessionJsonl()`, `getConversationText()`, `watchSessionFile()`, `getRawSessionJsonl()`, etc. Reads FULL untruncated tool results and agent reasoning from `~/.claude/projects/`
- `agent/src/prompts.ts` — Centralized prompt definitions. All system prompts extracted here: `DIRECT_MODE_PROMPT`, `getRealtimeInstructions()`, `getResearchSystemPrompt()`, `FAST_BRAIN_SYSTEM_PROMPT`, `CHUNK_PROCESS_SYSTEM`, `REFINEMENT_PROCESS_SYSTEM`, `AUGMENT_RESULT_SYSTEM`, `CONTEXTUALIZE_UPDATE_SYSTEM`, `PROACTIVE_PROMPT_SYSTEM`, `VISUAL_DOCUMENT_SYSTEM`, `getResearchCompleteInjection()`, `getResearchUpdateInjection()`, `getNotificationInjection()`
- `agent/src/config.ts` — `OsbornConfig` loading from `~/.osborn/config.yaml`, session management (list/get/history), session workspace helpers (`getSessionWorkspace`, `ensureSessionWorkspace`, `readSessionSpec`, `listLibraryFiles`), `listWorkspaceArtifacts()` for file explorer persistence, MCP catalog with Smithery cloud support
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
- **Agent → Frontend** (`topic: 'osborn-updates'`): `tool_use`, `tool_result`, `tool_blocked`, `agent_state`, `agent_ready`, `permission_request`, `claude_output`, `assistant_response`, `task_completed`, `plan_file_updated`, `research_artifact_updated`, `session_resume_set`, `session_artifacts`, `mcp_toggle_result`, `mcp_servers_changed`, `mcp_status`, `checkpoint_captured`, `session_switched`, `current_session`
- **Frontend → Agent** (`topic: 'user-input'`): `permission_response`, `user_text`, `resume_session`, `continue_session`, `switch_session`, `mcp_toggle`, `get_mcp_status`, `session_selected`, `get_plan_file`, `get_research_artifact`, `get_session_artifacts`, `get_current_session`

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
- **Workspace path fallback**: `sessionId` for workspace path uses `this.#sessionId || this.#opts.resumeSessionId || null`. When null (first query of new session), workspace instructions are omitted from the system prompt. Workspace is created when the SDK emits the real `session_id`. For resumed sessions, workspace is eagerly created since the real ID is already known.
- **Workspace write auto-approval**: The `canUseTool` callback auto-approves `Write`/`Edit` calls when the file path is within `.osborn/sessions/` or `.osborn/research/`. This prevents the SDK permission prompt from blocking workspace writes. The `PreToolUse` hook remains as a safety net to block writes outside the workspace. The system prompt has strict rules: always use full absolute workspace path, never hallucinate paths, never claim a write without actually calling Write/Edit.
- **Configurable model**: `ClaudeLLMOptions.model` defaults to `claude-sonnet-4-6`. Passed to both the `model` getter and SDK `Options.model`. Haiku was tested but hallucinated file structures; Sonnet is the safe default.
- **Unified voice injection queue**: ALL system injections (research updates, completions, notifications, errors) go through `voiceQueue[]` + `queueVoiceInjection()` + `processVoiceQueue()`. Never call `generateReply` directly for injections. The queue only processes when `agentState === 'listening'`. Multiple items are batched into one `generateReply({ instructions, toolChoice: 'none' })` call. The `agent_state_changed` → `listening` event triggers `processVoiceQueue()` again after the model finishes speaking.
- **Voice announcements in realtime mode**: Use `queueVoiceInjection()` (which gates on model availability) not `session.generateReply()` directly, and not `session.say()` (no standalone TTS in realtime). Use `[NOTIFICATION]` prefix + "Do NOT call any tools" to prevent feedback loops.
- **Feedback loop prevention**: Never pass system messages through `generateReply({ userInput })` in realtime — Gemini/OpenAI treats them as new user requests. Use dedup guard (`lastTaskRequest`/`lastTaskTime` with 10s window).
- **ReactMarkdown**: Must receive content as children (`<ReactMarkdown>{content}</ReactMarkdown>`), not self-closing.
- **extractTextContent()**: Use this helper (in `config.ts`) when reading conversation history to avoid dumping raw tool_use/tool_result JSON.
- **PostToolUse must emit `input`**: The `PostToolUse` hook emits `tool_result` events with `{ name, input: input?.tool_input || {} }`. The `input` field is required — `index.ts` checks `data.input?.file_path` to detect session workspace writes (both `.osborn/sessions/` and `.osborn/research/`).
- **Non-blocking `ask_agent`**: The `ask_agent` tool returns immediately ("Research started...") and runs Claude research in the background via `executeResearch()` (extracted function). Progress updates are queued in `activeResearch.pendingUpdates`, debounced by `scheduleResearchBatch()` (8s), and pushed to the unified `voiceQueue`. Final results are pushed via `queueVoiceInjection('[RESEARCH COMPLETE] ...')`. The Claude SDK has an internal queue — when `query()` is called while another is running, it enqueues with `queue-operation` events and waits. Each `query()` produces assistant messages with distinct `requestId` values in the JSONL. The SDK auto-resumes via `sessionId` — follow-up tasks inherit all prior research context. **IMPORTANT**: Do NOT abort old research when new research starts — let the SDK queue handle it. Old research completes naturally, results land in JSONL, fast brain can read them. Only abort on disconnect/cleanup.
- **JSONL research tracking**: Each `query()` call produces messages with unique `requestId` values. User text messages establish conversation branches via `parentUuid` chains. `queue-operation` events (`enqueue`/`dequeue`/`remove`) track the SDK's internal task lifecycle. Sub-agents spawned via `Task` tool get their own `agent-id` in enqueue content. These fields can be used to identify which research task produced which output.
- **Parallel sub-agents**: The research system prompt instructs the Claude agent to use the `Task` tool for parallel work. Multiple Task calls in the same response spawn concurrent sub-agents (e.g., researching 3 topics simultaneously). Sub-agents can use Read, Glob, Grep, Bash, WebSearch, WebFetch. This dramatically speeds up research that would otherwise be sequential.
- **Voice queue `isProcessingQueue` guard**: Prevents concurrent `generateReply` calls. Set `true` before calling `generateReply`, cleared on every `agent_state_changed` event. On error, items are dropped (not re-queued) to prevent infinite retry cascades. A 15s safety timeout auto-clears the guard if `agent_state_changed` never fires (e.g. Gemini state machine hang). The queue retry delay after `listening` state is 500ms (not 50ms) to let the model settle.
- **Gemini voice injection — AsyncLocalStorage fix**: The LiveKit SDK's `asyncLocalStorage` (in `agent_activity.ts:970-973`) auto-forces `toolChoice='none'` when `generateReply` is called inside a tool execution context. `setTimeout` callbacks inside `askFastBrainTool.execute()` inherit this context. Gemini ignores `toolChoice:'none'`, calls tools anyway, but the SDK drops the call at `generation.ts:845-853`, leaving Gemini stuck. **Fix**: `processVoiceQueue()` passes `toolChoice: 'auto' as any` explicitly for Gemini, overriding the SDK's auto-`'none'`. The SDK check `if (toolChoice === undefined)` skips because toolChoice is defined. There is no way to break out of an `AsyncLocalStorage` context you don't own — `setTimeout`, `setImmediate`, `process.nextTick`, `Promise.then` all propagate it.
- **Gemini "." phantom input**: When Gemini receives `generateReply({ instructions })`, it sometimes generates a `"."` as a pseudo-user-input and routes it through `ask_fast_brain`. This is NOT a mechanism we built — it's Gemini's own interpretation of system instructions as a user turn. The injection bypass guard in `askFastBrainTool.execute()` handles `[SCRIPT]`/`[PROACTIVE]`/`[NOTIFICATION]` prefixes; `"."` falls through to the fast brain which returns a brief response.
- **Gemini `interrupt()` constraint**: Never call `session.interrupt()` for Gemini provider — it disrupts the internal state machine, causing the model to hang in `speaking` state indefinitely (no transition back to `listening`). All `interrupt()` calls in `processVoiceQueue()` and `user_text` handler must be guarded with `if (currentProvider !== 'gemini')`. Gemini handles interruptions internally via `activityStart`/`activityEnd`.
- **Smithery proxy for cloud MCP**: Claude Agent SDK's `type: 'http'` transport has a bug (#18296) that forces OAuth on all HTTP servers. Smithery servers are connected via in-process proxy (`smithery-proxy.ts`) using `createSmitheryProxy()` which returns `type: 'sdk'` config. The proxy uses `@smithery/api/mcp` `createConnection()` for the working transport. The proxy patches both `McpServer.connect` and `Server._server.connect` to handle reconnection across SDK `query()` calls.
- **Research event batching**: During background `ask_agent` execution, `onToolUse` generates enriched entries with tool parameters (file paths, commands, search queries, hostnames) and pushes to both `researchLog` and `pendingUpdates`. `onToolResult` only pushes to `researchLog` (not `pendingUpdates`) to avoid "Read done" doubling. `scheduleResearchBatch()` debounces (8s), routes batch through `contextualizeResearchUpdate()` (fast brain generates natural 1-2 sentence voice update from raw events), and pushes to `voiceQueue` via `getResearchUpdateInjection()`. Capped at 3 voice updates per task via `voiceUpdateCount`. The update prompt tells the voice model NOT to say "complete" or "done". Final result includes research log + 4000-char findings.
- **Proactive conversational loop**: `startProactiveLoop()` runs a 15-second interval during research that calls `generateProactivePrompt()` (fast brain) to generate things for the voice model to say — open questions from spec, discussion of findings, progress with depth. Capped at 4 prompts per task (`MAX_PROACTIVE_PROMPTS`). Guards: only fires when `agentState === 'listening'`, `userState !== 'speaking'`, no batch timer active, no queue processing. `stopProactiveLoop()` called in all cleanup paths (research completion, error, disconnect, reconnect, recovery).
- **Visual document generation**: `generateVisualDocument()` in fast-brain creates structured markdown documents (comparison tables, Mermaid diagrams, analysis, summaries) from research context. Registered as `generate_document` tool on the realtime model. Reads spec + library + JSONL results, writes to `library/`, notifies frontend via `research_artifact_updated`.
- **SWC parser quirk**: Next.js SWC parser chokes on `> 0` inside template literals in JSX `className`. Use truthy checks (`arr.length` not `arr.length > 0`) in template expressions.
- **`haikuInFlight` guard**: Prevents `ask_agent` from firing when `ask_haiku` is already processing. If the fast brain is already answering, `ask_agent` returns "The fast brain is already handling this." Prevents Gemini from double-calling both tools.
- **`updateSpecFromJSONL()` post-research flow**: After `ask_agent` completes, fires `updateSpecFromJSONL()` as fire-and-forget. Reads FULL untruncated data from Claude JSONL via `getRecentToolResults()` (30 results), `readSessionHistory()` (50 messages), and `getSubagentTranscripts()`. Fast brain consolidates into spec.md + library/. On completion, re-injects updated spec into voice model's ChatCtx and notifies frontend via `research_artifact_updated`.
- **`getSpecForVoiceModel()`**: Reads spec.md and truncates to a budget for injection into the realtime voice model's context. Truncates at section boundaries.
- **`parseChunkResponse()` multi-strategy parser**: Handles LLM output that may contain code blocks, control characters, or raw markdown. Strategies: direct JSON.parse → control char stripping → regex spec extraction → raw markdown detection.
- **Bidirectional question tracking**: spec.md `Open Questions` section has subsections `From User` and `From Agent`. Fast brain tracks which questions are answered and marks them done with checkboxes.

## Prompt System (for performance tracking)

The system has layered prompts at different levels:

| Layer | Location | When | Content |
|---|---|---|---|
| **Realtime voice model** | `prompts.ts` (`getRealtimeInstructions()`) | Realtime sessions | Five-tier intelligence routing (conversational → `read_spec` → `ask_haiku` → `generate_document` → `ask_agent`), anti-hallucination, adaptive verbosity, live research updates, proactive context, notification handling |
| **Direct voice agent** | `prompts.ts` (`DIRECT_MODE_PROMPT`) | Direct sessions | Short: "You are Osborn, a voice AI research assistant..." |
| **Claude SDK research mode** | `prompts.ts` (`getResearchSystemPrompt()`) | Always | Injected via `systemPrompt` field in `claude-llm.ts`: research mode rules, workspace path, write rules. Agent reads spec for context but does NOT write — fast brain handles spec/library |
| **Fast brain** | `prompts.ts` (`FAST_BRAIN_SYSTEM_PROMPT`) | During `ask_haiku` | Session file access, web search, question tracking, JSONL tool access, spec.md update rules |
| **`ask_agent` tool desc** | `index.ts` | Realtime sessions | Full capability list. Non-blocking: returns immediately, injects progress + final results via `generateReply()` |
| **Notifications** | `prompts.ts` (`getNotificationInjection()`) | Any mode | `[NOTIFICATION] {text}. Acknowledge briefly. Do NOT call any tools.` |
| **Research progress** | `prompts.ts` (`getResearchUpdateInjection()`, `getResearchCompleteInjection()`) | During research | `[RESEARCH UPDATE — STILL IN PROGRESS]` batched (8s debounce, max 3) + `[RESEARCH COMPLETE]` with fact-fidelity mandate |
| **Session context** | `buildContextBriefing()` → `generateReply()` | Session resume/switch | `[SESSION RESUMED]` or `[SESSION SWITCHED]` with conversation history summary |
| **Fresh greeting** | `index.ts` | New connections | "The user just connected. Briefly greet them as Osborn..." |

## TypeScript Config Notes
- Agent: `strict: false`, ESM (`module: ESNext`, `moduleResolution: bundler`, `target: ES2022`)
- Frontend: `strict: true`, path alias `@/*` → `./src/*`
- `dotenv/config` must be the first import in `agent/src/index.ts` (env vars needed before other modules load)
