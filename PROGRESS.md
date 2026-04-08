# Osborn v0.7.0 - Voice AI Research Assistant

## Architecture

Osborn is a voice AI assistant for research and development. It uses LiveKit for real-time voice communication, Claude Agent SDK for research capabilities, and OpenAI/Gemini for native speech-to-speech interaction.

### Three Voice Modes

| Mode | Stack | Best For |
|------|-------|----------|
| **Pipeline** (default) | STT (Deepgram) → Claude Agent SDK + parallel Gemini fast brain → TTS | Full research + fast recall, emergency stop |
| **Direct** | STT (Deepgram) → Claude Agent SDK → TTS (Deepgram) | Full research tasks, maximum tool access |
| **Realtime** | OpenAI Realtime / Gemini Live native speech-to-speech | Fast conversation, voice-first UX, delegates to Claude via `ask_agent` |

### Single Research Mode

No plan/execute/edit mode toggles. The agent operates in a single **research** mode with write safety (Write/Edit blocked outside workspace).

### System Diagram

```
Frontend (Next.js)  ←→  LiveKit Cloud  ←→  Agent (local machine)
                                              ├── Claude Agent SDK v0.2.91 (persistent session)
                                              │   ├── researcher sub-agent (Sonnet)
                                              │   ├── reasoner sub-agent (Opus)
                                              │   └── writer sub-agent (Sonnet)
                                              ├── Pipeline Fast Brain (Gemini Flash observer)
                                              ├── OpenAI/Gemini Realtime (voice)
                                              ├── Recall.ai (meeting bot integration)
                                              └── MCP Servers (GitHub, YouTube, etc.)
```

### Storage Architecture

```
~/.claude/projects/{slug}/           ← Claude's native project folder
  {session-uuid}.jsonl               ← Claude's conversation data (unchanged)
  {session-uuid}/subagents/          ← Sub-agent conversations
  osb/{session-uuid}/                ← Osborn's workspace (NEW in v0.7.0)
    spec.md                          ← Session spec (goals, decisions, findings)
    search-index.txt                 ← Compact summary index for fast search
    search-index-meta.json           ← Index metadata (byte offsets, timestamps)
```

Session picker scans ALL `~/.claude/projects/*/` folders — browse and resume any Claude conversation from any project.

---

## Current Features

| Feature | Status |
|---------|--------|
| Voice interface (LiveKit) | Working |
| OpenAI Realtime voice | Working |
| Gemini Live voice | Working |
| Direct mode (STT → Claude → TTS) | Working |
| Pipeline mode (Claude + Gemini fast brain observer) | Working |
| Persistent session (no per-message JSONL replay) | Working |
| Multi-agent orchestration (researcher/reasoner/writer) | Working |
| Claude Agent SDK v0.2.91 tools | Working |
| Auto-approve workspace writes | Working |
| Permission system (voice + UI, git-style diff viewer) | Working |
| All-projects session scanner (browse all Claude conversations) | Working |
| Session workspace (`~/.claude/projects/{slug}/osb/`) | Working |
| Summary index (byte-offset reads, <5ms search) | Working |
| On-demand session indexing | Working |
| Fast brain (`ask_haiku` — ~2s session-aware Q&A) | Working |
| Pipeline fast brain (Gemini AFC + emergency stop) | Working |
| Teleprompter architecture (fast brain as central orchestrator) | Working |
| Non-blocking research (SDK-managed queuing) | Working |
| Parallel sub-agents (Task tool for concurrent research) | Working |
| Unified voice injection queue | Working |
| Gemini auto-recovery (1008/1011 crash) | Working |
| JSONL session access (full untruncated tool results) | Working |
| Post-research spec consolidation via JSONL | Working |
| MCP server integration (Smithery cloud proxy) | Working |
| Recall.ai meeting bot integration (Zoom/Google Meet) | Working |
| Supabase Auth (Google + GitHub OAuth) | Working |
| Dashboard with recent chats, settings, agent health | Working |
| File attachments (Supabase Storage, inline rendering) | Working |
| Mobile-first responsive UI (amber/charcoal theme) | Working |
| Markdown rendering in chat | Working |
| OAuth token persistence (Fly.io volume) | Working |

---

## Key Files

