## April 2026 — Fly.io Sprites Cloud Sandboxes

- Replaced self-hosted Daytona with Fly.io Sprites for per-user cloud sandboxes
- `frontend/src/lib/sprites.ts` — new sandbox library (drop-in for daytona.ts)
- Key fixes: npm global PATH (`$(npm prefix -g)/bin` not `/.sprite/bin`), 503 retry race (up to 9 retries needed), `waitForServiceReady()` polling
- First-run: ~6.3 min; checkpoint restore: ~10-20s
- End-to-end verified: osborn installs, starts, connects to LiveKit, health passes
- Planned: pre-warm pool for ~30s new-user provisioning

---

# Osborn v0.8.6 - Voice AI Research Assistant

## Architecture

Osborn is a voice AI assistant for research and development. It uses LiveKit for real-time voice communication, Claude Agent SDK for research capabilities, and OpenAI/Gemini for native speech-to-speech interaction.

### Three Voice Modes

| Mode | Stack | Best For |
|------|-------|----------|
| **Pipeline** (default) | STT (Deepgram Flux) → ClaudeLLM (persistent session) wrapped by `PipelineDirectLLM` + parallel Gemini Flash AFC observer → TTS | Full research + parallel fast brain memory recall, emergency stop on destructive actions, interruption-context enrichment |
| **Direct** | STT (Deepgram Flux) → ClaudeLLM (persistent session) → TTS | Full research tasks, maximum tool access, no parallel observer |
| **Realtime** | OpenAI Realtime / Gemini Live native speech-to-speech, teleprompter model with 2 tools (`ask_fast_brain`, `respond_permission`) | Lowest-latency voice; fast brain owns all routing — direct answer, deep research, decision recording, document generation |

### Single Research Mode

No plan/execute/edit mode toggles. The agent operates in a single **research** mode with write safety (Write/Edit blocked outside the per-session workspace, with `spec.md` additionally blocked because the fast brain owns it).

### System Diagram

```
Frontend (Next.js 14)  ←→  LiveKit Cloud  ←→  Agent (local or cloud sandbox)
                                                ├── ClaudeLLM (persistent SDK session)
                                                │   ├── researcher sub-agent (Sonnet)
                                                │   ├── reasoner sub-agent (Opus)
                                                │   └── writer sub-agent (Sonnet, verify-first)
                                                ├── Fast Brain (Gemini Flash primary,
                                                │   Anthropic Haiku fallback, 12 JSONL tools)
                                                ├── Pipeline Fast Brain (Gemini Flash AFC observer
                                                │   with search_session, get_recent, emergency_stop)
                                                ├── OpenAI/Gemini Realtime voice
                                                ├── Recall.ai meeting bot integration
                                                ├── Smithery cloud MCP proxy
                                                └── Self-hosted Daytona sandboxes (per-user)
```

### Storage Architecture

```
~/.claude/projects/{slug}/           ← Claude's native project folder
  {session-uuid}.jsonl               ← Claude's conversation data (unchanged)
  {session-uuid}/subagents/          ← Sub-agent conversations (Claude native)
  osb/{session-uuid}/                ← Osborn's workspace (since v0.7.0)
    spec.md                          ← Session spec (goal, open questions, decisions, findings, plan)
    search-index.txt                 ← Compact summary index for fast search
    search-index-meta.json           ← Index metadata (byte offsets, timestamps)
```

Session picker scans ALL `~/.claude/projects/*/` folders via `listAllClaudeSessions()` — browse and resume any Claude conversation from any project, sorted by mtime.

---

## Current Features

