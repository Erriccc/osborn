# Osborn - Voice AI Research & Development Assistant

Voice-enabled research and coding assistant powered by LiveKit + Claude Agent SDK. Talk to your code, research deeply, and build plans before executing.

## Features

- **Voice Interface**: Real-time voice conversation using LiveKit Agents 1.2.x
- **Three Voice Modes**:
  - **Pipeline (default)**: STT (Deepgram Flux semantic turn detection) → ClaudeLLM (persistent session) wrapped by `PipelineDirectLLM` + parallel Gemini Flash AFC observer → TTS. Interruption context is enriched into the next user message.
  - **Direct**: STT → ClaudeLLM → TTS, no parallel observer.
  - **Realtime**: OpenAI Realtime / Gemini Live native speech-to-speech, with the model acting as a thin teleprompter calling `ask_fast_brain` for every turn.
- **Persistent Session**: Single Claude subprocess per voice session — no JSONL replay after first message. Uses `query()` with an `AsyncIterable<SDKUserMessage>` `MessageChannel` and a long-lived background consumer.
- **Multi-Agent Orchestration**: Sonnet orchestrator delegates to three named sub-agents — **researcher** (Sonnet, read-only investigation), **reasoner** (Opus, deep analysis and planning), **writer** (Sonnet with verify-first workflow).
- **Research Mode**: Read code, search web, run commands, fetch YouTube transcripts, save findings to session workspace.
- **Claude Agent SDK v0.2.91**: Full tool access (Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch, Task, TodoWrite). File checkpointing + rewind via `enableFileCheckpointing`.
- **Permission System**: Approve/deny operations via voice or UI. `agent_type`-aware `PreToolUse` hook routes the writer sub-agent through `canUseTool` for explicit prompts; researcher/reasoner/main are restricted to workspace paths. `canUseTool` auto-approves workspace writes EXCEPT `spec.md` (the fast brain owns it).
- **Session Management**: Browse and resume conversations from ALL Claude Code projects on your machine — sorted by mtime via `listAllClaudeSessions()`.
- **Fast Brain (Teleprompter)**: Single gateway `askFastBrain()` handling every realtime user turn. Provider chain: **Gemini Flash primary** (~1-2s, 1M tokens, no cold start) → Anthropic Haiku → Agent SDK fallback. **12 JSONL tools** including `read_agent_results`, `read_agent_text`, `deep_read_results`, `deep_read_text`, `search_jsonl`, `read_subagents`, `get_session_stats`, `send_to_chat`.
- **Pipeline Fast Brain**: Gemini Flash AFC (Automatic Function Calling) observer runs in parallel with Claude. Three tools: `search_session` (ripgrep over the summary index + byte-offset reads), `get_recent`, and `emergency_stop` that aborts and restarts the Claude subprocess on destructive-action user signals.
- **Summary Index**: Compact line-oriented index over JSONL session files with byte-offset reads (<5ms search). Lazy build + file watcher in pipeline mode.
- **Ripgrep + BM25 Search**: Bundled `@vscode/ripgrep` binary for fast regex search across JSONL files; in-memory `minisearch` BM25 index over recent session messages.
- **Meeting Integration**: Recall.ai bot joins Zoom/Google Meet and routes real-time transcripts to Claude as `[Meeting — Speaker]: text`.
- **JSONL Session Access**: 25+ functions in `session-access.ts` for reading FULL untruncated tool results, agent reasoning, and sub-agent transcripts from `~/.claude/projects/`.
- **Non-Blocking Research**: `executeResearch()` runs background Claude queries; the SDK handles internal queuing. Progress is debounced (8s batch) and contextualized through the fast brain before voice relay.
- **Parallel Sub-Agents**: Orchestrator spawns concurrent `Task` sub-agents for independent research streams.
- **Visual Documents**: Mermaid diagrams, comparison tables, analysis docs generated via `generateVisualDocument()` and surfaced in the files panel.
- **Gemini Auto-Recovery**: Automatic session recovery from crashes (1008/1011) with conversation-history briefing on resume.
- **MCP Integration**: Stdio servers + Smithery cloud servers via in-process `smithery-proxy` (bypasses Claude SDK HTTP bug #18296).
- **Research Artifacts**: Plans, diagrams (Mermaid), notes, and analysis files — persist across session resumes via `listWorkspaceArtifacts()`.
- **Claude OAuth Flow**: For headless / cloud deployments. `claude-auth.ts` walks env → credentials file → CLI check → interactive `claude setup-token` via `node-pty`. Auth URL surfaces via `claude_auth_url` data channel; user pastes code back via the auth modal; token persists in `~/.claude/.credentials.json`.
- **Per-User Cloud Sandboxes**: Self-hosted Daytona on a Hostinger VPS provisions isolated Linux sandboxes per user (Claude Code + osborn pre-installed). Each user authenticates Claude via their own OAuth flow inside the sandbox. Tokens persist on the sandbox filesystem. Local vs Cloud toggle in dashboard settings — see `DAYTONA-SETUP.md`.
- **`waitForToolboxReady()`**: Bridges Daytona's metadata-vs-reverse-proxy race so Resume actually delivers a working sandbox instead of a 502.
- **`autoStopInterval: 0`**: Sandboxes don't auto-stop because self-hosted Daytona has a backup-system bug that fills disk on every cycle. Defense-in-depth via daily backup-prune cron on the VPS.
- **`killCurrentLLM()` cleanup**: Hard-kills the persistent Claude subprocess on disconnect so the SDK doesn't keep draining MessageChannel into a dead session.
- **Self-Healing CWD Fallback**: `[OSBORN_CWD env, config.workingDirectory, process.cwd()]` walked in priority order, picking the first that `existsSync()`. Cures the misleading "Claude Code executable not found" error which is actually `child_process.spawn` ENOENT on a stale cwd.
- **LiveKit Cloud Turn Detector Shim**: `CloudTurnDetector` implements `_TurnDetector` directly via `fetch` to `LIVEKIT_REMOTE_EOT_URL`, no `JobContext` / worker framework required.

### Cloud Sandboxes (Fly.io Sprites)

As of April 2026, Sprites (`frontend/src/lib/sprites.ts`) replaces the self-hosted Daytona setup for per-user cloud sandboxes. Sprites are persistent Linux sandboxes (Ubuntu, Node 22, 100GB NVMe) managed by Fly.io.

**Required env**: `SPRITES_API_TOKEN` in `frontend/.env.local`.

**Key behaviors**:
- First-run provisioning: ~6 minutes (npm install from scratch)
- Checkpoint restore: ~10-20 seconds (CRIU)
- Auto-hibernates after ~30s idle — wakes on HTTP request
- Service registration may 503 for ~45s after creation — retry loop handles this
- **Unique sprite names per create** (since v0.8.38): `generateUniqueSpriteName` appends a base36 timestamp suffix to bypass any per-name "stuck routing" entries in Sprites' API gateway. `findUserSandbox(userId, knownSandboxId?)` reads the actual sprite name from Supabase as source of truth; deterministic name is fallback only.
- **Warm-wake LiveKit kick** (since v0.8.38): When `startSandbox()` resumes a warm sprite that has marker bootstrap, it `restartService()` to give the agent a fresh process with a fresh LiveKit WebSocket. CRIU snapshot preserves the local socket but LiveKit Cloud has evicted the agent during hibernation; without a process restart the agent is a "ghost" in the room.
- **Marker-bootstrap install loop avoidance**: Bootstrap writes `/home/sprite/.osborn-installed-version` after a successful install. Subsequent restarts compare WANT vs marker and skip install when they match.
- **Two-click delete confirmation**: Sprites does NOT soft-delete (probed 6 different undelete endpoint shapes — all 404). Trash icon arms on first click, deletes on second click within 4s. Auto-disarms otherwise.
- **`fs/write` is asymmetric with container view**: writes via fs API land on the persistent disk and are NOT visible to the running container (overlay layer). Don't use it to "inject" files into a sprite — bake them into the bootstrap or copy them via service exec.
- **`process.cwd()` is `/home/sprite/workspace`** (per `OSBORN_CWD`). Files shipped with the npm package must resolve via ESM `__dirname`, not cwd. See the `meeting-output.html` handler in `agent/src/index.ts` for the 3-candidate path pattern.

**Planned**: Pre-warm pool to reduce new-user wait to ~30s. Agent-side LiveKit reconnect watchdog so warm-wake doesn't require a service restart.

The Daytona setup (`DAYTONA_API_KEY`, `daytona.ts`) is preserved but no longer active.

- **Multi-User Auth**: Google + GitHub OAuth via Supabase SSR. Dashboard with recent chats, settings, agent health. Auto-connect on login.
- **File Attachments**: Upload images/files to Supabase Storage (`osborn-storage` bucket). Images render inline via `MessageContent`; files render as download cards.
- **Setup Wizard**: 6-step in-dashboard wizard generates `agent/.env` and `frontend/.env.local` for first-run local users.
- **Files Explorer Modal**: Full-screen file viewer with type badges, copy/copy-all, and inline rendering of plans, diagrams, notes, HTML.
- **Mobile-First UI**: Responsive dark theme (amber/charcoal), hamburger menu drawer, compact visualizer, sheet-style permission modals.
- **Permission Modal**: Git-style diff viewer (`diff` + `diff2html`) with line numbers, addition/deletion counts, expand/collapse, dismissable auth errors.

## Research Mode

The agent operates in a single **research** mode. It reads code, searches the web, runs commands, fetches YouTube transcripts, and saves findings to a session workspace co-located with Claude's native JSONL files (`~/.claude/projects/{slug}/osb/{sessionId}/`). Write operations are restricted to the workspace directory for safety. Research artifacts appear in the always-visible Files panel.

## Architecture

```
Frontend (Next.js 14)  <-->  LiveKit Cloud  <-->  Agent (local or cloud sandbox)
                                                  ├── ClaudeLLM (persistent SDK session)
                                                  │   ├── researcher sub-agent (Sonnet, read-only)
                                                  │   ├── reasoner sub-agent (Opus, planning)
                                                  │   └── writer sub-agent (Sonnet, verify-first)
                                                  ├── Fast Brain (Gemini Flash primary,
                                                  │   Anthropic Haiku fallback, 12 JSONL tools)
                                                  ├── Pipeline Fast Brain (Gemini Flash AFC observer
                                                  │   with search_session, get_recent, emergency_stop)
                                                  ├── OpenAI/Gemini Realtime (voice)
                                                  ├── Recall.ai (meeting bot integration)
                                                  ├── Smithery cloud MCP proxy
                                                  └── Self-hosted Daytona sandboxes (per-user)
```

## Quick Start

### Option 1: Using Hosted Frontend

```bash
# Install and run the agent
npx osborn

# Copy the room code shown (e.g., "abc123")
# Visit https://osborn.app
# Enter the room code and click Join
```

### Option 2: Local Development

1. Clone and install:
```bash
git clone https://github.com/Erriccc/osborn.git
cd osborn
cd agent && npm install
cd ../frontend && npm install
```

2. Configure environment variables:

**agent/.env:**
```env
LIVEKIT_URL=wss://your-livekit-url
LIVEKIT_API_KEY=your-api-key
LIVEKIT_API_SECRET=your-api-secret
ANTHROPIC_API_KEY=your-anthropic-key      # Or rely on the Claude OAuth flow
GOOGLE_API_KEY=your-google-key            # Recommended — Gemini Flash is fast brain primary
OPENAI_API_KEY=your-openai-key            # At least one of OpenAI or Google required
DEEPGRAM_API_KEY=your-deepgram-key        # STT for direct/pipeline modes

# Optional:
RECALL_API_KEY=your-recall-key            # Zoom / Google Meet bot integration
SMITHERY_API_KEY=your-smithery-key        # Cloud MCP servers
LIVEKIT_REMOTE_EOT_URL=...                # LiveKit Cloud remote turn detection
OSBORN_CWD=/path/to/project               # Override config.workingDirectory
OSBORN_API_PORT=8741                      # Auto-bumps on EADDRINUSE
```

**frontend/.env.local:**
```env
NEXT_PUBLIC_LIVEKIT_URL=wss://your-livekit-url
LIVEKIT_API_KEY=your-api-key
LIVEKIT_API_SECRET=your-api-secret
```

3. Run:
```bash
# Terminal 1: Agent
cd agent && npm run dev

# Terminal 2: Frontend
cd frontend && npm run dev
# Open http://localhost:3000
```

## Configuration

Create `~/.osborn/config.yaml`:

```yaml
workingDirectory: /path/to/project
voiceMode: pipeline      # 'direct' | 'realtime' | 'pipeline' (default)
defaultProvider: openai  # or 'gemini' (for realtime mode)

realtime:
  provider: openai       # or 'gemini'
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
    command: npx
    args: ['-y', '@modelcontextprotocol/server-github']
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: ${GITHUB_TOKEN}
```

You can also configure these via the **in-dashboard Setup Wizard** (`SetupWizard.tsx`) — a 6-step UX that generates `agent/.env` and `frontend/.env.local` and verifies agent health for first-run users.

## Voice Commands

### Research
- "Research how authentication works in this project"
- "Show me the data flow from API to database"
- "Create a diagram of the component architecture"
- "Write up a plan for adding OAuth"
- "Search for best practices on rate limiting"
- "What dependencies does this project use?"
- "Get the transcript for this YouTube video"

## Project Structure

```
osborn/
├── agent/                              # LiveKit voice agent (backend)
│   ├── src/
│   │   ├── index.ts                    # Main entry: room events, session creation, voice queue, HTTP API,
│   │   │                               #   killCurrentLLM, self-healing CWD chain, executeResearch
│   │   ├── claude-llm.ts               # ClaudeLLM persistent session, three sub-agents,
│   │   │                               #   agent_type-aware PreToolUse hook, canUseTool gating
│   │   ├── pipeline-direct-llm.ts      # PipelineDirectLLM wraps ClaudeLLM + interruption enrichment
│   │   ├── pipeline-fastbrain.ts       # Gemini Flash AFC observer with search_session/get_recent/emergency_stop
│   │   ├── fast-brain.ts               # askFastBrain orchestrator, 12 JSONL tools, spec consolidation
│   │   ├── session-access.ts           # JSONL session reader (~25 functions, full untruncated)
│   │   ├── jsonl-search.ts             # ripgrep + BM25 search over JSONL (bundled @vscode/ripgrep)
│   │   ├── summary-index.ts            # Compact summary index with byte-offset reads
│   │   ├── prompts.ts                  # Centralized prompts (~15 exports)
│   │   ├── config.ts                   # Config, sessions, workspace helpers, MCP catalog
│   │   ├── recall-client.ts            # Recall.ai meeting bot integration
│   │   ├── claude-auth.ts              # Claude OAuth flow (env → file → CLI → pty setup-token)
│   │   ├── smithery-proxy.ts           # Smithery cloud MCP proxy (bypasses SDK HTTP bug #18296)
│   │   ├── voice-io.ts                 # STT/TTS/VAD/Realtime model factory
│   │   ├── turn-detector-shim.ts       # CloudTurnDetector for LiveKit Cloud (no JobContext)
│   │   ├── status-manager.ts           # Background TaskStatus tracker (singleton)
│   │   ├── codex-llm.ts                # Optional @openai/codex-sdk LLM wrapper
│   │   ├── codex-handler.ts            # Standalone Codex handler
│   │   ├── bridge-llm.ts               # Gemini/GPT-4o LiveKit LLM factory for pipelined configs
│   │   ├── claude-handler.ts           # Standalone Agent SDK handler (predates ClaudeLLM)
│   │   └── meeting-output.html         # Recall.ai bot audio output page
│   └── package.json
├── frontend/                           # Next.js 14 web frontend
│   ├── src/
│   │   ├── components/
│   │   │   ├── VoiceRoom.tsx           # Main voice UI (~2000 lines)
│   │   │   ├── MarkdownMessage.tsx     # Markdown + Mermaid renderer
│   │   │   ├── SessionBrowser.tsx      # Past session browser (all projects)
│   │   │   ├── FilesExplorerModal.tsx  # Full-screen files explorer
│   │   │   ├── LogsDrawer.tsx          # Bottom drawer for debug log
│   │   │   └── SetupWizard.tsx         # 6-step env-file generator
│   │   ├── lib/
│   │   │   ├── daytona.ts              # Server-only Daytona sandbox provisioning
│   │   │   ├── setup.ts                # Pure setup utilities
│   │   │   ├── sessions.ts             # Client-safe session helpers
│   │   │   └── supabase*.ts            # Supabase client factories
│   │   ├── app/
│   │   │   ├── api/token/route.ts      # LiveKit JWT token generation
│   │   │   ├── api/instance/route.ts   # User instance CRUD
│   │   │   ├── api/sandbox/route.ts    # Daytona sandbox CRUD + keepalive
│   │   │   ├── dashboard/page.tsx      # Recent chats, settings, agent health
│   │   │   ├── chat/page.tsx           # Voice chat wrapper
│   │   │   └── page.tsx                # Landing page (OAuth + guest)
│   │   └── middleware.ts               # Supabase auth middleware
│   └── package.json
├── CLAUDE.md                           # AI coding assistant guidance
├── PROGRESS.md                         # Current feature status
├── CHANGELOG.md                        # Version history
├── DAYTONA-SETUP.md                    # Self-hosted Daytona deployment notes
└── README.md
```

## Current Status (v0.8.6)

| Component | Status |
|-----------|--------|
| Voice Interface (LiveKit Agents 1.2.x) | Working |
| Persistent ClaudeLLM session (no per-message JSONL replay) | Working |
| Multi-Agent Orchestration (researcher/reasoner/writer) | Working |
| Pipeline Mode (Claude + Gemini fast brain observer) | Working |
| OpenAI Realtime | Working |
| Gemini Live (with auto-recovery) | Working |
| Direct Mode (STT + Claude + TTS) | Working |
| Claude Agent SDK v0.2.91 | Working |
| Permission System (`agent_type`-aware PreToolUse + canUseTool) | Working |
| `spec.md` write block (fast brain owns it) | Working |
| Skill auto-install for writer agent | Working |
| Session Management (all-projects scanner) | Working |
| Research Artifacts (files panel) | Working |
| Recall.ai Meeting Integration | Working |
| Non-blocking research (SDK-managed queuing) | Working |
| Parallel sub-agents (Task tool) | Working |
| Fast Brain (Gemini Flash primary, 12 JSONL tools) | Working |
| Pipeline Fast Brain (Gemini AFC + emergency_stop) | Working |
| Summary Index (byte-offset reads, <5ms search) | Working |
| Ripgrep + BM25 search over JSONL | Working |
| JSONL Session Access (full untruncated data) | Working |
| Post-Research JSONL Consolidation | Working |
| Visual Documents (Mermaid, comparison, analysis) | Working |
| Proactive Conversational Loop | Working |
| Claude OAuth flow (pty) | Working |
| Files Panel + Files Explorer Modal | Working |
| MCP Integration (Smithery cloud proxy) | Working |
| Cloud Sandboxes (self-hosted Daytona) | Working |
| Per-User Claude OAuth (sandbox-side) | Working |
| `waitForToolboxReady` (Daytona race fix) | Working |
| `autoStopInterval: 0` (Daytona disk-fill fix) | Working |
| `killCurrentLLM()` subprocess cleanup | Working |
| Self-healing CWD fallback chain | Working |
| LiveKit Cloud turn detector shim | Working |
| Local/Cloud mode toggle | Working |
| Setup Wizard (6-step in-dashboard) | Working |

## Tech Stack

- **Voice**: LiveKit Agents 1.2.x + `@livekit/rtc-node` 0.13.x
- **Realtime AI**: OpenAI Realtime API / Gemini Live API
- **Coding Agent**: Claude via `@anthropic-ai/claude-agent-sdk` v0.2.91
- **Sub-Agents**: researcher (Sonnet), reasoner (Opus), writer (Sonnet, verify-first)
- **Fast Brain (primary)**: Gemini Flash via `@google/genai` (~1-2s, 1M tokens)
- **Fast Brain (fallback)**: Anthropic Haiku via `@anthropic-ai/sdk`, then Agent SDK
- **Pipeline Fast Brain**: Gemini Flash AFC observer with `search_session`, `get_recent`, `emergency_stop`
- **Search**: bundled `@vscode/ripgrep` + `minisearch` BM25
- **Meeting**: Recall.ai (Zoom / Google Meet bot integration)
- **MCP**: stdio + Smithery cloud via in-process `@smithery/api/mcp` proxy
- **Frontend**: Next.js 14 + React + Tailwind CSS, `react-markdown` + `mermaid` + `highlight.js`
- **Auth**: Supabase SSR (Google + GitHub OAuth)
- **Cloud Sandboxes**: Self-hosted Daytona on Hostinger VPS via raw HTTP
- **Claude OAuth**: `node-pty` interactive `claude setup-token` flow for headless deployments
- **STT**: Deepgram Flux (semantic turn detection)
- **TTS**: Deepgram aura, with OpenAI / ElevenLabs / Gemini options
- **Optional**: `@openai/codex-sdk` (alternative coding agent — wired but not used by default)

## License

MIT