| File | Purpose |
|------|---------|
| `agent/src/index.ts` | Main entry, room events, session creation, voice queue, HTTP API, data handlers |
| `agent/src/claude-llm.ts` | Claude Agent SDK persistent session wrapper, multi-agent config, write safety |
| `agent/src/pipeline-direct-llm.ts` | Pipeline mode: ClaudeLLM + parallel Gemini fast brain + index watcher |
| `agent/src/pipeline-fastbrain.ts` | Gemini Flash AFC agent with search_session, get_recent, emergency_stop |
| `agent/src/summary-index.ts` | JSONL summary index builder with byte-offset reads (<5ms search) |
| `agent/src/fast-brain.ts` | Central orchestrator: askFastBrain(), research orchestration, spec updates |
| `agent/src/session-access.ts` | JSONL session file reader (15 functions, full untruncated data) |
| `agent/src/prompts.ts` | All prompts centralized (~15 exports) |
| `agent/src/config.ts` | Config, all-projects session scanner, workspace helpers |
| `agent/src/recall-client.ts` | Recall.ai meeting bot integration |
| `agent/src/smithery-proxy.ts` | In-process MCP proxy for Smithery cloud servers |
| `agent/src/voice-io.ts` | STT/TTS/VAD/Realtime model factory |
| `frontend/src/components/VoiceRoom.tsx` | Main UI component (~2000 lines) |
| `frontend/src/app/dashboard/page.tsx` | Recent conversations, settings, agent health |
| `frontend/src/app/chat/page.tsx` | Auto-connect voice chat wrapper |

---

## v0.7.0 Changes — Storage Architecture Refactor: Native Claude Session Integration

### All-Projects Session Scanner
- `listAllClaudeSessions()` scans every `~/.claude/projects/*/` folder for UUID `.jsonl` files
- Returns sessions across ALL Claude Code projects, sorted by most-recently-modified first
- Lightweight metadata via existing `getSessionPreview()` — last user message, message count, cwd
- API endpoint `GET /sessions?limit=N` returns `projectSlug`, `cwd`, `projectPath`, `fileSize`

### Index + Workspace Relocated
- Index output: `~/.claude/projects/{slug}/osb/{sessionId}/search-index.txt` (was `.osborn/sessions/{id}/.index/`)
- Workspace: `~/.claude/projects/{slug}/osb/{sessionId}/` (was `.osborn/sessions/{id}/`)
- Co-located with Claude's native JSONL files
- On-demand indexing: index built when user selects a session, not during picker load

### Library System Removed
- No more `library/` directory or library file management
- `REFINEMENT_PROCESS_SYSTEM` produces spec.md only (was spec + library files)
- `generateVisualDocument()` writes to workspace root
- All library references removed from prompts.ts (~15 sections)

### Files Modified
| File | Changes |
|------|---------|
| `agent/src/config.ts` | `listAllClaudeSessions()`, `getSessionWorkspace()` → new path, `ensureSessionWorkspace()` no library, `listLibraryFiles()` deprecated |
| `agent/src/summary-index.ts` | `getOsbDir()`, updated `buildSummaryIndex`/`getIndexPath`/`readFullContent` paths |
| `agent/src/claude-llm.ts` | Workspace from `getSessionWorkspace()`, write safety checks `/osb/` |
| `agent/src/prompts.ts` | All library/ references removed, workspace path updated |
| `agent/src/fast-brain.ts` | Removed `list_library` tool, library reads/writes, library context |
| `agent/src/pipeline-fastbrain.ts` | Updated `executeSearch`/`getRecentEntries` to use workingDir |
| `agent/src/pipeline-direct-llm.ts` | Updated `buildSummaryIndex`/`startIndexWatcher` calls |
| `agent/src/session-access.ts` | Exported `projectPathToSlug()` |
| `agent/src/index.ts` | All callers updated, `/sessions` uses new scanner |

### v0.6.0 — Multi-User Auth + UI Redesign + File Attachments
See CHANGELOG.md for full details. Highlights: Supabase Auth, dashboard/chat routes, amber/charcoal theme, file attachments, permission modal redesign.

### v0.5.x — Fast Brain + Teleprompter Architecture + Pipeline Mode
See CHANGELOG.md for full details. Highlights: fast brain central orchestrator, pipeline Gemini observer, summary index, persistent sessions, multi-agent orchestration.

---

## Configuration

### Environment Variables (agent/.env)
```env
LIVEKIT_URL=wss://your-livekit-url
LIVEKIT_API_KEY=your-api-key
LIVEKIT_API_SECRET=your-api-secret
OPENAI_API_KEY=your-openai-key
GOOGLE_API_KEY=your-google-key
ANTHROPIC_API_KEY=your-anthropic-key
SMITHERY_API_KEY=your-smithery-key  # Optional, for cloud MCP
```

### Config File (~/.osborn/config.yaml)
```yaml
workingDirectory: /path/to/project
defaultProvider: openai
voiceMode: realtime  # or 'direct'

realtime:
  provider: openai  # or 'gemini'
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

Last Updated: 2026-04-05
