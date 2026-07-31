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
- `agent/src/recall-client.ts` — Recall.ai API wrapper for meeting bot integration. `RecallClient` class: `joinMeeting()` (polling-only architecture as of v0.9.44 — no `output_media`, no `realtime_endpoints`, just `recording_config.transcript.provider.recallai_streaming` so Recall transcribes server-side), `leaveMeeting()`, `getTranscript()` (walks documented chain: `GET /bot/{id}` → `recordings[0].media_shortcuts.transcript.data.download_url` → S3 fetch; the assumed `/bot/{id}/transcript` convenience endpoint does NOT exist — 404), `handleWebhook()`, `registerBot()`. Singleton via `getRecallClient()` (returns null if `RECALL_API_KEY` not set). Region pinned via `RECALL_REGION` env (default `us-west-2`).
- `agent/src/meeting-transcript-poller.ts` — `MeetingTranscriptPoller` class. Started in `index.ts join_meeting` handler, polls Recall transcript every ~30s (`intervalMs` configurable), dedups via first-word `start_timestamp.relative` cursor, formats `<Speaker>: <text>\n` per turn, pushes batches to `currentLLM.chat()` tagged `[MEETING — <botId>]:` via the `onTurns` callback. Stopped on `leave_meeting` / disconnect / session-switch. Live webhook finals are buffered and drained on a 20s flush timer (batch `download_url` is empty mid-call, so the webhook is the only live source). A human `speech_on` during bot TTS triggers an immediate `{kind:'stop'}` canvas event (interruption); the cut-off text + who interrupted is prepended to the next flush.
- **Meeting canvas & cast (bot camera/mic)** — with Recall `output_media`, a single frontend page (`frontend/src/app/meeting-canvas/page.tsx`, `?agent=<agentUrl>`) is streamed as BOTH the bot's camera (its video) AND mic (page audio → meeting), and is granted the meeting audio. The agent is the "director": `POST /canvas {kind:'say'|'show'|'stop'}` and the page subscribes to `GET /canvas-stream` (SSE). On SSE reconnect the server resends the last `show` so a reload doesn't blank the camera (`latestCanvasShow`, reset on machine restart). `show.mode==='stream'` renders `<img src="{tunnel}/stream">` — a live MJPEG browser feed (from the session-engine's CDP screencast, tunneled) as the camera, NOT an iframe. Cast is OFF by default (silent invisible observer); enabling points the camera at the agent's own public canvas URL. `/tts` pushes synthesized audio into the meeting.
- `agent/src/pipeline-direct-llm.ts` — `PipelineDirectLLM` wraps `ClaudeLLM`. Proxies all properties/methods. On every `chat()` call: extracts user text, consumes pending interruption context (`[INTERRUPTED]` enriched message with spoken text + last 10 assistant messages from JSONL), fires `firePipelineFastBrain()` in background. Builds + watches the summary index lazily on first question. Exposes `interruptAgent()`, `abortAgent()`, `rewindAgent()`, `sendPrompt()` for fast brain agent control.
- `agent/src/pipeline-fastbrain.ts` — Pipeline fast brain: Gemini Flash AFC (Automatic Function Calling) agent. **3 tools**: `search_session` (ripgrep over the summary index, then byte-offset reads of full content), `get_recent` (most recent session activity), `emergency_stop` (kills + restarts the main Claude agent with an `[EMERGENCY STOP]` prompt that includes the user's recent messages and recent activity). One `generateContent` call handles the whole loop via AFC, capped at 4 calls.
- `agent/src/claude-auth.ts` — Claude Code OAuth flow for headless/cloud environments. Auth priority: `CLAUDE_CODE_OAUTH_TOKEN` env → `~/.claude/.credentials.json` → `claude auth status --json` CLI check → interactive `claude setup-token` via `node-pty`. `resolveClaudePath()` walks shell `which`, common paths (homebrew/nvm/Linux), and `npm bin -g`. The pty's auth URL output is captured and surfaced via callback so the frontend can show it; the user pastes the code back, fast brain forwards via callback.
- `agent/src/voice-io.ts` — Factory functions for STT (Deepgram Flux with semantic turn detection), TTS (Deepgram/OpenAI/ElevenLabs/Gemini), VAD (Silero), and realtime model creation (`createRealtimeModelFromConfig()`).
- `agent/src/turn-detector-shim.ts` — `CloudTurnDetector` implements LiveKit's `_TurnDetector` interface without requiring `JobContext` / worker framework. Calls `LIVEKIT_REMOTE_EOT_URL` directly via `fetch` for end-of-turn probability. Falls back to `1.0` (always end of turn) when the env var is unset, letting STT endpointing handle turn detection.
- `agent/src/status-manager.ts` — `StatusManager` (singleton `statusManager`) tracks background `TaskStatus` records (`pending`/`running`/`completed`/`failed`). Used for reporting interim progress to the voice model. `getLatestProgressUpdate()` returns + clears the latest unspoken update, `getStatusUpdate()` returns a natural-language summary, `clearReportedTasks()` GCs completed tasks older than 2 minutes.
- `agent/src/codex-llm.ts` / `agent/src/codex-handler.ts` — Optional alternative LLM wrapper for the OpenAI Codex SDK (`@openai/codex-sdk`). `CodexLLM` extends `llm.LLM`, persists a single Codex `Thread` across user turns. Currently not wired into the default voice flow but available for swapping in.
- `agent/src/bridge-llm.ts` — `createBridgeLLM()` factory that returns a Gemini or GPT-4o LiveKit LLM instance for "bridge LLM" voice setups (a conversation manager LLM separate from Claude). Exists for future pipelined voice configurations; not used by the default flow.
- `agent/src/claude-handler.ts` — Standalone `ClaudeHandler` class wrapping the Agent SDK with permission interception. Predates the persistent-session `ClaudeLLM`; kept around but not used by the default voice flow.

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

### Cloud Sandboxes (Fly.io Sprites — current production system)

Sprites (`frontend/src/lib/sprites.ts`) replaced the self-hosted Daytona setup in April 2026 and is the **current production cloud-sandbox system**. The Daytona section above is preserved for historical reference; `daytona.ts` is no longer active.

Sprites are persistent Linux sandboxes (Ubuntu, Node 22, 100GB NVMe) managed by Fly.io. Required env: `SPRITES_API_TOKEN` in `frontend/.env.local`.

**Key files:**
- `frontend/src/lib/sprites.ts` — Provisioning, lifecycle, fs API helpers, marker bootstrap, warm-wake handling.
- `frontend/src/app/api/sandbox/route.ts` — Same endpoint as the Daytona version; switched-out backend.
- `agent/src/index.ts` — `/health` (returns 200 always — now exposes `livekit:{status,error,errorCode,attemptCount,lastAttemptAt}` so frontend can surface real LiveKit errors instead of bouncing to dashboard), `/events` (SSE keepalive), `/room-code`, `/sessions` HTTP API. `room.connect` wrapped in bounded-backoff retry (`5s→10s→20s→40s→60s cap`, infinite) — no more `process.exit(1)` on transient LiveKit failures + no more Fly restart loops.

**Architecture quirks tracked in [docs/critical-patterns.md](docs/critical-patterns.md) ("Sprites cloud-sandbox patterns") and [CHANGELOG.md](CHANGELOG.md) (v0.8.30–0.8.38 entry):**
- **Unique sprite names per `createSandbox`**: `generateUniqueSpriteName(userId)` adds a base36 timestamp suffix. `findUserSandbox(userId, knownSandboxId?)` reads the actual sprite name from Supabase as source of truth. Required because Sprites' API gateway can develop "stuck routing" entries per sprite name.
- **Restart service on warm-wake**: When `startSandbox()` resumes a sprite that was warm AND has marker bootstrap, it `restartService()` to give the agent a fresh process with a fresh LiveKit WebSocket. CRIU snapshot preserves the local socket state but LiveKit Cloud has evicted the agent during hibernation; without process restart the agent is a "ghost" in the room (in-memory state says "Connected", but real connection is dead).
- **Never restore checkpoint on transient API failure**: `startSandbox()` tracks `serviceCheckSucceeded` separately. The destructive `restoreCheckpoint()` only fires when we positively know the service lacks marker logic — never when the API call to determine that just transiently 503'd. Prior version silently restored on 503s, wiping `.credentials.json` and session JSONLs.
- **Marker bootstrap**: `buildOsbornBootstrap()` writes `/home/sprite/.osborn-installed-version` after install. Subsequent restarts compare WANT vs marker and skip install when they match. The bootstrap also emits a "Session inventory (container view)" log at boot showing JSONL counts per project — visible via Sprites' service-logs API for layer-divergence diagnostics.
- **Two-click delete confirmation**: Trash icon arms on first click, deletes on second within 4s. Sprites does NOT soft-delete (verified by probing 6 different undelete endpoint shapes — all 404). Once deleted, overlay + persistent disk + checkpoints are unrecoverable.
- **fs API ≠ container view**: `GET /v1/sprites/<id>/fs/list|read` reads persistent disk; the running container reads through the CRIU overlay. They can desync. `fs/write` returns 405 on POST but works on PUT — yet writes via fs API land on persistent disk and are NOT visible to the running container at the same path.
- **`process.cwd()` is `/home/sprite/workspace`** in production (set via `OSBORN_CWD`), NOT the package install directory. Files shipped with the npm package must resolve via ESM `__dirname` (`fileURLToPath(import.meta.url)` + `dirname`), not cwd. The build script copies static files to `dist/` so they ship with the package.
- **Recall.ai meeting integration (post-2026-05-22 polling rewrite)**: bot joins by name only — no `output_media`, no `realtime_endpoints`. Agent polls `GET https://us-west-2.recall.ai/api/v1/bot/{bot_id}` every 30s, walks `recordings[0].media_shortcuts.transcript.data.download_url` (pre-signed S3 URL, ~6h expiry), fetches the JSON, pushes new turns to `currentLLM.chat()` as `[MEETING — <botId>]:`. The `meetings` skill (`agent/.claude/skills/meetings/SKILL.md`) teaches the agent to maintain `meeting-todos.md` silently and to pull on-demand via Bash + curl. `RECALL_REGION` env selects the regional endpoint (default `us-west-2`); 401 if the API key belongs to a different region.
- **Sandbox log capture**: `agent/Dockerfile.sandbox` entrypoint tees stdout/stderr to `/workspace/osborn.log` (volume-backed, 100 MB cap, 50 MB tail rotation on boot). `frontend/src/lib/machines.ts execInSprite()` reads this via the documented `/exec` API with `tail -n 500`. Fly Machines does NOT expose a REST `/logs` endpoint — the previous implementation returned the 404 error string as "the log content" for every disconnect-time upload to Supabase Storage.

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

## Browser Screen Recorder (voice/web-app testing product)

`tests/voice-e2e/` is the **Browser Screen Recorder** harness (formerly named "voice-e2e" — the source dir keeps the old path; everything user-facing was renamed 2026-07-31). It gives a coding agent ears, a mouth, hands + a brain to drive ANY web app in a real browser from an intent and record proof it worked (per-action screenshot + mp4, audio capture, DevTools diagnostics, metrics). Nothing is injected; no backend access assumed.

- **Two modes**: (1) SHORT one-shot Playwright scenario (`OSBORN_SCENARIO=<name> npx playwright test specs/scenario.spec.ts`); (2) LONG-RUNNING **session-engine** (`tests/voice-e2e/scripts/session-engine.ts`) — ONE persistent director-controlled browser that stays alive, streams live (CDP screencast → MJPEG at `:8080`, or the Fly machine's public URL), holds its LiveKit room, and takes commands over HTTP `:8781`: `/status /act /say /hear /shot /clip /tab /recover /end`. Every `/act` and `/say` returns BOTH a screenshot AND a short mp4 clip; `/recover` reloads the active tab in place (the raw Playwright `active` page survives, but Stagehand's `brain()` observe can detach — drive clicks via the engine's CDP port `9280` `Runtime.evaluate` when that happens). The brain is Stagehand + Gemini Flash (no selectors, self-healing action cache).
- **Distributable product**: a versioned self-updating skill served from `/api/browser-screen-recorder` (legacy alias `/api/test-skill` re-exports it — installed clients `curl` without `-L`, so old routes must serve, not 3xx), a harness file bundle at `/api/browser-screen-recorder/bundle` (baked at build time by `frontend/scripts/build-harness-bundle.mjs` → `public/browser-screen-recorder-bundle.json` + legacy `voice-e2e-bundle.json`), and a landing page at `/browser-screen-recorder` (legacy `/test-skill` redirects). Skill files: `.claude/skills/browser-screen-recorder/SKILL.md` (root, synced from the served copy) + `agent/.claude/skills/browser-screen-recorder/SKILL.md` (packaged seed shipped with the npm package). Bump the `Version:` in `frontend/src/app/api/browser-screen-recorder/route.ts` AND `HARNESS_VERSION` in both the bundle route + build script together so clients auto-update.
- **Test accounts** (`tests/voice-e2e/profiles/`): `login-test-user.ts` does a headless email/password Supabase login (reads `profiles/test-user.env` → `osborn-tester@voice-native.com`, a dedicated email-provider account) and saves a Playwright `storageState` to `profiles/<OSBORN_TEST_PROFILE>/state.json`. The engine loads `profiles/<OSBORN_TEST_PROFILE || 'ozyjunks'>/state.json`, falling back to the guest link when the profile is absent. **Only email/password accounts are scriptable** — Google-OAuth accounts (e.g. `ozyjunks@gmail.com`) can't be headless-logged-in, so `osborn-tester@voice-native.com` is the canonical test account, not the `'ozyjunks'` the default string implies.

## Critical Patterns

Bug fixes and gotchas (persistent session lifecycle, voice queue timing, Gemini quirks, research batching, Smithery proxy, etc.) live in **[docs/critical-patterns.md](docs/critical-patterns.md)**. Read that file when debugging anything non-obvious. Representative first entry:

- **Self-healing CWD fallback chain**: `index.ts main()` walks `[OSBORN_CWD env, config.workingDirectory, process.cwd()]` and picks the FIRST entry whose path actually exists on disk. Blindly trusting any of these has bitten us — e.g. cloud sandboxes had `OSBORN_CWD=/root/workspace` baked in but `/root` is `drwx------` and the dir doesn't exist, so the SDK's `child_process.spawn(node, [cli.js], { cwd })` errored ENOENT and reported the misleading "Claude Code executable not found at .../cli.js". `process.cwd()` is the ultimate safety net — it exists by definition.
## Prompt System

Every prompt layer (realtime teleprompter, research system prompts, fast brain, spec consolidation, proactive loop, voice-queue injection prefixes, etc.) is centralized in `prompts.ts` and documented in **[docs/prompt-system.md](docs/prompt-system.md)**.

## TypeScript Config Notes
- Agent: `strict: false`, ESM (`module: ESNext`, `moduleResolution: bundler`, `target: ES2022`)
- Frontend: `strict: true`, path alias `@/*` → `./src/*`
- `dotenv/config` must be the first import in `agent/src/index.ts` (env vars needed before other modules load)