| Feature | Status |
|---------|--------|
| Voice interface (LiveKit Agents 1.2.x) | Working |
| OpenAI Realtime voice | Working |
| Gemini Live voice | Working |
| Direct mode (STT → Claude → TTS) | Working |
| Pipeline mode (Claude + Gemini fast brain observer) | Working |
| Persistent ClaudeLLM session (no per-message JSONL replay) | Working |
| Multi-agent orchestration (researcher / reasoner / writer) | Working |
| `agent_type`-aware PreToolUse hook + writer permission deferral | Working |
| `canUseTool` workspace auto-approval (with `spec.md` denial) | Working |
| Skill auto-install for writer agent (`.claude/skills/<name>/`) | Working |
| Claude Agent SDK v0.2.91 tools (Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch, Task, TodoWrite) | Working |
| File checkpointing + rewind via `enableFileCheckpointing` | Working |
| Permission system (voice + UI, git-style diff viewer) | Working |
| All-projects session scanner (browse all Claude conversations) | Working |
| Session workspace (`~/.claude/projects/{slug}/osb/`) | Working |
| Summary index with byte-offset reads (<5ms search) | Working |
| Ripgrep search via bundled `@vscode/ripgrep` binary | Working |
| BM25 search (minisearch) over recent session history | Working |
| Fast brain teleprompter (`ask_fast_brain` central gateway) | Working |
| Fast brain provider chain (Gemini Flash → Anthropic Haiku → Agent SDK) | Working |
| Fast brain 12 JSONL tools (`read_agent_results`, `deep_read_*`, `send_to_chat`, etc.) | Working |
| Pipeline fast brain (Gemini Flash AFC + emergency_stop) | Working |
| Non-blocking research (SDK-managed queuing, fire-and-forget) | Working |
| Parallel sub-agents (Task tool for concurrent research) | Working |
| Unified voice injection queue with `haikuInFlight` gating | Working |
| Gemini auto-recovery (1008/1011 crash) with context briefing | Working |
| Gemini interrupt() guard (state machine hang prevention) | Working |
| JSONL session access (full untruncated tool results) | Working |
| Post-research spec consolidation via JSONL | Working |
| Visual document generation (Mermaid, comparison, analysis) | Working |
| Proactive conversational loop (15s, 4-prompt cap) | Working |
| Interruption context enrichment (spoken text + JSONL replay) | Working |
| `killCurrentLLM()` subprocess cleanup on disconnect | Working |
| Self-healing CWD fallback chain (existsSync verified) | Working |
| LiveKit Cloud turn detector shim (no JobContext required) | Working |
| MCP server integration (stdio + Smithery cloud SDK proxy) | Working |
| Recall.ai meeting bot integration (Zoom / Google Meet) | Working |
| Supabase Auth (Google + GitHub OAuth) | Working |
| Dashboard with recent chats, settings, agent health | Working |
| File attachments (Supabase Storage, inline images, download cards) | Working |
| Claude OAuth flow via pty (cloud sandbox + headless deployments) | Working |
| Self-hosted Daytona sandboxes (per-user, autoStop disabled) | Working |
| Local / Cloud connection mode toggle | Working |
| Setup wizard (6-step env file generator) | Working |
| Files explorer modal (artifacts, plans, diagrams) | Working |
| Markdown rendering with syntax highlighting + Mermaid | Working |
| Status manager (background task tracking) | Available, partial integration |
| Codex SDK alternative LLM wrapper | Available, not wired into default flow |
| Bridge LLM factory for future pipelined voice configs | Available |

---

## Key Files

### Agent (`agent/src/`)

