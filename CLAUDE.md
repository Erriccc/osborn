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

Agent needs: `agent/.env` with `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `ANTHROPIC_API_KEY`, and at least one of `OPENAI_API_KEY` / `GOOGLE_API_KEY`. Optional: `SMITHERY_API_KEY` for cloud-hosted MCP servers (YouTube, GitHub via Smithery). Optional: `RECALL_API_KEY` for Zoom/Google Meet bot integration via Recall.ai.

Frontend needs: `frontend/.env.local` with `NEXT_PUBLIC_LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`. For cloud sandbox provisioning (optional): `DAYTONA_API_KEY`, `DAYTONA_API_URL`, `DAYTONA_PROXY_DOMAIN`, `DAYTONA_REGION`, plus the platform infra keys forwarded into sandboxes (`OPENAI_API_KEY`, `GOOGLE_API_KEY`, `DEEPGRAM_API_KEY`, `RECALL_API_KEY`, `SMITHERY_API_KEY`).

## Architecture

```
Frontend (Next.js 14) <-> LiveKit Cloud <-> Agent (Node.js/tsx on local machine)
                                              ├── Claude Agent SDK (coding tools)
                                              ├── OpenAI/Gemini Realtime (voice)
                                              └── MCP Servers (extensions)
```

### Three Voice Modes
- **direct**: STT (Deepgram Flux with semantic turn detection) → Claude Agent SDK → TTS. Full tool access, all research capabilities. `skipTTSQueue: true` bypasses LiveKit's BufferedTokenStream and emits `tts_say` events that route directly to `session.say()`.
- **pipeline** (default): Same as direct, but `ClaudeLLM` is wrapped by `PipelineDirectLLM`. Every user turn fires a parallel Gemini Flash AFC observer (`pipeline-fastbrain.ts`) that searches the JSONL summary index, surfaces results to the frontend panel, and can call an `emergency_stop` tool that aborts and restarts the Claude subprocess with a new prompt. Interruption context (word-accurate spoken text + JSONL replay of recent assistant messages) is enriched into the next user message.
- **realtime**: OpenAI/Gemini native speech-to-speech. The realtime model is a thin **teleprompter** with only **two tools**: `ask_fast_brain` (called for every user message — the fast brain decides everything) and `respond_permission`. Returned scripts are spoken verbatim. Deep research is triggered indirectly when the fast brain returns a `NEEDS_DEEPER_RESEARCH` marker.

### Persistent Session Architecture

The Claude Agent SDK `query()` function accepts `AsyncIterable<SDKUserMessage>` as its prompt. Instead of spawning a fresh subprocess per message (which replays the full JSONL history each time), a single `query()` is created on the first `chat()` call with a `MessageChannel` (pushable async iterable). Subsequent messages are pushed to the channel — the subprocess stays alive, no JSONL replay. This is implemented in `claude-llm.ts`:
- `MessageChannel<T>` class — pushable async iterable feeding the subprocess stdin
- `#persistentQuery: SDKQuery` — singleton query reference, kept alive for the voice session
- `pushMessage()` — first call does cold start (JSONL replay), subsequent calls are instant
- `#startBackgroundConsumer()` — long-running `for await` loop routing SDK events to TTS/frontend
- `closeSession()` — kills subprocess on disconnect/session switch/recovery
- `interruptQuery()` — calls `persistentQuery.interrupt()` (graceful Esc, subprocess stays alive)
- `abortQuery()` → `closeSession()` (kills subprocess, next call cold starts)

### Multi-Agent Orchestration

The main agent (Sonnet) is an orchestrator with three named sub-agents defined in the `agents` config in `claude-llm.ts`:
- **researcher** (Sonnet) — information gathering: codebase, web, multi-file reads. Tools: Read, Glob, Grep, Bash, WebSearch, WebFetch, Task. Does NOT edit files.
- **reasoner** (Opus) — deep thinking: architecture decisions, tradeoffs, implementation planning. Read-only tools. Returns plans for the writer.
- **writer** (Sonnet) — execution with verify-first workflow: check assumptions → clarify unknowns → execute → verify (run tests/build). Tools: Read, Write, Edit, MultiEdit, Bash, Glob, Grep. Only agent with write access outside workspace.

The `PreToolUse` hook checks `input.agent_type` — the writer agent (`agent_type === 'writer'`) gets full write access everywhere. All other agents are restricted to workspace-only writes. The prompt enforces a hard limit of 2-3 direct tool calls per turn for the main agent; anything more must be delegated.

### Research Mode

The agent operates in a single **research** mode. It can read any file, search the web, run commands, fetch YouTube transcripts, and save findings to a per-session workspace. There are no plan/execute or read-only/edit mode toggles.

**Write safety**: A `PreToolUse` hook in `claude-llm.ts` blocks `Write`/`Edit`/`MultiEdit` outside the session workspace (`/osb/` path or legacy `.osborn/sessions/`), UNLESS the calling agent is the `writer` sub-agent (`agent_type === 'writer'`). The `canUseTool` callback auto-approves writes to the session workspace (no permission prompt), while all other tools use `permissionMode: 'default'`. The system prompt has strict file writing rules (full absolute paths, no hallucinated writes).

**Session workspace** — co-located with Claude's native JSONL files:
```
~/.claude/projects/{slug}/osb/<session-uuid>/
  spec.md        # Portable research output: goal, user context, open questions (bidirectional), decisions, findings, plan
  search-index.txt       # Compact summary index for fast search
  search-index-meta.json # Index metadata (byte offsets, timestamps)
```

The fast brain (`fast-brain.ts`) maintains `spec.md` — reading FULL untruncated data from Claude's JSONL session files via `session-access.ts` after research completes. The research agent focuses on thorough investigation; the fast brain consolidates findings into spec.md.

**System prompt**: Defined in `prompts.ts` via `getResearchSystemPrompt()`, injected via `systemPrompt` field in `claude-llm.ts`. The research agent reads `spec.md` for context but does NOT write to it — the fast brain handles all spec writes via `updateSpecFromJSONL()`.

**Legacy types**: `EditMode` and `AgentMode` are still exported from `config.ts` for backward compatibility with old `.session-meta.json` files, but are not used in the active code path.

### Key Source Files

**Agent:**
- `agent/src/index.ts` — Main entry (~3000 lines): LiveKit room events, session creation (`createDirectSession`/`createRealtimeSession`), HTTP API server (port 8741, configurable via `OSBORN_API_PORT`, auto-bumps on EADDRINUSE), self-healing CWD fallback chain (`OSBORN_CWD` → `config.workingDirectory` → `process.cwd()`, each verified with `existsSync`), `killCurrentLLM()` helper that calls `abortQuery()` / `abortAgent()` to kill the persistent Claude subprocess on disconnect (the JS-reference null alone left the SDK draining MessageChannel into a dead session). Realtime mode wires only **two tools** on the agent: `ask_fast_brain` and `respond_permission` — all routing happens inside the fast brain. Background research via `executeResearch()`, debounced 8s research batch via `scheduleResearchBatch()`, post-research consolidation via `updateSpecFromJSONL()`, proactive conversational loop (15s, capped 4 prompts).
- `agent/src/claude-llm.ts` — `ClaudeLLM` extends `llm.LLM` (~1300 lines). Persistent session: `MessageChannel<SDKUserMessage>` (pushable async iterable), `#persistentQuery: SDKQuery` singleton, `#startBackgroundConsumer()` long-running `for await` loop routing SDK events to TTS/frontend, `pushMessage()` for cold-start vs fast-path push, `closeSession()` to kill the subprocess. Three named sub-agents (`researcher` Sonnet / `reasoner` Opus / `writer` Sonnet, each with explicit tool lists and detailed prompts). `PreToolUse` hook is `agent_type`-aware: writer agent defers to `canUseTool` for permission dialog (`permissionDecision: 'ask'`); all other agents are restricted to workspace paths (`/osb/`, `.osborn/sessions/`, `.osborn/research/`). `canUseTool` auto-approves workspace writes EXCEPT `spec.md` (deny — fast brain manages it), auto-approves writer writes to `.claude/skills/<name>/` (so multi-file skill installs don't cascade permission prompts), auto-approves `AskUserQuestion`, auto-denies `EnterPlanMode`/`ExitPlanMode`. Loads `.claude/skills/*/SKILL.md` files into the system prompt as `<available-skills>`. `interruptQuery()` / `abortQuery()` / `rewindToCheckpoint()` exposed for fast brain agent control. `#activeQueries: Set` tracks both persistent and one-shot queries.
- `agent/src/fast-brain.ts` — Central orchestrator (~2200 lines). `askFastBrain()` is the single gateway — the realtime voice model calls `ask_fast_brain` for every user turn, fast brain decides whether to answer directly (`type: 'answer'`), trigger background research (`NEEDS_DEEPER_RESEARCH` → `triggerResearch` callback), record decisions (`RECORDED:`), or ask the user a clarifying question (`ASK_USER:`). Provider chain: PRIMARY = Gemini Flash (~1-2s, 1M token context, no cold start) via `@google/genai`; FALLBACK = direct Anthropic API (Haiku) via `@anthropic-ai/sdk`; LAST RESORT = Agent SDK (Haiku) for tool-loop cases. **12 fast brain tools**: `read_file`, `write_file`, `read_agent_results` (last 40 tool results), `read_agent_text` (last 60 assistant messages), `read_subagents`, `search_jsonl`, `read_conversation`, `get_full_transcript`, `get_session_stats`, `deep_read_results` (FULL session, optional toolFilter), `deep_read_text` (FULL session reasoning), `send_to_chat` (push markdown to frontend chat panel), plus Gemini-only `web_search`. `processResearchChunk()` / `updateSpecFromJSONL()` post-research spec consolidation reading FULL untruncated JSONL via `session-access.ts`. `generateVisualDocument()` for Mermaid/comparison/analysis docs. `prepareBriefingScript()` / `prepareRecoveryScript()` build voice resume/recovery briefings.
- `agent/src/session-access.ts` — Programmatic JSONL session access (~1000 lines, 25+ exported functions): `readSessionHistory()`, `getRecentToolResults()`, `getSubagentTranscripts()`, `getSessionTranscripts()`, `searchSessionJsonl()`, `getConversationText()`, `watchSessionFile()`, `getRawSessionJsonl()`, `getSessionStats()`, `getSessionPlan()`, `getSessionTodos()`, `getSessionSummary()`, `projectPathToSlug()`, `getSessionPaths()`, `getSessionSubAgents()`. Honors `CLAUDE_CONFIG_DIR` env var. Reads FULL untruncated tool results and agent reasoning from `~/.claude/projects/{slug}/`.
- `agent/src/jsonl-search.ts` — Two search strategies over session JSONL. `ripgrepSearch()` shells out to the bundled `@vscode/ripgrep` binary (with `grep` fallback) — validates patterns against shell-injection chars, optional `fromEnd: true` for "most recent matches" mode. `bm25Search()` builds an in-memory `minisearch` index from `readSessionHistory({ lastN: 500 })`, cached per `sessionId`, invalidated via `invalidateBM25Cache()`. `resolveJsonlDir()` mirrors `session-access.ts` slug logic.
- `agent/src/summary-index.ts` — Compact line-oriented searchable index over JSONL session files (~700 lines). `buildSummaryIndex()` walks JSONL, extracts a one-line summary per entry with the byte offset back into the source, writes to `~/.claude/projects/{slug}/osb/{sessionId}/search-index.txt`. `startIndexWatcher()` tails the JSONL and incrementally appends. `readFullContent()` uses the byte offset to fetch the full original entry without re-parsing the file. Used by `pipeline-fastbrain.ts`.
- `agent/src/prompts.ts` — Centralized prompt definitions (~2100 lines, 15+ exports). System prompts: `DIRECT_MODE_PROMPT`, `getRealtimeInstructions()`, `getDirectModeResearchPrompt()`, `getResearchSystemPrompt()`, `FAST_BRAIN_SYSTEM_PROMPT`, `CHUNK_PROCESS_SYSTEM`, `REFINEMENT_PROCESS_SYSTEM`, `AUGMENT_RESULT_SYSTEM`, `CONTEXTUALIZE_UPDATE_SYSTEM`, `PROACTIVE_PROMPT_SYSTEM`, `VISUAL_DOCUMENT_SYSTEM`, `RESEARCH_COMPLETION_SYSTEM`. Voice injection helpers: `getScriptInjection()`, `getProactiveInjection()`, `getNotificationInjection()`, `getResearchCompleteInjection()`, `getResearchUpdateInjection()`. Builders: `buildFastBrainSdkPrompt()`, `buildGeminiContextPrompt()`. Note: legacy `prompts-2-25-26.ts` and `prompts-3-2-26.ts` are kept on disk as historical snapshots — only `prompts.ts` is imported by the active code.
- `agent/src/config.ts` — `OsbornConfig` loading from `~/.osborn/config.yaml` (~1300 lines). `VoiceMode = 'direct' | 'realtime' | 'pipeline'`. Session management: `listSessions()`, `listAllClaudeSessions()` (scans every `~/.claude/projects/*/` folder), `getMostRecentSessionId()`, `sessionExists()`, `getSessionSummary()`, `getConversationHistory()`. Workspace helpers: `getSessionWorkspace()`, `ensureSessionWorkspace()`, `readSessionSpec()`, `listWorkspaceArtifacts()`. `MCP_CATALOG` with Smithery cloud entries, `buildMcpServersForKeys()`, `getMcpServerStatusList()`, `getMcpToolPatterns()`. `extractTextContent()` strips raw `tool_use`/`tool_result` JSON from history reads.
- `agent/src/smithery-proxy.ts` — In-process MCP proxy for Smithery cloud servers. Bypasses Claude Agent SDK HTTP bug (#18296) by using `@smithery/api/mcp` `createConnection()` + MCP SDK `Client` to get a working transport, then wraps in a local `McpServer` returned as `{ type: 'sdk', name, instance }`. Patches both `McpServer.connect` and `Server._server.connect` to handle reconnection across SDK `query()` calls.
- `agent/src/recall-client.ts` — Recall.ai API wrapper for meeting bot integration. `RecallClient` class: `joinMeeting()`, `leaveMeeting()`, `handleWebhook()`, `registerBot()`. Singleton via `getRecallClient()` (returns null if `RECALL_API_KEY` not set). Meeting transcripts surface as `transcript` events that `index.ts` routes into `currentLLM.chat()` as `[Meeting — Speaker]: text`.
- `agent/src/pipeline-direct-llm.ts` — `PipelineDirectLLM` wraps `ClaudeLLM`. Proxies all properties/methods. On every `chat()` call: extracts user text, consumes pending interruption context (`[INTERRUPTED]` enriched message with spoken text + last 10 assistant messages from JSONL), fires `firePipelineFastBrain()` in background. Builds + watches the summary index lazily on first question. Exposes `interruptAgent()`, `abortAgent()`, `rewindAgent()`, `sendPrompt()` for fast brain agent control.
- `agent/src/pipeline-fastbrain.ts` — Pipeline fast brain: Gemini Flash AFC (Automatic Function Calling) agent. **3 tools**: `search_session` (ripgrep over the summary index, then byte-offset reads of full content), `get_recent` (most recent session activity), `emergency_stop` (kills + restarts the main Claude agent with an `[EMERGENCY STOP]` prompt that includes the user's recent messages and recent activity). One `generateContent` call handles the whole loop via AFC, capped at 4 calls.
- `agent/src/claude-auth.ts` — Claude Code OAuth flow for headless/cloud environments. Auth priority: `CLAUDE_CODE_OAUTH_TOKEN` env → `~/.claude/.credentials.json` → `claude auth status --json` CLI check → interactive `claude setup-token` via `node-pty`. `resolveClaudePath()` walks shell `which`, common paths (homebrew/nvm/Linux), and `npm bin -g`. The pty's auth URL output is captured and surfaced via callback so the frontend can show it; the user pastes the code back, fast brain forwards via callback.
- `agent/src/voice-io.ts` — Factory functions for STT (Deepgram Flux with semantic turn detection), TTS (Deepgram/OpenAI/ElevenLabs/Gemini), VAD (Silero), and realtime model creation (`createRealtimeModelFromConfig()`).
- `agent/src/turn-detector-shim.ts` — `CloudTurnDetector` implements LiveKit's `_TurnDetector` interface without requiring `JobContext` / worker framework. Calls `LIVEKIT_REMOTE_EOT_URL` directly via `fetch` for end-of-turn probability. Falls back to `1.0` (always end of turn) when the env var is unset, letting STT endpointing handle turn detection.
- `agent/src/status-manager.ts` — `StatusManager` (singleton `statusManager`) tracks background `TaskStatus` records (`pending`/`running`/`completed`/`failed`). Used for reporting interim progress to the voice model. `getLatestProgressUpdate()` returns + clears the latest unspoken update, `getStatusUpdate()` returns a natural-language summary, `clearReportedTasks()` GCs completed tasks older than 2 minutes.
- `agent/src/codex-llm.ts` / `agent/src/codex-handler.ts` — Optional alternative LLM wrapper for the OpenAI Codex SDK (`@openai/codex-sdk`). `CodexLLM` extends `llm.LLM`, persists a single Codex `Thread` across user turns. Currently not wired into the default voice flow but available for swapping in.
- `agent/src/bridge-llm.ts` — `createBridgeLLM()` factory that returns a Gemini or GPT-4o LiveKit LLM instance for "bridge LLM" voice setups (a conversation manager LLM separate from Claude). Exists for future pipelined voice configurations; not used by the default flow.
- `agent/src/claude-handler.ts` — Standalone `ClaudeHandler` class wrapping the Agent SDK with permission interception. Predates the persistent-session `ClaudeLLM`; kept around but not used by the default voice flow.
- `agent/src/meeting-output.html` — Output Media webpage for Recall.ai bot audio (WebSocket client served at `GET /meeting-output`).

**Frontend:**
- `frontend/src/components/VoiceRoom.tsx` — Main UI component (~2000 lines): voice visualization, chat (with `MessageContent` for inline images and download cards), permission UI, session management, MCP toggles, always-visible files panel with session artifact persistence, Claude OAuth modal, meeting join controls.
- `frontend/src/components/MarkdownMessage.tsx` — Markdown renderer with syntax highlighting (highlight.js + rehype). `CodeBlock` accepts `React.ReactNode` children (not `String()`) to preserve rehype-highlight spans. `extractText()` walks React tree for copy button. Exports `MermaidBlock` for inline mermaid diagrams.
- `frontend/src/components/SessionBrowser.tsx` — Past session browser, scans across all Claude projects.
- `frontend/src/components/FilesExplorerModal.tsx` — Full-screen files explorer modal with type badges, copy/copy-all, and inline rendering of plans/diagrams/notes/HTML.
- `frontend/src/components/LogsDrawer.tsx` — Bottom drawer for debug message log (user/assistant/system) with unread badge.
- `frontend/src/components/SetupWizard.tsx` — 6-step env setup wizard for first-time local users (LiveKit + Anthropic + voice provider keys), generates `agent/.env` and `frontend/.env.local` content.
- `frontend/src/lib/setup.ts` — Pure setup utilities: `EnvConfig`, `generateAgentEnv()`, `generateFrontendEnv()`, `validateLivekitUrl()`, `validateAnthropicKey()`, `checkAgentHealth()`. Used by `SetupWizard`.
- `frontend/src/lib/sessions.ts` — Client-safe session helpers (no Node imports). `formatTime()` for relative timestamps; `SessionInfo` interface.
- `frontend/src/lib/daytona.ts` — Server-only sandbox provisioning (see "Cloud Sandboxes" section).
- `frontend/src/lib/supabase.ts` / `supabase-browser.ts` / `supabase-server.ts` — Supabase client factories for browser, server, and middleware contexts.
- `frontend/src/app/api/token/route.ts` — LiveKit JWT token generation with metadata (provider, voiceArch, sessionId, workingDirectory).
- `frontend/src/app/api/instance/route.ts` — User instance CRUD (Supabase-backed).
- `frontend/src/app/api/sandbox/route.ts` — Daytona sandbox CRUD + keepalive PATCH.
- `frontend/src/app/page.tsx` — Landing page: Google/GitHub OAuth + guest connect.
- `frontend/src/app/dashboard/page.tsx` — Dashboard: recent chats, settings (`connectionMode` local/cloud), agent health, profile.
- `frontend/src/app/chat/page.tsx` — Voice chat wrapper that auto-resolves the agent URL (cloud sandbox or local) and mounts `VoiceRoom`.
- `frontend/src/middleware.ts` — Supabase auth session middleware.

### Data Channel Protocol

Frontend ↔ Agent communication uses LiveKit data channels:
- **Agent → Frontend** (`topic: 'osborn-updates'`): `tool_use`, `tool_result`, `tool_blocked`, `agent_state`, `agent_ready`, `permission_request`, `claude_output`, `assistant_response`, `user_transcript`, `task_completed`, `plan_file_updated`, `plan_file_content`, `research_artifact_updated`, `research_artifact_content`, `research_task_started`, `session_resume_set`, `session_resume_failed`, `session_artifacts`, `mcp_toggle_result`, `mcp_servers_changed`, `mcp_status`, `checkpoint_captured`, `session_switched`, `current_session`, `fast_brain_response`, `meeting_joining`, `meeting_joined`, `meeting_left`, `meeting_error`, `claude_auth_url`, `claude_auth_success`, `claude_auth_error`, `skills_status`, `skill_add_result`
- **Frontend → Agent** (`topic: 'user-input'`): `permission_response`, `user_text`, `resume_session`, `continue_session`, `switch_session`, `mcp_toggle`, `get_mcp_status`, `session_selected`, `get_plan_file`, `get_research_artifact`, `get_session_artifacts`, `get_current_session`, `join_meeting`, `leave_meeting`, `claude_auth_code`, `get_skills`, `skill_add`

### Authentication & Multi-User
- **Supabase Auth**: Google + GitHub OAuth via `@supabase/ssr`. Callback at `/auth/callback`.
- **Database**: Supabase Postgres with RLS. Tables: `instances` (user→server URL), `agent_sessions`, `always_allow_paths`.
- **Instance API**: `GET/POST /api/instance` — stores user's agent server URL + LiveKit room name.
- **File uploads**: Supabase Storage bucket `osborn-storage`. Images/files uploaded → public URL sent via data channel.

### Cloud Sandboxes (Self-Hosted Daytona)

Each user can be provisioned an isolated Linux sandbox running their own osborn agent + Claude Code CLI, instead of running the agent locally. Provisioning is handled by `frontend/src/lib/daytona.ts` against a self-hosted Daytona instance at `daytona.voice-native.com` (Hostinger VPS, Caddy + Let's Encrypt). Full deployment notes are in `DAYTONA-SETUP.md`.

**Key files:**
- `frontend/src/lib/daytona.ts` — Server-only sandbox library. Raw HTTP (the `@daytonaio/sdk` is buggy with self-hosted). Functions: `createSandbox`, `findUserSandbox`, `startSandbox`, `stopSandbox`, `keepAliveSandbox`, `deleteSandbox`. `getPlatformEnvVars()` injects platform infra keys (LiveKit, Deepgram, OpenAI, Google, Recall, Smithery) — NOT user auth
- `frontend/src/app/api/sandbox/route.ts` — Next.js endpoint for sandbox CRUD. Backed by Supabase auth — each user gets exactly one sandbox labeled `{ userId, app: 'osborn' }`
- `frontend/supabase/migrations/002_sandbox_support.sql` — Adds `sandbox_id` + `sandbox_url` columns to `instances` table

**Provisioning steps in `createSandbox()`:**
1. `POST /api/sandbox` with `image: 'node:22'`, `env`, `target: 'us'`, `labels`, **`autoStopInterval: 0`** (auto-stop disabled — see "disk-fill bug" below), `autoArchiveInterval: 10080`
2. Poll `GET /api/sandbox/{id}` until `state === 'started'` (~10–25s)
3. **`waitForToolboxReady()`**: Poll `echo ready` via toolbox `process/execute` until it succeeds. Daytona flips `state` to `started` ~3-6s before its toolbox reverse-proxy can resolve the container IP; without this poll the next exec call gets `400 failed to resolve container IP`, the install/start step silently fails, the API returns 500, the dashboard ignores it, and the user is left with a "running" sandbox that has nothing on port 8741 (reproduces as 502 Bad Gateway in chat after Resume).
4. `sudo env PATH=/usr/local/nvm/versions/node/v22.14.0/bin:$PATH npm install -g osborn@latest @anthropic-ai/claude-code` (~60s)
5. **Symlink step**: `sudo ln -sf /usr/local/nvm/.../bin/{node,osborn,claude} /usr/local/bin/` so they're in every user's default PATH (including root's, including any spawn lookup)
6. `mkdir -p /home/daytona/workspace && cd /home/daytona/workspace && sudo -E setsid nohup env HOME=/home/daytona OSBORN_CWD=/home/daytona/workspace PATH=... osborn >> /tmp/osborn.log 2>&1 </dev/null & disown` — `OSBORN_CWD` is forced inline (not just from sandbox env) to defeat any stale value baked into older sandboxes' persisted env field
7. Poll `curl http://localhost:8741/health` until 200 (up to 60s)
8. Return `{ id, status: 'running', previewUrl: 'https://8741-{id}.daytona.voice-native.com' }`

**`autoStopInterval: 0` — disk-fill bug:** Self-hosted Daytona has a chronic backup-system bug. Every auto-stop fires a `CREATE_BACKUP` job that races a `STOP_SANDBOX` job; the stop wins (millisecond commit vs second commit), leaving the backup `context canceled`. The few backups that DO win are accumulated forever — `backup.manager.ts` has 4 cron jobs that CREATE backups but ZERO that delete them, and `deleteBackupImageFromRegistry()` (`docker-registry.service.ts:710`) is dead code with no callers. Hit 100/100 GB on Hostinger after one day of debug; recovery required SSH + manual `docker image prune` + registry GC. Defense in depth: (1) `autoStopInterval: 0` here so backup cycles only fire on explicit stops; (2) `/etc/cron.daily/daytona-backup-prune` on the VPS keeps the latest 2 backups per sandbox. **Trade-off**: sandboxes stay running until explicitly stopped — fine on a single-tenant VPS where compute is already paid for, but re-enable auto-stop only AFTER patching `backup.manager.ts` if scaling to many users.

**Background process detachment — DO NOT use `bash -c 'while true; do osborn; done'` supervisor wrappers.** Even though that looks cleaner than letting osborn self-exit, it has a fatal bug: the bash outer process inherits the toolbox `process/execute` stdout/stderr pipe and never closes it. The toolbox endpoint waits indefinitely for the pipe to close before returning, the Next.js fetch hangs for the full undici 5-minute headers timeout (`UND_ERR_HEADERS_TIMEOUT`), and `startSandbox()` returns null with a misleading "fetch failed" message. Symptom is identical to the toolbox-race bug: Resume click hangs forever, dashboard shows "running", chat connect 502s. When `osborn` is the immediate child of `nohup`, Node closes the inherited stdio fds during its own logging setup, the toolbox sees the close, and exec returns in ~2s. Trade-off: no auto-restart on osborn's self-exit path — but that self-exit is a separate bug that should be fixed in osborn (don't `process.exit(0)` when no process manager exists), not papered over with a wrapper that breaks startup.

**Critical sandbox patterns:**
- **`OSBORN_CWD` MUST match the directory we create + cd into.** Earlier bug: env var was set to `/root/workspace` (which doesn't exist and is unreadable to non-root), so when osborn passed it as `cwd` to the SDK's `child_process.spawn`, spawn errored ENOENT and the SDK reported the misleading `Claude Code executable not found at .../cli.js`. Fix: `OSBORN_CWD=/home/daytona/workspace` to match the `mkdir -p /home/daytona/workspace && cd /home/daytona/workspace` in the start command.
- **osborn runs as root via `sudo -E`** — running as the `daytona` user hit EACCES on subprocess spawning. `-E` preserves env vars from the sandbox `env` field. `HOME=/home/daytona` is forced so OAuth credentials persist in the same place across user/root contexts.
- **`sudo` strips PATH** — every install/start command must explicitly preserve PATH via `sudo env PATH=/usr/local/nvm/versions/node/v22.14.0/bin:$PATH ...`. nvm's bin dir isn't in root's default PATH.
- **Background process detachment** — `nohup ... &` alone doesn't survive the toolbox `executeCommand` returning. Need `setsid` (detach from controlling terminal) AND `disown` (detach from parent shell).
- **Per-user Claude OAuth** — first user message in a fresh sandbox triggers `claude setup-token` via pty inside the sandbox. The OAuth URL surfaces via the `claude_auth_url` data channel message. User opens it, pastes the code back via the auth modal, token persists at `/home/daytona/.claude/.credentials.json`. Survives `autoStopInterval` (15min idle → stop, fs preserved).
- **`/api/sandbox` PATCH (keepalive)** — chat page pings every 5min while connected to reset Daytona's idle timer. Auto-disconnects after 20min of no user activity (mouse/key/click events).

**`@daytonaio/sdk` workarounds (raw HTTP only):**
| Bug | Workaround |
|---|---|
| `daytona.list/create/get` throw on undefined fields | Use raw `fetch` against `/api/sandbox` |
| SDK uses `envVars`/`region`, API expects **`env`/`target`** | Use API field names directly |
| Toolbox URL: `:4000` cloud vs `/toolbox` path self-hosted (HTTPS via Caddy) | `getToolboxBase()` detects protocol |
| `list()` returns `[]` self-hosted, `{items: []}` cloud | `data.items \|\| data` |

### Local vs Cloud Mode

`frontend/src/app/dashboard/page.tsx` settings panel writes `localStorage['osborn-connection-mode']` (`'local'` or `'cloud'`). The chat page reads this on mount:
- **`'local'`** (default) — uses `agentUrl` from query param / localStorage as-is (typically `http://localhost:8741`)
- **`'cloud'`** — calls `/api/sandbox` to find/start the user's sandbox, sets `agentUrl` to its `previewUrl`. Auto-starts a stopped sandbox if needed

The local-mode branch must NOT touch `/api/sandbox` — earlier bug had it unconditionally fetching the sandbox, so local mode would hijack the user's connection to the cloud sandbox if one existed.

### Frontend Routes
- `/` — Landing/login (Google/GitHub OAuth + guest connect). Authenticated users redirect to `/dashboard`.
- `/dashboard` — Recent conversations, agent health, settings, user profile. Click chat → `/chat`.
- `/chat` — Auto-connects to agent, wraps VoiceRoom. Disconnect → back to `/dashboard`.
- `/auth/callback` — Supabase OAuth code exchange.
- `/api/token` — LiveKit JWT token generation.
- `/api/instance` — User instance CRUD.

### File Attachment Flow
- Frontend: user attaches file → uploads to Supabase Storage → gets public URL
- Data channel: sends `{ type: 'user_text', content: 'text', files: [{ name, type, url }] }`
- Agent `user_text` handler: builds `fullContent` appending `[Image: name](url)` or `[File: name]\ncontent`
- Frontend rendering: `MessageContent` component renders images as `<img>`, files as download cards

### Session & File Storage
- Sessions: `~/.claude/projects/<slug>/` as `.jsonl` files (Claude's native storage)
- Session workspace: `~/.claude/projects/<slug>/osb/<session-uuid>/` (spec.md + search index)
- Session scanner: `listAllClaudeSessions()` scans ALL project folders, returns sessions sorted by mtime
- Legacy: `.osborn/sessions/` and `.osborn/research/` paths still accepted by write hooks for backward compat
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

- **Self-healing CWD fallback chain**: `index.ts main()` walks `[OSBORN_CWD env, config.workingDirectory, process.cwd()]` and picks the FIRST entry whose path actually exists on disk. Blindly trusting any of these has bitten us — e.g. cloud sandboxes had `OSBORN_CWD=/root/workspace` baked in but `/root` is `drwx------` and the dir doesn't exist, so the SDK's `child_process.spawn(node, [cli.js], { cwd })` errored ENOENT and reported the misleading "Claude Code executable not found at .../cli.js". `process.cwd()` is the ultimate safety net — it exists by definition.
- **`killCurrentLLM(reason)` MUST be called before nulling `currentLLM`**: The persistent ClaudeLLM session is deliberately kept alive across user messages to avoid JSONL replay. When the participant disconnects, simply nulling the JS reference does NOT kill the underlying Claude Code subprocess — the SDK keeps draining `MessageChannel`, running tools, capturing checkpoints, and pushing TTS into a now-null voice session. Visible as repeated `⚠️ tts_say fired but currentSession is null — text dropped`. The fix is `killCurrentLLM(reason)`, which duck-types `abortQuery()` (on `ClaudeLLM`) or `abortAgent()` (on `PipelineDirectLLM`) — both call `closeSession()` which kills the subprocess. Required at all three cleanup sites: `Disconnected` event, `previous_session_cleanup` (when a new participant joins while an old one is still around), and `participant_disconnected`.
- **opts sync**: When updating ClaudeLLM state (`setResumeSessionId`, `setContinueSession`, `resetForSessionSwitch`), always sync to both the instance field AND `this.#opts` — otherwise `ClaudeLLMStream` won't see the update.
- **Workspace path fallback**: `sessionId` for workspace path uses `this.#sessionId || this.#opts.resumeSessionId || null`. When null (first query of new session), workspace instructions are omitted from the system prompt. Workspace is created when the SDK emits the real `session_id`. For resumed sessions, workspace is eagerly created since the real ID is already known.
- **Workspace write auto-approval**: The `canUseTool` callback auto-approves `Write`/`Edit` calls when the file path contains `/osb/`, `.osborn/sessions/`, or `.osborn/research/`. This prevents the SDK permission prompt from blocking workspace writes. The `PreToolUse` hook remains as a safety net to block writes outside the workspace. The system prompt has strict rules: always use full absolute workspace path, never hallucinate paths, never claim a write without actually calling Write/Edit.
- **Configurable model**: `ClaudeLLMOptions.model` defaults to `claude-sonnet-4-6`. Passed to both the `model` getter and SDK `Options.model`. Haiku was tested but hallucinated file structures; Sonnet is the safe default.
- **Unified voice injection queue**: ALL system injections (research updates, completions, notifications, errors) go through `voiceQueue[]` + `queueVoiceInjection()` + `processVoiceQueue()`. Never call `generateReply` directly for injections. The queue only processes when `agentState === 'listening'`. Multiple items are batched into one `generateReply({ instructions, toolChoice: 'none' })` call. The `agent_state_changed` → `listening` event triggers `processVoiceQueue()` again after the model finishes speaking.
- **Voice announcements in realtime mode**: Use `queueVoiceInjection()` (which gates on model availability) not `session.generateReply()` directly, and not `session.say()` (no standalone TTS in realtime). Use `[NOTIFICATION]` prefix + "Do NOT call any tools" to prevent feedback loops.
- **Feedback loop prevention**: Never pass system messages through `generateReply({ userInput })` in realtime — Gemini/OpenAI treats them as new user requests. Use dedup guard (`lastTaskRequest`/`lastTaskTime` with 10s window).
- **ReactMarkdown**: Must receive content as children (`<ReactMarkdown>{content}</ReactMarkdown>`), not self-closing.
- **extractTextContent()**: Use this helper (in `config.ts`) when reading conversation history to avoid dumping raw tool_use/tool_result JSON.
- **PostToolUse must emit `input`**: The `PostToolUse` hook emits `tool_result` events with `{ name, input: input?.tool_input || {} }`. The `input` field is required — `index.ts` checks `data.input?.file_path` to detect session workspace writes (`/osb/`, `.osborn/sessions/`, or `.osborn/research/`).
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
- **Visual document generation**: `generateVisualDocument()` in fast-brain creates structured markdown documents (comparison tables, Mermaid diagrams, analysis, summaries) from research context. Registered as `generate_document` tool on the realtime model. Reads spec + JSONL results, writes to workspace, notifies frontend via `research_artifact_updated`.
- **SWC parser quirk**: Next.js SWC parser chokes on `> 0` inside template literals in JSX `className`. Use truthy checks (`arr.length` not `arr.length > 0`) in template expressions.
- **`haikuInFlight` guard**: Tracks whether `ask_fast_brain` is in flight. While set, the unified voice queue holds (does not call `generateReply`) — otherwise the fast brain's tool response races our injection and Gemini drops one. The guard clears in both the success and error paths of the tool's `execute()`, after which `processVoiceQueue()` is called with a 500ms delay.
- **Realtime mode has only TWO tools**: `ask_fast_brain` and `respond_permission`. There is no `ask_agent`, `ask_haiku`, `read_spec`, or `generate_document` tool registered on the realtime LLM — all of those routings live INSIDE `askFastBrain()`. The fast brain returns a script string which the model speaks verbatim. If the fast brain decides research is needed, it appends `NEEDS_DEEPER_RESEARCH` markers and the `triggerResearch` callback fires `executeResearch()` in the background; the script the model speaks is a contextual acknowledgment from `generateResearchAck()`.
- **Injection bypass in `ask_fast_brain`**: When Gemini receives a system injection via `generateReply({ instructions })`, it sometimes calls `ask_fast_brain` with the injection content as the "question". The tool's `execute()` matches `[SCRIPT]`, `[PROACTIVE]`, and `[NOTIFICATION]` prefixes and returns the content directly without round-tripping through the fast brain. For OpenAI this is a fallback (it normally speaks instructions directly with `toolChoice: 'none'`); for Gemini this is the intended path.
- **Pipeline `emergency_stop`**: The pipeline fast brain (`pipeline-fastbrain.ts`) has an `emergency_stop` AFC tool that the Gemini observer calls when the user clearly wants to abort a destructive action ("stop", "wait no", "cancel"). It calls `agentControl.abort()` to kill the Claude subprocess, then `agentControl.sendPrompt()` with an `[EMERGENCY STOP]` prompt that includes the user's recent messages and a snapshot of recent activity. **Never trigger for**: research, reading, exploring, searching — only destructive/altering actions. Priority is destructiveness > signal strength.
- **`updateSpecFromJSONL()` post-research flow**: After `ask_agent` completes, fires `updateSpecFromJSONL()` as fire-and-forget. Reads FULL untruncated data from Claude JSONL via `getRecentToolResults()` (30 results), `readSessionHistory()` (50 messages), and `getSubagentTranscripts()`. Fast brain consolidates into spec.md. On completion, notifies frontend via `research_artifact_updated`.
- **`getSpecForVoiceModel()`**: Reads spec.md and truncates to a budget for injection into the realtime voice model's context. Truncates at section boundaries.
- **`parseChunkResponse()` multi-strategy parser**: Handles LLM output that may contain code blocks, control characters, or raw markdown. Strategies: direct JSON.parse → control char stripping → regex spec extraction → raw markdown detection.
- **Bidirectional question tracking**: spec.md `Open Questions` section has subsections `From User` and `From Agent`. Fast brain tracks which questions are answered and marks them done with checkboxes.

## Prompt System (for performance tracking)

The system has layered prompts at different levels — all centralized in `prompts.ts`:

| Layer | Location | When | Content |
|---|---|---|---|
| **Realtime voice model** | `prompts.ts` (`getRealtimeInstructions()`) | Realtime sessions | Teleprompter rules: call `ask_fast_brain` for EVERY user message and speak the returned script verbatim. Anti-hallucination, adaptive verbosity, no gap-filling, speech pacing. |
| **Direct voice agent** | `prompts.ts` (`DIRECT_MODE_PROMPT`) | Direct sessions | Short: "You are Osborn, a voice AI research assistant..." |
| **Direct mode research prompt** | `prompts.ts` (`getDirectModeResearchPrompt(workspacePath)`) | Direct mode `voiceMode === 'direct'` | Speech-optimized rules for the Claude SDK in direct/pipeline mode (no markdown, conversational tone). |
| **Realtime research system prompt** | `prompts.ts` (`getResearchSystemPrompt(workspacePath)`) | Realtime mode | Structured research rules for the Claude SDK in realtime mode (paths, write restrictions, parallel sub-agents via Task). Agent reads `spec.md` but NEVER writes — fast brain owns it. |
| **Fast brain** | `prompts.ts` (`FAST_BRAIN_SYSTEM_PROMPT`) | Inside `askFastBrain()` | Tool catalog, structured response markers (`RECORDED:`, `ASK_USER:`, `NEEDS_DEEPER_RESEARCH`, `PARTIAL:`), question tracking, spec.md update rules, anti-hallucination. |
| **Spec consolidation** | `prompts.ts` (`CHUNK_PROCESS_SYSTEM`, `REFINEMENT_PROCESS_SYSTEM`) | `processResearchChunk()` | JSON-output prompts that update `spec.md` from research content (chunk = mid-research, refinement = post-research). |
| **Result augmentation** | `prompts.ts` (`AUGMENT_RESULT_SYSTEM`) | After research | Adds context to raw findings before voice relay. |
| **Update contextualization** | `prompts.ts` (`CONTEXTUALIZE_UPDATE_SYSTEM`) | `contextualizeResearchUpdate()` | Generates natural 1-2 sentence voice update from raw events; instructed NOT to say "complete" or "done". |
| **Proactive prompts** | `prompts.ts` (`PROACTIVE_PROMPT_SYSTEM`) | `generateProactivePrompt()` | Priority order: ALIGN > NARROW > CONNECT > PROGRESS > NOTHING. 15s loop, 4-prompt cap. |
| **Visual document** | `prompts.ts` (`VISUAL_DOCUMENT_SYSTEM`) | `generateVisualDocument()` | Mermaid diagrams, comparison tables, analysis docs. |
| **Research completion** | `prompts.ts` (`RESEARCH_COMPLETION_SYSTEM`) | Spoken briefing after research | Fact-fidelity mandate, no hallucinated file names. |
| **Pipeline fast brain** | `pipeline-fastbrain.ts` (`buildSystemPrompt`) | Pipeline mode every turn | AFC agent rules for `search_session`, `get_recent`, `emergency_stop`. |
| **Notifications** | `prompts.ts` (`getNotificationInjection()`) | Any mode | `[NOTIFICATION] {text}. Acknowledge briefly. Do NOT call any tools.` |
| **Voice script injections** | `prompts.ts` (`getScriptInjection()`, `getProactiveInjection()`, `getResearchUpdateInjection()`, `getResearchCompleteInjection()`) | Voice queue items | `[SCRIPT]`, `[PROACTIVE]`, `[RESEARCH UPDATE — STILL IN PROGRESS]`, `[RESEARCH COMPLETE]` prefixes with fact-fidelity mandates. |
| **Session context briefings** | `fast-brain.ts` (`prepareBriefingScript`, `prepareRecoveryScript`) | Session resume/recovery | LLM-rewritten briefings matching the user's vocabulary from chatHistory. |

## TypeScript Config Notes
- Agent: `strict: false`, ESM (`module: ESNext`, `moduleResolution: bundler`, `target: ES2022`)
- Frontend: `strict: true`, path alias `@/*` → `./src/*`
- `dotenv/config` must be the first import in `agent/src/index.ts` (env vars needed before other modules load)