| File | Purpose |
|------|---------|
| `index.ts` | Main entry, room events, session creation, voice queue, HTTP API, data handlers, `killCurrentLLM`, self-healing CWD chain, `executeResearch`, `wireSessionEvents` for auto-recovery |
| `claude-llm.ts` | `ClaudeLLM` wrapping Agent SDK; persistent `MessageChannel` session, three sub-agents, `agent_type`-aware PreToolUse hook, `canUseTool` workspace gating with `spec.md` denial, skills loader, interrupt/abort/rewind |
| `pipeline-direct-llm.ts` | `PipelineDirectLLM` proxies `ClaudeLLM` and fires `pipeline-fastbrain` in parallel; interruption-context enrichment; lazy summary-index build + watch |
| `pipeline-fastbrain.ts` | Gemini Flash AFC agent with `search_session`, `get_recent`, `emergency_stop` tools |
| `summary-index.ts` | JSONL summary-index builder, byte-offset reader, file watcher (<5ms search) |
| `fast-brain.ts` | Central orchestrator `askFastBrain()`; provider chain (Gemini Flash → Anthropic → Agent SDK); 12 fast brain tools; spec consolidation; visual docs; briefing scripts |
| `session-access.ts` | JSONL session reader (~25 functions, full untruncated data) |
| `jsonl-search.ts` | Ripgrep + BM25 search over JSONL; bundled `@vscode/ripgrep` binary; pattern validation |
| `prompts.ts` | All prompts centralized (~15 exports); legacy `prompts-2-25-26.ts` and `prompts-3-2-26.ts` are historical snapshots |
| `config.ts` | Config loading; session management; workspace helpers; MCP catalog with Smithery cloud entries |
| `recall-client.ts` | Recall.ai meeting bot integration |
| `smithery-proxy.ts` | In-process MCP proxy for Smithery cloud servers (bypasses SDK HTTP bug #18296) |
| `claude-auth.ts` | Claude Code OAuth flow (env → credentials file → CLI check → pty `claude setup-token`) |
| `voice-io.ts` | STT/TTS/VAD/Realtime model factory (Deepgram Flux, OpenAI, ElevenLabs, Gemini, Silero) |
| `turn-detector-shim.ts` | `CloudTurnDetector` for LiveKit Cloud remote inference without `JobContext` |
| `status-manager.ts` | Background `TaskStatus` tracking (singleton `statusManager`) |
| `codex-llm.ts` / `codex-handler.ts` | Optional `@openai/codex-sdk` LLM wrapper (alternative to Claude) |
| `bridge-llm.ts` | Factory for Gemini/GPT-4o LiveKit LLMs in pipelined voice configs |
| `claude-handler.ts` | Standalone Agent SDK handler (predates persistent `ClaudeLLM`) |
| `meeting-output.html` | Recall.ai bot Output Media webpage |

### Frontend (`frontend/src/`)

| File | Purpose |
|------|---------|
| `components/VoiceRoom.tsx` | Main voice UI (~2000 lines): chat, permission UI, session management, MCP toggles, files panel, OAuth modal, meeting controls |
| `components/MarkdownMessage.tsx` | Markdown renderer with syntax highlighting + Mermaid; `MessageContent` for inline images and download cards |
| `components/SessionBrowser.tsx` | Past session browser (all Claude projects) |
| `components/FilesExplorerModal.tsx` | Full-screen files explorer with type badges and copy-all |
| `components/LogsDrawer.tsx` | Bottom drawer for debug message log with unread badge |
| `components/SetupWizard.tsx` | 6-step env-file generator for first-time local users |
| `lib/setup.ts` | Pure setup utilities (env generation, validation, agent health) |
| `lib/sessions.ts` | Client-safe session helpers (no Node imports) |
| `lib/daytona.ts` | Server-only Daytona sandbox provisioning (raw HTTP) |
| `lib/supabase*.ts` | Supabase client factories (browser, server, middleware) |
| `app/api/token/route.ts` | LiveKit JWT token generation |
| `app/api/instance/route.ts` | User instance CRUD (Supabase) |
| `app/api/sandbox/route.ts` | Daytona sandbox CRUD + keepalive |
| `app/dashboard/page.tsx` | Dashboard: recent chats, settings, agent health |
| `app/chat/page.tsx` | Voice chat wrapper (resolves cloud or local agent URL) |
| `app/page.tsx` | Landing page (OAuth + guest connect) |
| `middleware.ts` | Supabase auth session middleware |

---

## v0.8.x — Cloud Sandboxes + Resilience

### Per-User Cloud Sandboxes (Self-Hosted Daytona)
- **`frontend/src/lib/daytona.ts`**: Raw HTTP against `daytona.voice-native.com`. `createSandbox`, `findUserSandbox`, `startSandbox`, `stopSandbox`, `keepAliveSandbox`, `deleteSandbox`. Symlinks `node`/`osborn`/`claude` into `/usr/local/bin`. `OSBORN_CWD=/home/daytona/workspace` forced inline (not just from env field) to defeat stale baked-in values
- **`waitForToolboxReady()`**: Polls `echo ready` via the toolbox `process/execute` endpoint until the Daytona reverse-proxy can resolve the container IP (3-6s race after metadata flips to `started`). Without this, `startSandbox()` silently 500s and chat connect 502s
- **`autoStopInterval: 0` (disabled)**: Self-hosted Daytona has a chronic backup-bug that fills disk on every auto-stop cycle. Defense in depth: disable here + `/etc/cron.daily/daytona-backup-prune` on the VPS keeping the latest 2 backups per sandbox
- **No supervisor wrapper**: `bash -c 'while true; do osborn; done'` holds the toolbox stdio pipe open and hangs `process/execute` for the full undici 5-min timeout. `osborn` MUST be the immediate child of `nohup` so Node closes its inherited fds during logging setup
- **Per-user Claude OAuth via `claude-auth.ts`**: First message in a fresh sandbox triggers `claude setup-token` via `node-pty`. Auth URL surfaced via `claude_auth_url` data channel message; user pastes code back via auth modal; token persists at `/home/daytona/.claude/.credentials.json`

### Resilience Patterns
- **`killCurrentLLM(reason)`**: Wired into all 3 cleanup sites (`Disconnected`, previous-session cleanup on new participant, `participant_disconnected`). Calls `abortQuery()` / `abortAgent()` to kill the persistent Claude subprocess BEFORE nulling `currentLLM`. Without this the SDK keeps draining `MessageChannel`, running tools, capturing checkpoints, and pushing TTS into a dead session
- **Self-healing CWD fallback chain**: `[OSBORN_CWD env, config.workingDirectory, process.cwd()]`, picking the FIRST entry that `existsSync()`. Ultimate safety net is `process.cwd()`. Cures the misleading "Claude Code executable not found at .../cli.js" error which is actually a `child_process.spawn` ENOENT on a cwd that doesn't exist
- **Setup wizard**: `frontend/src/components/SetupWizard.tsx` + `frontend/src/lib/setup.ts` provide a first-run UX for local users to configure `agent/.env` and `frontend/.env.local` from inside the dashboard

---

## Configuration

### Environment Variables (agent/.env)
```env
LIVEKIT_URL=wss://your-livekit-url
LIVEKIT_API_KEY=your-api-key
LIVEKIT_API_SECRET=your-api-secret
ANTHROPIC_API_KEY=your-anthropic-key  # Or rely on Claude OAuth flow
OPENAI_API_KEY=your-openai-key        # At least one of OpenAI or Google required
GOOGLE_API_KEY=your-google-key        # Recommended (Gemini Flash is fast brain primary)
DEEPGRAM_API_KEY=your-deepgram-key    # STT for direct/pipeline modes
SMITHERY_API_KEY=your-smithery-key    # Optional, for cloud MCP servers
RECALL_API_KEY=your-recall-key        # Optional, for Zoom/Google Meet bot
LIVEKIT_REMOTE_EOT_URL=...            # Optional, LiveKit Cloud turn detector
OSBORN_CWD=/path/to/project           # Optional, overrides config.workingDirectory
OSBORN_API_PORT=8741                  # Optional, defaults to 8741 (auto-bumps on EADDRINUSE)
```

### Frontend Environment (frontend/.env.local)
```env
NEXT_PUBLIC_LIVEKIT_URL=wss://your-livekit-url
LIVEKIT_API_KEY=your-api-key
LIVEKIT_API_SECRET=your-api-secret
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
# Optional, for cloud sandbox provisioning:
DAYTONA_API_KEY=...
DAYTONA_API_URL=https://daytona.voice-native.com
DAYTONA_PROXY_DOMAIN=daytona.voice-native.com
DAYTONA_REGION=us
# Forwarded into sandboxes:
OPENAI_API_KEY=...
GOOGLE_API_KEY=...
DEEPGRAM_API_KEY=...
RECALL_API_KEY=...
SMITHERY_API_KEY=...
```

### Config File (~/.osborn/config.yaml)
```yaml
workingDirectory: /path/to/project
defaultProvider: openai
voiceMode: pipeline  # 'direct' | 'realtime' | 'pipeline' (default)

realtime:
  provider: openai   # or 'gemini'
  openaiVoice: alloy
  geminiVoice: Puck

direct:
  stt:
    provider: deepgram
  tts:
    provider: deepgram
    voice: aura-asteria-en

mcpServers:
  github:
    enabled: true
```

---

Last Updated: 2026-04-09 (v0.8.6)
