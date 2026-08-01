# Osborn Changelog

## 2026-08 — Meeting brain survives voice-session drops (0.9.119)

- **Decouple the meeting bot's brain from the browser voice session (0.9.119)** — a Recall meeting bot was going permanently DEAF mid-call on any LiveKit participant blip (double-tab, reconnect, engine idle-stop): `handleParticipantDisconnected` called `killCurrentLLM()` → `currentLLM = null`, so `flushMeetingBuffer` no-op'd (`Addressed` fired but never `Flushed`) while the bot stayed in the call. Proven deterministically via synthetic `/webhook/recall` transcript inject. Three fixes in `agent/src/index.ts`: (1) while `activeMeetingBotId` is set, KEEP `currentLLM` alive on participant-disconnect — the 75s leave-grace owns teardown (`endMeeting()` releases the LLM only when the room is truly empty, which was always the design intent per its `!userPresent` branch); don't arm the 20s fast-leave during a meeting (it would destroy the room before the grace). (2) The `tts_say`→meeting redirect now runs BEFORE the `!currentSession` guard, since `speakIntoMeeting` uses Recall `output_audio` and needs no LiveKit session — meeting replies survive a voice-session drop. (3) Arm the meeting leave-grace on abrupt `AgentSession` close (`user_initiated`, no clean ParticipantDisconnected) so a driver tab dying can't orphan the Recall bot draining credits.

## 2026-07 — Meeting copilot, session-engine, voice-e2e product, room-lifecycle hardening (0.9.49–0.9.94)

### Cloud infrastructure & volume architecture
- **Hybrid volume architecture (0.9.49)** — `HOME=/workspace` so the user home (Claude OAuth, sessions, skills, dotfiles, npm cache) persists on the Fly volume, while osborn itself stays in the image (atomic image-swap updates, build toolchain present, no runtime OOM). `NPM_CONFIG_PREFIX=/workspace/.npm-global` + PATH so user `npm install -g` lands on the volume and survives restarts. Zero-movement migration: `HOME=/workspace` makes `~/.claude` resolve to the existing `/workspace/.claude`. `updateOsborn` strips stale `HOME`/`OSBORN_CWD` from existing machine configs so the image default takes effect on update.
- **Heap-OOM fix (0.9.51)** — `killCurrentLLM()` now stops the `PipelineDirectLLM` summary-index watcher (a 10s `setInterval` whose closure retains the entire `PipelineDirectLLM → ClaudeLLM` graph) BEFORE aborting the subprocess. Previously repeated reconnects leaked timers + retained graphs re-reading JSONL every 10s until node OOM'd (~980 MB).
- **Room-presence lifecycle + `/connect-room` & `/leave-room` endpoints (0.9.52)** — the agent LEAVES its LiveKit room when no user is present and rejoins on demand, instead of eager-connecting on boot and holding the room for the machine's life (a single forgotten session burned 25h of connection-minutes). Volume increased to 20 GB; machine-replacement timeout raised to 300s.
- **Idle machine self-stop + zombie-presence watchdog (0.9.73)** — after an intentional alone-leave the agent used to sit idle forever with the Fly machine `started`, billing 24/7 (the "$123 Fly bill fix"). Now `process.exit(0)` after a 10-min idle grace cleanly STOPS the machine (billing stops, volume + JSONL persist); the `on-failure` restart policy boots it on the next Resume. Local dev never exits; override with `OSBORN_IDLE_EXIT=0`.
- **Golden-snapshot / skill-seed refresh** — image-default skills refresh on version bump; added `voice-native-sync`, `ground-assumptions` skills to the seed set.

### Session-sync & ordering
- **Mandatory version check for voice-native-sync skill (0.9.74)** — sync defaults `targetWorkDir` to the machine's own working dir. Stale clients that omitted it wrote source slugs verbatim; those sessions LISTed fine but silently failed to RESUME (SDK resumes at `cwd=workingDir`, whose slug didn't match).
- **Preserve source mtime on file copy (0.9.75)** — `cpSync` stamped copies with "now", scrambling session ordering so the frontend's most-recent-by-mtime auto-resume picked a random file. Now uses `utimesSync` to preserve source mtime.

### Room lifecycle / connection stability
- **Ghost-agent rejoin (0.9.49)** — agent rejoins LiveKit on `RoomEvent.Disconnected` (was going ghost: process alive, room dropped, `/health` falsely reporting `connected`). `checkOsbornHealth` now inspects `livekit.status`.
- **Dual disconnect paths (0.9.58)** — split `disconnect()` (explicit "Leave" → POST `/leave-room`) from `disconnectFromLiveKitLifecycle()` (transient LiveKit drop → do NOT tell agent to leave). Fixes a regression where every LiveKit lifecycle drop made the agent leave the room the user was reconnecting to.
- **Participant-adopt + join-race fix (0.9.76)** — `/connect-room` adopts a user who won the join race (already in the room before the agent rejoined, so `ParticipantConnected` never fired). Zombie-watchdog forced-leave sets `livekitState.status = 'idle'` immediately instead of waiting for the `Disconnected` event.
- **Stable room code (0.9.77)** — room code persisted to `~/.osborn/room-code` (on the volume) so restarts don't rotate the room. Rotation raced clients that fetched `/room-code` just before a restart, stranding them on "Connecting…".
- **Periodic image build checks (0.9.78)**; trimmed whitespace from `FLY_API_TOKEN`/`FLY_SANDBOX_APP`.
- **Leave-room guard (0.9.79)** — `/leave-room` ignored when participants are still in the room, so a stale/racing teardown can't kick the agent out mid-adopt.
- **Event-loss adopter (0.9.80–0.9.81)** — 5s poll re-emits/adopts participants when a participant is present but has no voice session. 0.9.81: the handler is CALLED directly — synthetic `room.emit()` does not reach rtc-node listeners.
- **Temporary rooms (0.9.83)** — a fresh `Room` instance per session (fixes rtc-node `removeAllListeners` deafness on leave/rejoin) plus fast tab-close leave (20s ghost window vs 3min). Frontend mints the LiveKit token from the `roomName` that `/connect-room` returns. Backwards-compatible with older agents.

### Voice / audio quality
- **Echo-prevention & interruption tuning (0.9.59–0.9.72)** — bumped `@livekit/*` 1.2.1→1.4.6, `rtc-node` 0.13.24→0.13.29; added `aecWarmupDuration`; refined `falseInterruptionTimeout`/`minDuration`/`minWords`. TTS stall mitigations (0.9.61). Gemini model → `2.5-flash` with adjusted interrupt handling (0.9.67). Extensive audio/agent-state observability logging (0.9.63, 0.9.68, 0.9.71). Idle-timeout tuning (0.9.64–0.9.65).

### Meeting copilot
- **Live meeting transcript via Recall (0.9.84)** — restored live transcript using Recall `realtime_endpoints` webhooks; the batch `download_url` only populates post-meeting.
- **Meeting cast via `output_media` (0.9.85)** — display a webpage as the bot's camera in the meeting. Off by default (silent invisible observer).
- **Accept `partial_data` transcripts (0.9.86)** — low-latency streaming emits partials during the call (finals lag); old code dropped all partials → no live transcript. Now accepts partials with dedup + logs every Recall webhook receipt.
- **Meeting canvas + task ledger + blank-page fix (0.9.87)** — a single `/meeting-canvas` page becomes the bot's camera, mic (plays TTS), and ears; connects to `GET /canvas-stream` (SSE) with `say`/`show` commands and resyncs its visual on reconnect. Cast target defaults to the meeting canvas pointed at the agent's own public URL.
- **Writer-subagent delegation + `/tts` audio into meeting (0.9.89)** — the `meetings` skill delegates ALL file/transcript work to the `writer` sub-agent in one `Task` call, because the main orchestrator's hard 3-tool-call budget blocks doing it directly.
- **Live transcript buffering → LLM (0.9.92)** — buffered webhook finals drained on a 20s flush timer into `currentLLM.chat()` tagged `[MEETING — <botId>]`.
- **Meeting interruption support (0.9.93)** — a human's `speech_on` while the bot's TTS is playing triggers an immediate `{ kind: 'stop' }` canvas event; the cut-off text + who interrupted is prepended to the next flush.

### Session-engine (director-controlled browser)
- **Persistent director-controlled browser + live-stream + tabs (0.9.84+)** — `tests/voice-e2e/scripts/session-engine.ts` maintains one long-lived browser session; live CDP screencast → MJPEG on the Fly machine's public URL; multi-tab helpers; canvas mock/smoke harness.

### voice-e2e as a distributable product (0.9.82+)
- **Versioned self-updating skill** served from `/api/test-skill` (+ `/bundle` harness file bundle, baked at build time to `public/voice-e2e-bundle.json`), notify-first update check, and a landing page with a copy-paste agent install message.
- **Harness**: scenario runner, reactive mic, element ears, DevTools sense, supervisor flight-log channel, step cache, action visualizer, live browser stream, MANDATORY media-review step. Playwright trace disabled (trace.zip truncates on self-closed CDP browser).
- **Bring-your-own-browser** (`VOICE_E2E_BROWSER_URL`: local launch / long-lived Chrome-Docker CDP / Browserless / Browserbase).
- Packaged agent skills now versioned and shipped on every machine.

### Frontend / misc
- **Bug reporting system (0.9.55)** — API + Supabase schema (`003_bug_reports.sql`), reachable from VoiceRoom.
- **Skills explorer** — view skill content, two-click remove, one-tap official-catalog install; agent `skill_get`/`skill_remove` protocol.
- **Auto-detect cloud mode** on first dashboard visit for accounts with a cloud instance.
- **Inline meeting-join input** replacing the fragile `prompt()`.
- Seeded `ground-assumptions` skill; reframed to architectural-fit (0.9.50).

## 2026-06-01 — Volume-as-HOME architecture (post 0.9.47)

Replaces the legacy `/workspace/.claude` symlink architecture with `HOME=/workspace/home`,
making the entire user home directory persist on the Fly volume — Claude OAuth, gh
tokens, ssh keys, git config, npm cache, skills, sessions, osborn config all survive
image-swap upgrades.

### Architecture decision

Multi-round design exploration considered three approaches:

| Approach | Result |
|---|---|
| **Chroot + bind-mounts** | Built + verified working (2026-05-28). Real A/B test showed equivalent runtime behavior with ~100 LOC of bind-mount complexity. Retired. |
| **Pre-warm machine pool** | Subagent verification found ~400-500 LOC refactor + Fly env-PATCH triggers machine replacement, defeating "instant claim" benefit. Deferred. |
| **HOME-on-volume (chosen)** | Set `HOME=/workspace/home` in Dockerfile ENV. Every HOME-respecting tool persists. Simplest entrypoint (~165 LOC). |

### Key findings from real Fly A/B (2026-05-28)

- Boot time: chroot 102s vs no-chroot 111s — within 5s polling noise
- EBUSY on `umount /workspace` at shutdown: 8 errors in BOTH variants (not caused by chroot — osborn's cwd=/workspace alone holds the mount)
- Persistence: both pass for `~/.osborn/config.yaml`, `~/.config/gh/`, etc.
- Image size identical (~1.4 GB on Fly)

Per `ld.so(8)`, the Linux dynamic linker is mount-agnostic — binaries on the volume can link against libraries from the image without any chroot. So chroot was solving a non-problem (it never solved a "library access" issue we feared); the only thing it actually solved was HOME persistence, which `HOME=/workspace/home` solves with no bind-mount overhead.

### Companion changes shipping in this batch

- `agent/Dockerfile.sandbox` — Option D (no-chroot, HOME-on-volume) entrypoint
- `frontend/src/lib/machines.ts` — `createSandbox` accepts optional `sourceSnapshotId` for golden-snapshot fast-start
- `frontend/src/app/api/sandbox/route.ts` — provider-dispatched `createSandbox` call; reads `FLY_GOLDEN_SNAPSHOT_ID` env for new-user provisioning
- `frontend/scripts/bake-golden-snapshot.mjs` — CI script to produce a "golden state" volume snapshot for fast new-user provisioning (~15-20s vs ~60-90s first-boot)
- Skill seed-version refresh — `agent/Dockerfile.sandbox` now refreshes image-default skills when osborn version bumps (was: skip-if-exists, locked old content forever)
- `~/.claude/skills/ground-assumptions/SKILL.md` — new skill enforcing test-first hypothesis verification during planning (already deployed to live machine `osborn-1b9d70e5-2a4`)

### Archive

The chroot-based Dockerfile.sandbox is preserved at `docs/archive/Dockerfile.sandbox.chroot-2026-05-28.md` for reference. Includes the full bind-mount entrypoint, first-boot seed logic, and legacy fallback path. Useful if Fly mount semantics ever change or if a future requirement actually needs `/etc` and `/opt` on the volume.

## What Was Working

### Voice Providers
- **OpenAI Realtime**: Working (greeting, transcription, tool calls)
- **Gemini Live**: Was working before multi-agent refactor

### Known Issues (Current)

1. **Gemini idle timeout**: Gemini Live API crashes with WebSocket code 1008 ("BidiGenerateContent session not found") every ~2 hours when no user interaction. Auto-recovery handles it, but loops endlessly if user is away — each recovery creates a new session that times out again.

2. **Gemini `interrupt()` causes state hang**: Calling `session.interrupt()` on Gemini disrupts its internal state machine — model gets stuck in `speaking` state and never transitions back to `listening`. All `interrupt()` calls must be guarded with `if (currentProvider !== 'gemini')`.

3. **Room code not passed correctly** ✅ FIXED in v0.1.3
   - Use: `npm run room <code>` or `npm run dev -- --room <code>`

4. **OpenAI permission speech conflicts** ✅ FIXED in v0.1.3
   - Was: `conversation_already_has_active_response` errors
   - Fix: Track actual agent state, only speak when `listening`

5. **Gemini not responding** ✅ FIXED in v0.1.3
   - Reverted to exact model name from working commit: `gemini-2.5-flash-native-audio-preview-12-2025`
   - Removed experimental options (proactivity, enableAffectiveDialog) that broke it
   - **Note**: If Gemini appears unresponsive, restart the agent - usually a stale session issue, not a bug

## Version History

### v0.9.43 → v0.9.46 (May 22–27, 2026) — Meeting Polling Architecture, LiveKit Retry Resilience, Sandbox Log Capture

Four interrelated changes shipped over this window, plus several diagnostics added. The unifying theme: replace fragile "must-be-running, must-be-connected" code paths with resilient ones that survive transient failures and surface real diagnostic signals.

Agent bumps: `0.9.43 → 0.9.46`. Dockerfile.sandbox: image rebuild required (entrypoint changed).

#### Meeting bot architecture rewrite — LiveKit/WebSocket pipeline replaced with REST polling (agent 0.9.44)

The previous design republished meeting audio through LiveKit (Recall WebSocket → agent → AudioSource → LocalAudioTrack publish into the same room as the user). It worked but produced echo (feedback loop when the meeting-bot page re-played the agent's own re-publish), required a separate frontend `/meeting-bot` page + bot-token mint endpoint, and conflated meeting STT with voice-native STT.

The rewrite is polling-only:
- **Agent joins meeting via Recall** with no `output_media` and no `realtime_endpoints` — just `recording_config.transcript.provider.recallai_streaming` so Recall transcribes. Visible in the meeting as "Osborn" by name only, silent.
- **New `MeetingTranscriptPoller`** (`agent/src/meeting-transcript-poller.ts`) — fires every 30s, fetches `GET /api/v1/bot/{bot_id}` from `us-west-2.recall.ai`, walks `recordings[0].media_shortcuts.transcript.data.download_url` (pre-signed S3 URL), downloads the JSON, dedups via first-word `start_timestamp.relative` cursor, pushes new turns to `currentLLM.chat()` as `[MEETING — botId]:\n<Speaker>: text\n...`. Bounded retry-safe; returns `[]` cleanly when `recordings[0]` doesn't exist yet (bot still joining, pre-recording).
- **New `meetings` skill** (`agent/.claude/skills/meetings/SKILL.md` — 6 kB) teaches the agent two patterns: (1) auto-tagged `[MEETING — *]:` messages → DO NOT speak, maintain `meeting-todos.md` in the session workspace, optionally trigger silent research; (2) explicit user requests ("grab the meeting transcripts", "compile the todos", etc.) → use Bash + curl to pull on demand. The skill embeds the exact 2-step API chain + the critical us-west-2 region (not the SDK default).
- **Frontend meeting notes panel** in `VoiceRoom.tsx` — surfaces `meeting-todos.md` content automatically via the existing `research_artifact_updated` → `research_artifact_content` protocol when the agent writes the file. Visible while a meeting is joined or any content exists; cleared on next join.
- **Tear-out** (~250 lines from `agent/src/index.ts`): `/meeting-audio-in` WebSocket handler, `/meeting-output` HTTP route, `meetingOutputWss` / `meetingAudioInWss`, `sendToMeetingOutput` / `synthesizeForMeeting` helpers, `activeAgentSession` / `preMeetingUserIdentity` / `waitForRoomIOAndParticipant` (B2 setParticipant switching). Frontend `/meeting-bot/page.tsx` + `/api/meeting-bot-token/route.ts` deleted. `agent/src/meeting-output.html` deleted. `package.json` build script no longer copies the HTML to `dist/`.

Verified end-to-end against a real meeting: agent joined, wrote initial skeleton to `meeting-todos.md`, frontend panel rendered live. Transcript fetch verified by curl from inside the sprite — `https://us-west-2.recall.ai/api/v1/bot/{id}` returns the recording chain; the documented `/bot/{id}/transcript` convenience endpoint does NOT exist (404), so `getTranscript()` in `recall-client.ts` walks the documented `recordings[0].media_shortcuts.transcript.data.download_url` path.

**Files**: `agent/src/index.ts` (delete LiveKit pipeline + add join handler poller wire-up + system injection on bot join), `agent/src/meeting-transcript-poller.ts` (new), `agent/src/recall-client.ts` (drop `audio_separate_raw` + `output_media`, add `getTranscript()` that walks the right chain), `agent/.claude/skills/meetings/SKILL.md` (new), `frontend/src/components/VoiceRoom.tsx` (panel + state + reset).

#### LiveKit `room.connect` retry resilience — no more restart loops (agent 0.9.45)

A LiveKit 429 ("connection minutes limit exceeded") was crashing the agent with `process.exit(1)`. Fly's machine restart policy retried 3 times, then killed the machine. Frontend `/api/sandbox` saw the machine as failed, bounced the user to dashboard with no useful error. Worse: every failed restart kicked off a fresh `room.connect` attempt — burning more failed-but-not-counted requests at LiveKit.

- **No more `process.exit(1)` on connect failure** — `room.connect` is now wrapped in bounded-backoff retry: `5s → 10s → 20s → 40s → 60s (cap)`, infinite attempts. When LiveKit recovers (quota reset, key fixed, outage ends), the next retry succeeds and the agent picks up where it left off without a manual restart.
- **`/health` always returns 200** — Fly's machine health-check stays green so the container isn't restart-looped while LiveKit is unreachable. The HTTP path keeps working (`/sessions`, `/events`, future endpoints).
- **`/health` JSON now includes a `livekit` block**: `{ status, error, errorCode, attemptCount, lastAttemptAt }`. `errorCode` categorized as `quota_exceeded` / `auth` / `network` / `unknown` by substring-matching the error message. Frontend can surface a real error message to the user instead of a generic "stuck on connecting".
- **Module-level `livekitState`** at the top of `agent/src/index.ts` is the source of truth; both `main()`'s retry loop and `startApiServer`'s `/health` handler read it.

Verified in production: confirmed via fly logs that 0.9.45+ machines hit the retry loop on persistent 401 ("invalid token") errors and stayed alive for 17.8 hours, racking up 1074 retry attempts without crashing. Before this fix the same failure would have killed the machine within 90 seconds.

**Files**: `agent/src/index.ts` (module-level state, `connectWithRetry()`, /health response shape).

**Lesson**: every long-running service that depends on an external connection should distinguish between "the connection failed once" (retry) and "the service is dead" (crash). The default `try/await/catch+exit` pattern conflates them. Fly's machine restart policy then turns one transient failure into an infinite loop.

#### Compaction event bridge — was silently a no-op in pipeline mode (agent 0.9.44)

The SDK's `PreCompact` + `PostCompact` hooks ran fine and the agent wrote crystallized skills to disk correctly — but **none of the events ever reached the frontend** in pipeline mode. The user could see `🧠 PostCompact: complete — N skill file(s) written` in fly logs but the inline chat bubble (`🧠 _Crystallizing session memory…_` / `🧠 Memory crystallized — N skill(s) updated`) never appeared.

Root cause: `createPipelineDirectLLM(opts)` constructed its inner `new ClaudeLLM(opts)`. Pipeline mode never passed `onCompactionEvent`, so the inner ClaudeLLM had no listener. When `createDirectSession(resumeSessionId, pipelineLLM)` was called with the pre-built LLM, the `createClaudeLLM({...onCompactionEvent: ...})` block was skipped — it's behind a `llmOverride || ...` short-circuit. The `PreCompact` / `PostCompact` hooks fired, called `this.#opts.onCompactionEvent?.(...)`, the optional-chaining no-op'd, events died silently inside the agent process.

- **Extracted `buildOnCompactionEvent()` helper** in `agent/src/index.ts` so direct / realtime / pipeline all use the same callback (no more drift between three inline copies).
- **Pipeline mode now passes the callback** to `createPipelineDirectLLM`.
- **Added redundant SDK iterator listener** — the SDK also emits `type:'system', subtype:'compact_boundary'` (with `compact_metadata.trigger` + `pre_tokens`) and `type:'system', subtype:'status', status:'compacting'|null` independently of hook registration. Logged as `[COMPACT-SDK-ITER]` markers so if hooks ever silently misfire, the iterator path catches it. Verified by reading `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` — `HOOK_EVENTS` includes both `"PreCompact"` and `"PostCompact"`, and the iterator's `SDKCompactBoundaryMessage` + `SDKStatusMessage` shapes are documented in the same file.
- **Diagnostic logging at every hop** so the next person debugging this can see exactly where events live or die:
  - Agent: `[COMPACT-AGENT-RX]` (bridge received), `[COMPACT-AGENT-RAW-SENT]` (raw event over data channel), `[COMPACT-AGENT-CHAT-EMIT]` (inline bubble emitted), `[COMPACT-AGENT-CHAT-SKIP]` (progress events skip the chat bubble), `[COMPACT-AGENT-ERROR]`
  - Frontend: `[COMPACT-FRONTEND-RX]` (raw event arrived → banner update), `[COMPACT-FRONTEND-BUBBLE]` (compaction bubble added to chat)

**Files**: `agent/src/index.ts` (helper extraction + pipeline wiring + SDK iterator log), `frontend/src/components/VoiceRoom.tsx` (handler logging).

#### Sandbox disconnect-log upload was always 39 bytes of the same 404 error (frontend, agent Dockerfile)

`ChatSessionProvider.tsx` correctly fires `fetch-log` → `save-log` on disconnect, and the Supabase upload succeeded for every session — but every single log file was identical: 39 bytes, eTag `00ba5d83de42c9f21e31b06c8ec2c33d`, content `"Logs API error 404: 404 page not found\n"`.

Root cause: `execInSprite()` (the Fly Machines variant of the function that fetches log content) was calling `${FLY_API_BASE}/v1/apps/{app}/machines/{id}/logs?limit=500` — but **that REST endpoint doesn't exist on Fly Machines**. `flyctl logs` uses a NATS-based streaming path; there's no REST equivalent. Every call 404'd and the error string itself got returned as "the log content" and dutifully uploaded.

Confirmed by listing the Supabase bucket and downloading the most recent upload — verified the actual 39-byte payload. Also confirmed by directly curling `/v1/apps/.../machines/.../logs` against Fly's API — 404.

- **Dockerfile entrypoint now tees stdout/stderr to `/workspace/osborn.log`** (volume-backed, survives reboots). Switched shebang `#!/bin/sh` → `#!/bin/bash` so `exec > >(tee -a "$LOGFILE") 2>&1` works (process substitution requires bash). `flyctl logs` continues to work — the file is in ADDITION to Fly's stdout collector, not in place of it.
- **100 MB size cap** with 50 MB tail retention on boot — prevents disk fill from long retry loops.
- **`execInSprite()` rewritten** to call the real `/exec` endpoint with `tail -n 500 /workspace/osborn.log`. Returns descriptive "log not readable; sprite likely on older image" error if the file doesn't exist (forensic signal that the entrypoint Dockerfile hasn't been re-baked yet on a given sprite).
- **Dockerfiles synced** — `agent/Dockerfile.sandbox` is canonical; the prebuild script `frontend/scripts/copy-sandbox-dockerfile.mjs` refreshes `frontend/Dockerfile.sandbox` on every Railway build.

To deploy this fix the sandbox image must be rebuilt (the Dockerfile change won't reach sprites via `npm publish` alone — needs `flyctl deploy --build-only --push` against `fly-sandbox.toml`).

**Files**: `agent/Dockerfile.sandbox` (entrypoint), `frontend/Dockerfile.sandbox` (synced), `frontend/src/lib/machines.ts` (`execInSprite` body).

**Lesson**: a silently-uploading-garbage pipeline is harder to diagnose than a failing one. The 200 OK on upload + the consistent file size masked the real failure for weeks. Always inspect at least one of the artifacts you're producing as part of acceptance testing.

#### Fly Machines update flow — fixed 412 race during config-replace (frontend)

`updateOsborn()` was stopping the machine, PATCHing config with a new image, then calling `/wait?state=started` (HTTP 400 — Fly's wait endpoint rejects when the post-replace target state is ambiguous), falling through to `startSandbox` which hit `412 failed_precondition: machine getting replaced`. Result: every update to a stopped machine bounced through `replacing` → 400 → 412 → image-swap fallback that actually did succeed but the dashboard reported "stuck" until the fallback completed.

- **New `waitForReplacementComplete()` helper** polls `GET /machines/{id}` every 2s until `state` leaves `'replacing'` / `'creating'`. Returns the settled state (typically `stopped`).
- **`updateOsbornImpl` now**: stop → PATCH image → wait for replacement to settle → `startSandbox` (now safe to call). No more `/wait?state=started` 400.

**Files**: `frontend/src/lib/machines.ts` (`waitForReplacementComplete` helper + `updateOsbornImpl` flow rewrite).

#### Cleanup: legacy `osborn-agent` Fly app destroyed

22-day-uptime ghost from the pre-sprite architecture. Container running `node --import tsx/esm src/index.ts` (dev-style, from source), pointing at a third LiveKit project (`osborn-live-agent-kkjwjvfr`) separate from both the current production project and the new one we tested. Had LiveKit secrets stored, was idle (no active outbound TCP connections at audit time) but had been connected for an unknown portion of the 22 days. Destroyed (stop machine → delete machine → delete app) as part of fleet hygiene during this session's LiveKit quota investigation.

#### Operational learnings

- **Fly Machines does NOT expose a REST endpoint for machine logs.** The endpoint at `/v1/apps/.../machines/.../logs` returns 404. To capture logs for offline analysis, write to a persistent volume + read via `/exec`.
- **`process.exit(1)` on a recoverable failure is almost always wrong** in a service managed by a restart policy. Conflates "operation failed" with "process is dead". Replace with bounded-backoff retry, surface state via health endpoint.
- **SDK iterator messages are redundant with hooks** for compaction events. If hooks misregister, the iterator-stream messages (`subtype:'compact_boundary'`, `subtype:'status'`) are the fallback signal — log them to make registration failures visible.
- **Recall.ai stores transcripts under `retention: 'forever'`** by default. Post-meeting transcript pulls work indefinitely. The pre-signed S3 download URL in `recordings[0].media_shortcuts.transcript.data.download_url` expires ~6h after issue — re-fetch the bot record to get a fresh URL.
- **LiveKit Cloud free tier appears to share a connection-minute cap across projects on the same billing account.** Confirmed empirically: switching `LIVEKIT_URL` from one project to another on the same account still hit 429 immediately. Plan upgrade is the only path; spinning up a third project doesn't help.

---

### v0.8.30 → v0.8.38 (May 1–2, 2026) — Sprites Stability: Naming, Warm-Wake, Bootstrap, Recall

A long debugging night uncovered four independent layered bugs in the cloud-sprites flow. All shipped fixes are surgical (existing code paths preserved for legacy users).

Frontend bumps: `0.8.30 → 0.8.38`. Agent bumps: `0.8.30 → 0.8.35`.

#### Sprites gateway "stuck routing" per-sprite-name (frontend 0.8.38)
- **Problem**: `findUserSandbox` and `createSandbox` derived a deterministic sprite name from `userId.substring(0,12)` (e.g. `osborn-1b9d70e5-2a4`). After a sprite under that name failed registration, Sprites' API gateway kept returning 503 to `PUT /services/<name>/services/osborn` from Railway's egress IP **even after the sprite was deleted and recreated under the same name**. Identical PUTs from a different IP (local dev machine) succeeded against the same sprite. Sprite-side platform logs showed ZERO incoming service-registration requests during the 503 window, meaning the 503 originated upstream of the sprite. We never reproduced the trigger but the symptom is sticky-per-name.
- **Fix**: New `generateUniqueSpriteName(userId)` appends a base36 timestamp suffix (e.g. `osborn-1b9d70e5-2a4-lszt8q`). Each `createSandbox` call gets a fresh name, escaping any stuck gateway entry. `findUserSandbox` now accepts an optional `knownSandboxId` parameter — caller (`/api/sandbox/route.ts`) reads it from Supabase first. Falls back to the legacy deterministic name when Supabase has no record (legacy users / first-time provision lookup).
- **Files**: `frontend/src/lib/sprites.ts` (new helper + signature change), `frontend/src/app/api/sandbox/route.ts` (small `getKnownSandboxId()` helper, all 5 callers updated to pass it).

#### CRIU warm-wake leaves agent's LiveKit WebSocket as a "ghost" (frontend 0.8.38)
- **Problem**: When a sprite hibernates (CRIU snapshot), the agent process is frozen mid-execution. LiveKit Cloud's server-side WebSocket times out, evicts the agent from the room, and forgets it ever existed. When the user reconnects via chat, frontend hits `/health` — the sprite's HTTP server thaws, but **only the HTTP path runs**. The agent's event loop stays paused. From the agent's in-memory state it's still "Connected to room", but LiveKit has long since evicted it. User publishes audio + video to the right room name; agent never sees them. Stuck on connecting forever.
- **Why this only started showing recently**: Commit `b9eb3e5` ("skip checkpoint restore when marker bootstrap exists") was the right call for data preservation — restoring on every wake was wiping the container overlay (OAuth credentials, session JSONLs). But it removed an accidental side-effect: restore used to spin up a fresh agent process, which got a fresh LiveKit WebSocket. With restore skipped, no fresh process, no fresh WebSocket.
- **Fix**: When `startSandbox()` sees a sprite that was **warm AND has marker bootstrap**, restart the service (`stop+start` via Sprites API). This kills + restarts only the agent process — overlay is preserved (no re-auth, no lost JSONLs), bootstrap re-runs and skips install (marker matches), agent boots fresh, fresh LiveKit WebSocket. Best of both worlds.
- **Files**: `frontend/src/lib/sprites.ts` — new `else if (spriteWasWarm && bootstrapHasMarker)` branch in step 4 of `startSandbox`.
- **Lesson**: CRIU snapshot can preserve a TCP socket's local state but the peer (LiveKit Cloud) doesn't know to keep its end. Future-proof fix is an agent-side LiveKit reconnect watchdog (not yet implemented).

#### Silent 503 → destructive checkpoint restore (frontend 0.8.37)
- **Problem**: `startSandbox()` had `let bootstrapHasMarker = false` followed by a bare catch on the `GET /services/osborn` request. When Sprites' API was 503-flaky, the catch fired silently, the boolean stayed `false`, and code proceeded to `restoreCheckpoint()` — wiping the writable overlay including `.credentials.json` (Claude OAuth) and any session JSONLs. Symptoms: re-auth prompts every reconnect, missing past conversations, 60–100s `startSandbox` runs that exceeded Railway's request timeout (returning 502/503 to the browser as "stuck on connecting").
- **Fix**: Track `serviceCheckSucceeded` separately. Restore only fires when we have **positive confirmation** that the service genuinely lacks marker logic — never when the API call to determine that just transiently failed. The catch now logs the actual error so the path is observable.
- **Files**: `frontend/src/lib/sprites.ts` — three-way branch in `startSandbox()` Step 2 (skip-on-uncertainty / has-marker-skip / clean-restore).
- **Lesson preserved in code**: Never restore on uncertainty. Restore is destructive; treat it like `rm -rf`.

#### Sprite naming + Supabase as source-of-truth (frontend 0.8.38)
- **Coordinated change** with the unique-name fix above. Pre-change architecture used `findUserSandbox(userId)` which derived the name deterministically and used that as the lookup key. Post-change: `findUserSandbox(userId, knownSandboxId?)` takes the Supabase-stored ID as the source of truth. Deterministic name is fallback only.
- **Why both changes are needed together**: If you only added `generateUniqueSpriteName` without the Supabase lookup, the next `findUserSandbox` call would generate a different name and not find the sprite that was just created. If you only added the Supabase lookup without unique names, you'd still hit the stuck-gateway issue on the same name.

#### Recall.ai bot payload field corrections (agent 0.8.34)
- **Problem**: `joinMeeting()` sent `recording_config: { transcript: true }` and `output_media: { camera: { type: 'webpage' } }`. Recall API rejected with 400: `"recording_config.transcript: Expected a dictionary, but got bool"` and `"output_media.camera.kind: Invalid choice null. Expected 'webpage' or 'default'."` Bot creation failed entirely; no botId returned; meeting feature was completely broken.
- **Fix**: Removed `transcript: true` (the `transcription_options` block below already configures the provider, making the flag redundant). Renamed `camera.type` → `camera.kind`.
- **Files**: `agent/src/recall-client.ts`.

#### `meeting-output.html` path resolution (agent 0.8.35)
- **Problem**: The `/meeting-output` HTTP handler used `join(process.cwd(), 'src', 'meeting-output.html')`. In local dev (`npm run dev` from `agent/`), cwd IS `agent/` so the path resolved fine. In cloud, cwd is `/home/sprite/workspace` (per `OSBORN_CWD`), so the file was 404. Visible to the user as the bot's video tile in Google Meet showing "html not found" instead of the configured webpage. Bot was technically in the meeting but completely useless.
- **Fix**: Resolve via ESM `__dirname` (`fileURLToPath(import.meta.url)` + `dirname`). Try three candidates in order: `dist/meeting-output.html` (production, post-build), `../src/meeting-output.html` (dev with tsx running compiled JS), `../meeting-output.html` (tsx run from src). Build script extended to `cp src/meeting-output.html dist/` so the file ships with the npm package.
- **Files**: `agent/src/index.ts` (`__dirname` + 3-candidate path resolution), `agent/package.json` (build script + version bump).
- **Lesson**: `process.cwd()` is the user's launch directory. Files-shipped-with-the-package should always resolve via `__dirname`, never cwd.

#### Bootstrap inventory log + persistent-disk consistency check (frontend 0.8.37)
- **Diagnostic** rather than a fix. The bootstrap now emits per-project JSONL counts at boot (visible via Sprites' service-logs API). The frontend `/api/sandbox?action=consistency-check` endpoint cross-references the persistent-disk JSONL count (via fs API) against what the running container reports via `/sessions`. A dashboard banner surfaces the mismatch.
- **Why**: Sprites uses CRIU + an overlay-style filesystem. The fs API reads the persistent disk; the container reads through the overlay. They can desync (most painfully when a checkpoint restore rolls the overlay back to a stale base). When that happens, "old session JSONLs" are still on disk but invisible to the running agent. Detection saves users from assuming data is lost.
- **Files**: `frontend/src/lib/sprites.ts` (helpers + bootstrap logging), `frontend/src/app/api/sandbox/route.ts` (new action), `frontend/src/app/dashboard/page.tsx` (banner UI).

#### Two-click delete confirmation + Restart button visibility (frontend 0.8.37)
- **Delete confirmation**: First click on the trash icon arms it (button turns red, label changes to `⚠ Confirm delete?`); second click within 4s actually deletes; auto-disarms otherwise. Critical because **Sprites does not soft-delete** (verified by probing 6 different undelete endpoint shapes — all 404). Once deleted: overlay, persistent disk, all checkpoints unrecoverable.
- **Restart button visibility**: Was gated on `agentOnline === true`. The dashboard's browser-side `/health` poll can fail to see a healthy agent during warm-wake (server-side health passes; browser polling races the warm thaw), which used to hide the Restart button exactly when the user needs it. Now visible whenever `isCloud && sandboxId && !operation` — same condition as the version badge.

#### Operational learnings
- **Sprites' "last 5 checkpoints mounted at /.sprite/checkpoints/"** advertised in `/.sprite/llm.txt` was empty in our testing. The user's session JSONLs from a wiped-overlay sprite were recoverable via `pre-restore-vN-{ts}` checkpoints (Sprites' auto-snapshots taken before each restore call). Recovery requires full checkpoint restore — there's no API to copy files OUT of a checkpoint without restoring it.
- **`PUT /services/osborn` is a no-op when the cmd matches**. Returns 200 with body `"Service already running with that command, use POST .../restart"`. Safe to retry. Different cmd requires `STOP + DELETE + PUT` cycle.
- **Sprites API gateway routing**: per-sprite-name routing entries can get stuck. Confirmed by sprite-side request logs showing zero forwards during the 503 window from Railway, and identical requests from another IP succeeding immediately. The `generateUniqueSpriteName` workaround sidesteps this entirely.

---

### v0.8.6 — Subprocess Cleanup, Self-Healing CWD, Daytona Toolbox Race Fix

#### `killCurrentLLM()` — fix orphaned Claude subprocess on disconnect
- **Problem**: The persistent ClaudeLLM session is deliberately kept alive across user messages to avoid JSONL replay (see CLAUDE.md "Persistent Session Architecture"). When the participant disconnected, the existing cleanup just nulled `currentLLM` — but that only dropped the JS reference. The underlying Claude Code subprocess kept draining the `MessageChannel`, running tools, capturing checkpoints, and pushing TTS into a now-null voice session. Visible in logs as repeated `⚠️ tts_say fired but currentSession is null — text dropped` followed by orphaned `🔧 Claude: Bash` calls and `📍 Checkpoint captured` lines that nobody was listening to. Wasted compute, wasted tokens, possible side effects on the user's filesystem from a "completed" session.
- **Fix**: New `killCurrentLLM(reason)` helper that duck-types `abortQuery()` (on `ClaudeLLM`) or `abortAgent()` (on `PipelineDirectLLM`). Both call into `closeSession()` which kills the subprocess via the SDK's `query.close()`. Wired into all 3 cleanup sites: `RoomEvent.Disconnected`, the previous-session cleanup branch when a new participant joins while an old session lingers, and the `ParticipantDisconnected` handler.
- **Files**: `agent/src/index.ts` — `killCurrentLLM()` definition + 3 call sites.

#### Self-healing CWD fallback chain
- **Problem**: `defaultWorkingDir` blindly trusted whatever `OSBORN_CWD` env var was set, even if the path didn't exist. Cloud sandboxes provisioned with the old `OSBORN_CWD=/root/workspace` had `/root` as `drwx------` (unreadable to non-root) and the directory itself never created. When osborn passed that as `cwd` to the SDK's `child_process.spawn(node, [cli.js], { cwd })`, spawn errored ENOENT and the SDK reported the misleading `Claude Code executable not found at .../cli.js` error. Same shape would bite local users who edited `config.workingDirectory` to a deleted path.
- **Fix**: `main()` now walks `[OSBORN_CWD env, config.workingDirectory, process.cwd()]` in priority order and picks the FIRST entry whose path actually exists on disk via `existsSync`. `process.cwd()` is the ultimate safety net (it always exists by definition). Skipped candidates are logged with the reason so misconfiguration is visible.
- **Lesson preserved in code**: When you see "Claude Code executable not found" in any SDK context, FIRST check `process.env.OSBORN_CWD` and whether that path exists/is readable. The error message lies about what's missing.
- **Files**: `agent/src/index.ts` — `main()` cwd resolution.
- **Version bump**: agent → 0.8.6.

#### Daytona toolbox-proxy race fix (`waitForToolboxReady()`)
- **Problem**: Daytona's metadata API (`GET /api/sandbox/{id}`) flips the `state` field to `started` BEFORE its toolbox reverse-proxy has resolved the container's IP. If you immediately call `process/execute` after seeing `state: started`, the toolbox returns `400 "failed to resolve container IP after 3 attempts: no IP address found. Is the Sandbox started?"` and `execInSandbox()` throws. Race window is typically 2–6 seconds wide on a warm runner.
- **Symptom**: dashboard Resume appearing to "work" (state flips to running) while the chat page hangs on `/room-code` with 502 Bad Gateway. The supervisor exec to launch osborn was firing inside the race window, silently failing, and leaving the container running with NOTHING bound on port 8741.
- **Fix**: `waitForToolboxReady(sandboxId)` polls `echo ready` via `process/execute` (5s timeout each attempt, up to 15 attempts × 2s wait). Called from both `createSandbox()` (after state flips to `started`) and `startSandbox()` (after Resume triggers a new start). If the toolbox is already routing, the first attempt returns in ~200ms; if we're mid-race, it waits up to ~30s for the proxy to come online.
- **Files**: `frontend/src/lib/daytona.ts` — `waitForToolboxReady()` definition + 2 call sites.

#### Daytona supervisor wrapper removed (avoid hanging on restart requests)
- **Problem (subtle)**: An attempt to wrap osborn in `bash -c 'while true; do osborn; done'` for auto-restart introduced a fatal regression: the bash process inherits the toolbox `process/execute` stdout/stderr pipe and never closes it. Daytona's endpoint waits indefinitely for the pipe to close before returning, the Next.js fetch hangs for the full undici 5-minute headers timeout (`UND_ERR_HEADERS_TIMEOUT`), and `startSandbox()` returns null with the misleading "fetch failed" message. The deployed Stop/Resume flow was completely broken from this exact bug for as long as the supervisor wrapper existed — Resume click hangs forever, refresh shows "running", connecting to `/room-code` 502s.
- **Why**: When osborn is the immediate child of `nohup`, Node properly closes the inherited stdio fds when it sets up its own logging. The toolbox sees the close and `process/execute` returns in ~2s instead of ~5min.
- **Trade-off**: No auto-restart on osborn's `process.exit()` self-exit path. That self-exit is a separate bug from a LiveKit publisher timeout — should be fixed in osborn (don't self-exit when no process manager exists), not papered over with a wrapper that breaks startup.
- **Big in-code comment**: Added to both `createSandbox()` and `startSandbox()` so the next person who tries to add a supervisor loop will SEE this and reconsider.
- **Files**: `frontend/src/lib/daytona.ts`.

#### `autoStopInterval: 0` — defuse Daytona disk-fill bug
- **Problem**: Self-hosted Daytona has a chronic backup-system bug. Every auto-stop triggers a `CREATE_BACKUP` job that races a `STOP_SANDBOX` job. The stop wins (millisecond commit vs second commit), leaving the backup with `context canceled` (verifiable in `docker logs daytona-runner-1` — search for "Backup canceled for container"). Compounding that, the few backups that DO win the race are accumulated forever: `backup.manager.ts` has 4 cron jobs that CREATE backups but ZERO crons that delete them. `deleteBackupImageFromRegistry()` (`docker-registry.service.ts:710`) is dead code with no callers anywhere in the repo.
- **Damage**: Hit 100/100 GB on Hostinger after one day of debug, with 9 historical backups of a single sandbox eating 38 GB. Recovery required SSH + manual `docker exec daytona-runner-1 docker image prune -af` + registry garbage-collect.
- **Fix (defense in depth)**:
  1. `autoStopInterval: 0` in `createSandbox()` — sandboxes don't auto-stop, so backup cycles only fire when the user explicitly stops. Big in-code comment warns the next person not to re-enable.
  2. `/etc/cron.daily/daytona-backup-prune` on the VPS keeps the latest 2 backups per sandbox, runs registry GC.
- **Trade-off**: Sandboxes stay running until explicitly stopped. On self-hosted Hostinger this costs zero (already paid for) and improves UX. When/if scaling to many real users on shared infra, re-enable auto-stop AFTER patching `backup.manager.ts` to delete old backups.
- **Files**: `frontend/src/lib/daytona.ts`.

#### `workingDirectory` parameter forwarded through session handling
- **Problem**: Frontend metadata included a `workingDirectory` field that the agent silently ignored. Sessions booted in whatever the agent's startup CWD was, not what the user selected.
- **Fix**: `ParticipantConnected` handler reads `metadata.workingDirectory` and overrides `workingDir` for the duration of the session. New connections without the field reset to `defaultWorkingDir`.
- **Files**: `agent/src/index.ts`.

---

### v0.8.5 — Mixed-Content Handling + Public Origin Resolution

#### Public origin resolution for OAuth redirects
- **Problem**: OAuth callbacks (Google, GitHub) redirected to whatever the request `host` was — broke when the frontend sat behind a proxy or had a public domain different from the internal host.
- **Fix**: New helper resolves the public origin from `X-Forwarded-Proto` + `X-Forwarded-Host` headers (with `host` fallback) so OAuth flows redirect back to the public URL.

#### Mixed-content fixes in Chat and Dashboard
- HTTPS frontend connecting to a `http://localhost:8741` agent triggered Chrome mixed-content blocks. Updated Chat and Dashboard pages to detect mixed-content scenarios and show a clear error message instead of failing silently.
- Added an icon SVG for the dashboard.

---

### v0.8.4 — Daytona Sandbox Provisioning + File Attachments + Permission Diff Viewer

#### Daytona sandbox provisioning
- Initial wiring of `frontend/src/lib/daytona.ts`, `frontend/src/app/api/sandbox/route.ts`, and the `connectionMode` localStorage toggle in dashboard settings.
- See v0.8.3 for the full provisioning + fix history; v0.8.4 was the first version that landed it as a feature.

#### File attachments with inline image rendering
- New `MessageContent` component supports inline images and file attachments in chat messages. Images render as `<img>` tags, files as download cards.
- Storage bucket renamed from `osborn-uploads` to `osborn-storage`.

#### Permission modal: collapsible git-style diff viewer
- `diff` + `diff2html` rendering for Write/Edit/MultiEdit permission requests. Collapsible diff hunks, line numbers, addition/deletion counts.

---

### v0.8.3 — Per-User Cloud Sandboxes (Self-Hosted Daytona, original entry)

#### Cloud Sandbox Provisioning
- **Self-hosted Daytona on Hostinger VPS**: `daytona.voice-native.com` (KVM 2, ~$11/mo all-in). Caddy-fronted HTTPS via Let's Encrypt, on-demand TLS for sandbox subdomains
- **`frontend/src/lib/daytona.ts`**: Server-only sandbox provisioning library. Uses raw HTTP (bypasses buggy `@daytonaio/sdk`). Functions: `createSandbox`, `findUserSandbox`, `startSandbox`, `stopSandbox`, `keepAliveSandbox`, `deleteSandbox`
- **`/api/sandbox` route**: Next.js endpoint for create/list/start/stop/delete + keepalive ping. Backed by Supabase auth — each user gets exactly one sandbox labeled with their `userId`
- **Provisioning steps**: create sandbox (image: `node:22`) → poll for `started` → `sudo env PATH=... npm install -g osborn @anthropic-ai/claude-code` → symlink `node`/`osborn`/`claude` into `/usr/local/bin` → start agent as root via `sudo -E setsid nohup` → wait for `:8741/health` 200
- **Auto-stop / archive**: 15min idle → auto-stop ($0 compute, fs preserved). 7 days stopped → auto-archive to MinIO. Keepalive ping every 5min while user is connected
- **Idle disconnect**: Chat page auto-disconnects after 20min of no user activity (preserves usage)

#### Per-User Claude OAuth (No Shared API Key)
- **OAuth flow inside sandbox**: First user message in a fresh sandbox triggers `claude setup-token` pty inside the sandbox. Auth URL surfaces via data channel → user opens it, pastes code back → token persists at `/home/daytona/.claude/.credentials.json`
- **Token persistence across stop/resume**: Sandbox filesystem survives auto-stop, so the OAuth token persists indefinitely. Only re-auth needed if the credentials file is deleted or expires
- **`HOME=/home/daytona` for root context**: osborn runs as root via `sudo -E` but `HOME` is forced to `/home/daytona` so OAuth credentials land in the same place across user/root contexts

#### Local vs Cloud Mode Toggle
- **`connectionMode` localStorage key**: Dashboard settings let user choose `local` or `cloud`. Persisted in `localStorage['osborn-connection-mode']`
- **Chat page respects mode**: Only fetches `/api/sandbox` and resolves cloud preview URL when `connectionMode === 'cloud'`. In local mode, uses `agentUrl` query param / localStorage as-is. Fixes a bug where local mode was unconditionally using the cloud sandbox if one existed

#### Sandbox Provisioning Fixes
- **`OSBORN_CWD` bug**: Was injecting `OSBORN_CWD=/root/workspace` into the sandbox env, but `/root/workspace` doesn't exist (and `/root` is `drwx------` so unreadable). The Claude SDK does `child_process.spawn(node, [cli.js], { cwd })` — when cwd doesn't exist, spawn errors ENOENT and the SDK reports it as the misleading `Claude Code executable not found at .../cli.js`. Fixed: `OSBORN_CWD=/home/daytona/workspace` to match the directory we `mkdir -p` and `cd` into when launching osborn
- **`/usr/local/bin` symlinks**: Symlink `node`/`osborn`/`claude` into `/usr/local/bin` during provisioning so they're in every user's default PATH (including root's). Convenience for interactive shells and any subprocess that does PATH-based lookup without inheriting nvm's bin dir
- **osborn runs as root**: Earlier attempt to run as `daytona` user hit EACCES on `child_process.spawn`. Run as root via `sudo -E setsid nohup env HOME=/home/daytona PATH=/usr/local/nvm/versions/node/v22.14.0/bin:$PATH osborn` — `-E` preserves env vars, `HOME` forced for OAuth persistence
- **`sudo` strips PATH workaround**: All install/start commands explicitly preserve PATH via `sudo env PATH=/usr/local/nvm/versions/node/v22.14.0/bin:$PATH ...`. Without this, `npm`, `node`, `osborn` aren't found because nvm's bin dir isn't in root's default PATH
- **`setsid nohup ... & disown`**: Plain `nohup ... &` doesn't survive the toolbox `executeCommand` returning. Need `setsid` to detach from controlling terminal AND `disown` to detach from the parent shell

#### Daytona SDK Workarounds
- **`@daytonaio/sdk` bypassed entirely** — multiple bugs with self-hosted: `daytona.list/create/get` throw on undefined fields; SDK uses `envVars`/`region`, API expects **`env`/`target`**; toolbox URL differs (`:4000` cloud vs `/toolbox` path self-hosted); `list()` returns `[]` self-hosted but `{items: []}` cloud
- **Raw HTTP only**: `daytona.ts` uses `fetch` directly with the documented field names. Toolbox proxy detection: HTTPS uses `/toolbox` path, HTTP falls back to `:4000` port

#### Outstanding Issues
- **Chrome `ERR_CERTIFICATE_TRANSPARENCY_REQUIRED` on sandbox subdomains**: Some browsers cache CT enforcement state for `*.daytona.voice-native.com` and reject Caddy's on-demand certs. Mitigations under discussion: wildcard cert via DNS-01, Cloudflare proxy in front of Caddy, or moving to a CT-logged CA path. See `DAYTONA-SETUP.md` troubleshooting section

---

### v0.7.0 — Storage Architecture Refactor: Native Claude Session Integration

#### All-Projects Session Scanner
- **`listAllClaudeSessions()`**: Scans every `~/.claude/projects/*/` folder for UUID `.jsonl` files. Returns sessions across ALL Claude Code projects on the machine, sorted by most-recently-modified first
- **Lightweight metadata**: For each session, reads first line for `cwd` and tail for last user message via existing `getSessionPreview()`. No full-file parsing for initial picker
- **`GET /sessions?limit=N`**: API endpoint now returns sessions from all projects with `projectSlug`, `cwd`, `projectPath`, `fileSize` fields
- **Data channel**: `agent_ready` and `list_sessions` responses include project metadata so frontend can group/filter by project

#### Index Output Relocated
- **New path**: `~/.claude/projects/{slug}/osb/{sessionId}/search-index.txt` (was `.osborn/sessions/{id}/.index/`)
- **Co-located with Claude's data**: Index files live alongside the native JSONL files they index
- **`getOsbDir()`**: New helper in `summary-index.ts` computes the osb directory from session ID + working directory
- **On-demand indexing**: Index built when user selects a specific session, not during initial picker load

#### Session Workspace Relocated
- **New path**: `~/.claude/projects/{slug}/osb/{sessionId}/` (was `.osborn/sessions/{id}/`)
- **`getSessionWorkspace()`**: Now computes path from `workingDir` (project slug) instead of `sessionBaseDir`
- **`ensureSessionWorkspace()`**: Creates dir + spec.md only (no more `library/` directory)
- **Write safety updated**: `canUseTool` and `PreToolUse` hook check `/osb/` in path (plus backward compat with `.osborn/sessions/`)

#### Library System Removed
- **No more `library/` directory**: Research artifacts no longer written to per-session library folders
- **`listLibraryFiles()`**: Returns empty array (deprecated)
- **`REFINEMENT_PROCESS_SYSTEM`**: Now produces spec.md only (was spec + 1-3 library files)
- **`generateVisualDocument()`**: Writes to workspace root instead of `library/` subfolder
- **`fast-brain.ts`**: Removed `list_library` tool, library read/write logic, library context from all functions
- **`prompts.ts`**: All `library/` references removed from ~15 prompt sections (system prompts, write rules, tool descriptions, audience definitions)

#### Backward Compatibility
- Existing `.osborn/sessions/` folders remain in place — no migration needed, old sessions just won't appear in new picker
- Write safety still allows `.osborn/sessions/` and `.osborn/research/` paths for any lingering references
- `sessionBaseDir` parameters kept as deprecated optional args to avoid breaking callers

---

### v0.6.0 — Multi-User Auth + UI Redesign + File Attachments

#### Supabase Authentication & Multi-User Foundation
- **Google + GitHub OAuth**: `signInWithProvider()` via Supabase Auth, callback at `/auth/callback`
- **Database schema**: `instances` (user→server mapping), `agent_sessions`, `always_allow_paths` with RLS policies
- **Instance API**: `GET/POST /api/instance` — stores user's agent server URL + LiveKit room
- **Middleware**: Session refresh with 2s timeout to avoid blocking page loads
- **Supabase clients**: `supabase-server.ts` (API routes) + `supabase-browser.ts` (client components)

#### New Route Architecture
- **`/` (landing)**: Login page with Google/GitHub OAuth + guest "Connect without account". Authenticated users auto-redirect to `/dashboard`
- **`/dashboard`**: Recent conversations list with pagination (20 per page), agent health indicator (online/offline), settings panel (agent URL, voice mode, provider), user avatar + sign out
- **`/chat`**: Auto-connects to agent on mount, wraps VoiceRoom. Disconnect → back to `/dashboard`
- **No room codes**: Manual room code entry removed. Auto-connect flow via agent `/room-code` endpoint

#### UI Redesign — Mobile-First
- **Design system**: Amber/gold (`#d4a853`) on deep charcoal (`#0c0b09`). CSS variables for consistency (`--accent`, `--surface`, `--border`, `--text-*`)
- **Typography**: DM Sans (body) + JetBrains Mono (code) via `next/font/google`
- **VoiceRoom mobile fixes**: `h-[100dvh]` viewport, avatars hidden on mobile (`hidden sm:flex`), compact header (`px-2`), single-column suggestion grid, files/meeting/copy/ControlMenu hidden on mobile
- **Mobile menu drawer**: Hamburger button → slide-up drawer with Files, Copy, Meeting, Sessions, Disconnect
- **VoiceVisualizer**: Hidden when not speaking (empty gray box removed). Compact `h-8 w-16` on mobile
- **Color unification**: All violet/purple/blue replaced with amber across VoiceRoom (bubbles, buttons, indicators, gradients)

#### File Attachments
- **Supabase Storage**: Bucket `osborn-storage` for image/file uploads. Public URLs sent via data channel
- **`user_text` handler**: Now processes `data.files` array — appends `[Image: name](url)` or `[File: name]\ncontent` to message before `generateReply`
- **MessageContent component**: Renders images inline (`<img>` with click-to-open) and non-image files as styled download cards with file icon
- **Upload error handling**: Shows system message on failure with guidance to create storage bucket

#### Permission Modal Redesign
- **Line numbers**: Diff viewer parses `@@` hunk headers to show line numbers in gutter
- **Addition/deletion counts**: Header shows "N additions, M deletions"
- **Responsive**: Slides up from bottom on mobile (sheet-style), centered card on desktop
- **Sticky buttons**: Deny/Allow/Always fixed at bottom, diff content scrolls above
- **Expand/collapse**: Full-width button with chevron, shows remaining line count
- **Dismiss button**: Auth modal and error dialogs now have X close button

#### Chat Cards Dashboard
- **Session cards**: Elevated card design with chat icon, message preview (2-line clamp), timestamp, message count badge
- **Pagination**: Shows 20 at a time, "Show more (N remaining)" button
- **Staggered animation**: Cards fade in with delay

#### Auth Modal
- **Dismissable**: X button added to Claude Authentication modal (no longer blocks chat)
- **Auto-close on error**: Auth errors auto-dismiss after 5 seconds

---

### v0.5.5 — Persistent Session + Multi-Agent Orchestration + SDK v0.2.91

#### Persistent Session Architecture
- **No per-message JSONL replay**: `query()` called with `AsyncIterable<SDKUserMessage>` — subprocess stays alive between messages
- **`MessageChannel<T>` class**: Pushable async iterable feeding user messages to the persistent subprocess via stdin
- **`#startBackgroundConsumer()`**: Long-running `for await` loop routing SDK events (assistant text, tool use, checkpoints) to TTS and frontend
- **Control operations**: `persistentQuery.interrupt()` (graceful Esc, subprocess stays alive), `closeSession()` (kills subprocess), `rewindFiles()` (file checkpointing)
- **First message**: Cold start (JSONL replay). Subsequent messages: instant push (no replay)

#### Multi-Agent Orchestration
- **Sonnet orchestrator**: Main agent delegates to three named sub-agents via Task tool
- **`researcher`** (Sonnet): Information gathering — codebase, web, multi-file exploration. Read-only.
- **`reasoner`** (Opus): Deep thinking — architecture decisions, tradeoffs, implementation planning. Read-only.
- **`writer`** (Sonnet): Verify-first execution — check assumptions → clarify → execute → verify (run tests/build). Full write access.
- **`agent_type` in PreToolUse**: Writer agent (`agent_type === 'writer'`) gets full write access. All others restricted to workspace. `MultiEdit` now included in check.
- **Prompt enforcement**: Hard limit of 2-3 direct tool calls per turn; Bash/Write/Edit restricted to writer sub-agent

#### Claude Agent SDK Upgrade (v0.1.76 → v0.2.91)
- `@anthropic-ai/claude-agent-sdk` 0.1.76 → 0.2.91 (persistent query, `agentProgressSummaries`, background Task support)
- `@anthropic-ai/sdk` 0.52 → 0.80
- `@modelcontextprotocol/sdk` 1.26 → 1.29
- `zod` 3 → 4 (backward-compatible for existing usage)
- V2 `SDKSessionOptions` now includes `canUseTool`, `hooks`, `allowedTools`, `permissionMode`

#### Recall.ai Meeting Integration
- **`recall-client.ts`**: New file — `RecallClient` class for joining Zoom/Google Meet as a bot
- **`meeting-output.html`**: New file — Output Media webpage for bot audio (WebSocket client)
- **Webhook route**: `POST /webhook/recall` in HTTP server receives real-time transcripts
- **Transcript routing**: Meeting speech routed to Claude via data channel as `[Meeting — Speaker]: text`
- **Frontend UI**: Join Meeting button with joining/joined/error states, leave meeting support

#### Voice Pipeline Changes
- **TTS provider**: Switched from Deepgram (`aura-2-asteria-en`) to OpenAI (`tts-1`, voice `fable`) — note: HTTP streaming, throws `APIUserAbortError` on interrupt
- **Recovery interval**: `MIN_RECOVERY_INTERVAL` reduced from 10s to 3s for faster crash recovery
- **STT endpointing**: Deepgram set to 550ms (was 25ms default) to reduce mid-sentence fragment commits
- **Deepgram Flux STT**: Semantic turn detection with `eotThreshold=0.85`, `eotTimeoutMs=3000`

#### Authentication Flow
- **Token capture**: `claude setup-token` output parsed for `sk-ant-oat01-*` token after "created successfully"
- **Token persistence**: Written to `~/.claude/.oauth-token` (simple file) and `~/.claude/.credentials.json` for volume persistence
- **Startup restore**: `ensureClaudeAuth()` checks `~/.claude/.oauth-token` before prompting for interactive auth

#### Fast Brain Timeout
- `TIMEOUT_MS` increased from 15s to 30s to handle large JSONL replay on session resume

---

### v0.5.1 — JSONL-Based Spec Consolidation + Prompt Extraction + Question Tracking

#### Centralized Prompts
- **`prompts.ts`**: All system prompts extracted from inline strings into dedicated module (9 exports)
- Source files import from `prompts.ts` — single place to review and update all prompts

#### JSONL Session Access
- **`session-access.ts`**: 14 exported functions for reading Claude Agent SDK JSONL session files
- Reads FULL untruncated tool results, agent reasoning, sub-agent transcripts
- All functions accept optional `SessionAccessOptions` with `claudeDir` override

#### Content Pipeline → JSONL Reads
- **Deleted**: `contentBuffer[]`, `scheduleContentProcess()`, `contentProcessTimer` — entire parallel content capture pipeline removed
- **New**: `updateSpecFromJSONL()` reads FULL data from JSONL on research completion (30 tool results, 50 assistant messages, all sub-agent findings)
- No more truncation — models get complete tool outputs instead of 400-800 char snippets
- Sub-agent findings now included via `getSubagentTranscripts()` (previously missed entirely)

#### Fast Brain JSONL Tools
- `read_agent_results` and `read_agent_text` tools — fast brain can read agent JSONL during active research
- Multi-strategy JSON parser (`parseChunkResponse`) handles code blocks, control chars, raw markdown

#### New Spec Template
- Sections: Goal, User Context, Open Questions (From User / From Agent), Decisions, Findings & Resources, Plan
- Bidirectional question tracking with checkbox format
- Designed as portable research output

#### Fast-Brain-First Routing
- `CRITICAL ROUTING RULE` enforces `ask_haiku` before any non-trivial response
- Structured response types for fast brain → realtime LLM communication

---

### v0.5.0 — Fast Brain: Three-Tier Intelligence

#### Fast Brain (`fast-brain.ts`)
- **New middle tier**: ~2s responses via direct Anthropic/Gemini API calls
- **Auth chain**: `ANTHROPIC_API_KEY` → `ANTHROPIC_AUTH_TOKEN` → Gemini Flash fallback
- **Tool loop**: `read_file`, `write_file`, `list_library`, `web_search`
- **`ask_haiku` tool**: Registered on realtime model, injects live research context during active research
- **Post-research hook**: `updateSpecFromResearch()` consolidates findings into spec.md

#### Four-Tier Intelligence
1. Conversational (instant) → 2. `read_spec` (instant) → 3. `ask_haiku` (~2s) → 4. `ask_agent` (5-15s)

#### Spec Ownership Change
- Research agent reads spec for context but does NOT write to it
- Fast brain handles all spec.md and library/ maintenance
- `spec-agent.ts` deleted — replaced by `fast-brain.ts`

---

### v0.4.9 — Remove Research Blocking, Parallel Sub-Agents, Fix False Completions

#### Research Blocking Removed
- **No more manual task queuing**: Removed `if (activeResearch)` blocking guard in `ask_agent` — new research tasks go directly to the Claude SDK instead of waiting in `pendingResearchTask`
- **SDK handles queuing internally**: The Claude Agent SDK manages sequential queries via session resume — no need for our own queue on top
- **Listener cleanup**: Old research event listeners are cleaned up before starting a new task to prevent duplicate handlers
- **Removed**: `pendingResearchTask` variable, chaining logic in `.then()`, all 5 cleanup references

#### Parallel Sub-Agents
- **System prompt guidance**: Research agent is now instructed to use the `Task` tool for parallel work — spawn multiple sub-agents in the same response for independent research (e.g., researching 3 technologies simultaneously)
- **Sub-agent tools**: Read, Glob, Grep, Bash, WebSearch, WebFetch — all available to Task sub-agents
- **No code changes needed**: `Task` was already in `RESEARCH_TOOLS` — this is prompt guidance so the agent actually uses it for parallelism

#### False Completion Announcements Fixed
- **Root cause**: `[RESEARCH UPDATE]` injections were spoken by Gemini as "research complete" even though the SDK was still running tools — the voice model interpreted batch content as final findings
- **Fix**: Update prompt changed to `[RESEARCH UPDATE — STILL IN PROGRESS]` with explicit instructions: "This research is NOT finished yet — do NOT say complete, done, or finished. Say what's happening NOW"
- **Result**: Voice model now says "I'm looking into..." or "The agent is reading..." instead of false completions

#### Files Modified
| File | Changes |
|------|---------|
| `agent/src/index.ts` | Removed blocking guard + `pendingResearchTask`, cleanup old listeners in `executeResearch()`, fixed update prompt |
| `agent/src/claude-llm.ts` | Added `PARALLEL SUB-AGENTS` section to research system prompt |

---

### v0.4.8 — Strict Write Rules, Auto-Approve, Recovery Context

#### Write Safety
- **Strict file writing prompt**: System prompt `FILE WRITING — STRICT RULES` section: always use full absolute workspace path, read spec.md before editing, never hallucinate paths/writes
- **Auto-approve workspace writes**: `canUseTool` auto-approves `Write`/`Edit` to `.osborn/sessions/` or `.osborn/research/` — no permission prompt for workspace files
- **Auto-deny plan mode tools**: `canUseTool` auto-denies `EnterPlanMode`/`ExitPlanMode` — research agent should never enter plan mode
- **Removed writer sub-agent**: Tested but caused permission blocking, extra latency, and voice queue crashes

#### Anti-Hallucination
- **Code-specific delegation rule**: Realtime prompt rule #7: when the user asks about specific code details (variable names, line numbers, function signatures), MUST delegate to `ask_agent` — never guess

#### Auto-Recovery Context Injection
- **Conversation history preserved on crash recovery**: After Gemini 1011/1008 crash and auto-recovery, the new session now receives conversation context via `buildContextBriefing()` — loads last 10 exchanges from session history and injects as `[SESSION RECOVERED]` prompt
- **Previously**: New session started blank, user had to manually paste conversation history
- **Now**: Gemini model knows what was discussed before the crash and can continue naturally

#### Files Modified
| File | Changes |
|------|---------|
| `agent/src/claude-llm.ts` | Strict write prompt, auto-approve workspace writes, auto-deny plan mode in `canUseTool` |
| `agent/src/index.ts` | Recovery context injection via `buildContextBriefing()`, anti-hallucination rule #7 for code details |

---

### v0.4.6 — Gemini Research Relay: Anti-Hallucination, Task Queuing, Voice Queue Fix

#### Anti-Hallucination Prompts
- **Generalized fact-fidelity rules**: Removed tech-specific examples ("TypeScript/Python/Django") that Gemini treated as style hints rather than constraints. Replaced with universal rules: "only state facts from findings, don't add from your own knowledge"
- Updated across 4 prompt locations: `[RESEARCH COMPLETE]` injection, anti-hallucination rules, research complete handling guidance, notifications quick-ref

#### Follow-Up Research Task Queuing (Replaced in v0.4.9)
- **`pendingResearchTask` queue**: When research is already running, follow-up `ask_agent` calls store the task instead of rejecting. After current research completes, queued task auto-executes with 2s delay. *Note: Replaced in v0.4.9 — blocking removed entirely, SDK handles queuing internally.*
- **`executeResearch()` extraction**: Core research logic extracted from `ask_agent` execute body into a named function
- **SDK auto-context**: Claude Agent SDK auto-resumes via `sessionId` — follow-up tasks inherit all prior research context without manual session management

#### Voice Queue Flooding Fix
- **`isProcessingQueue` guard**: Prevents concurrent `generateReply` calls. Cleared on every `agent_state_changed` event
- **30s safety timeout**: If `agent_state_changed` never fires (e.g. Gemini state machine hang), clears the guard and retries the queue
- **Drop-not-requeue**: On `generateReply` error, items are dropped instead of re-queued — prevents infinite retry cascades. Frontend still has updates via `claude_output` events
- **8s research batch debounce** (was 3s): Reduces voice queue flooding during active research
- **3-update cap per task**: `voiceUpdateCount` limits voice injections per research task — prevents chatty updates on long research
- **500ms queue retry delay** (was 50ms): Longer settle time after model enters `listening` state

#### Enriched Research Updates
- **`onToolUse` includes parameters**: "Reading config.ts", "Running: ls -la", "Searching for 'pinecone' in files", "Fetching content from github.com" — instead of generic "Using Read"
- **`onToolResult` no longer doubles**: Removed from `pendingUpdates` — eliminates "Reading config.ts. Read completed." pairs in voice updates
- **MCP tool formatting**: `mcp__youtube__search` → "Using youtube: search"

#### Gemini interrupt() Constraint
- `interrupt()` kept Gemini-guarded in both `processVoiceQueue()` and `user_text` handler — re-enabling causes Gemini's state machine to hang in `speaking` state indefinitely

---

### v0.4.5 — Gemini 1008 Crash Fix + Auto-Recovery

#### Root Cause
Gemini Live API (`gemini-2.5-flash-native-audio-preview-12-2025`) crashes with WebSocket code 1008 during user interruptions + tool calls. SDK marks code 1008 as `retryable: false`, `recoverable: false` — kills the session with no auto-reconnect.

#### Fixes
- **Skip `interrupt()` for Gemini**: `processVoiceQueue()` and `user_text` handler guard with `if (currentProvider !== 'gemini')`. Gemini handles interruptions internally via `activityStart`/`activityEnd`
- **Auto-recovery**: `wireSessionEvents()` extracted from `ParticipantConnected`. On session close with `reason === 'error'`, automatically recreates realtime session, re-wires events, starts new session, notifies user via voice. `lastRecoveryTime` guard prevents loops (10s minimum between recoveries)
- **Skip `updateChatCtx` for Gemini**: `injectIntoChatCtx()` and `loadSessionHistoryIntoChatCtx()` skip when `currentProvider === 'gemini'` — Gemini doesn't support `updateChatCtx` (crashes with 1008)
- **`generateReply({ instructions })` not `userInput`**: All session resume paths use `instructions` parameter to avoid `updateChatCtx` calls
- **LiveKit SDK update**: Packages 1.0.31→1.0.45, rtc-node 0.13.22→0.13.24

---

### v0.4.4 — Full-Width UI, File Explorer Persistence, MCP Proxy Fix

#### UI Layout Overhaul
- **Full-width layout**: Removed `max-w-2xl` constraint from `page.tsx` and `max-w-3xl` default from `VoiceRoom.tsx`. UI now uses full viewport width (`max-w-[90rem]`)
- **Files panel always visible**: `showFilesPanel` defaults to `true`. Panel shows "No files yet" empty state when no artifacts exist. Toggle button always visible (not gated on file count)
- **Code block rendering fix**: `MarkdownMessage.tsx` `CodeBlock` now accepts `React.ReactNode` children instead of `String()` — fixes `[object Object]` rendering when `rehype-highlight` transforms code into syntax-highlighted `<span>` elements. Added `extractText()` helper for copy button plain text extraction

#### File Explorer Session Persistence
- **Workspace artifact loading on resume**: When resuming/switching sessions, the agent scans `.osborn/sessions/` for existing files and sends them to frontend via new `session_artifacts` event
- **All resume paths covered**: Artifact emission added to 4 code paths — `session_selected` (session gate), `resume_session`, `continue_session`, `switch_session`
- **New `listWorkspaceArtifacts()`**: Scans flat `.osborn/sessions/` directory (where Claude actually writes) instead of per-session subdirectory. Recursive — includes `library/` contents
- **New `get_session_artifacts` handler**: Frontend can request artifacts on demand
- **File clearing on session switch**: `generatedFiles` and `selectedFilePath` reset before loading new session's artifacts
- **Content lazy-loading**: Only metadata sent initially; content fetched on-demand when file is selected

#### Smithery MCP Proxy Reconnection Fix
- **Fixed "Already connected to a transport" error**: On second `query()` call, the SDK tried to reconnect the proxy `McpServer` which threw. Proxy now patches both `McpServer.connect()` and inner `Server._server.connect()` to auto-close existing transport before accepting a new one
- **YouTube MCP confirmed working**: 7 tools discovered and used natively across multiple queries

#### Data Channel Protocol
- **New events**: `session_artifacts` (Agent → Frontend), `get_session_artifacts` (Frontend → Agent)

---

### v0.4.3 — Unified Voice Injection Queue + Specificity Prompts
- **Unified voice injection queue**: ALL system injections (`[RESEARCH UPDATE]`, `[RESEARCH COMPLETE]`, notifications, errors) go through a single `voiceQueue[]` gated by `agentState === 'listening'`. Eliminates `generateReply timed out` errors caused by calling `generateReply` while the model is busy.
- **State-machine driven processing**: `processVoiceQueue()` only fires when model is `listening`. After calling `generateReply`, model naturally transitions to `thinking/speaking` → `listening`, which triggers the next batch. No timers, no `drainInFlight` guards, no deferred one-shot listeners.
- **Batched voice injections**: Multiple queued items (e.g. 3 research updates + 1 completion) are combined into a single `generateReply` call, reducing model interruptions.
- **Research event batching**: `scheduleResearchBatch()` debounces rapid tool events (3s), formats them as a single `[RESEARCH UPDATE]`, and pushes to the voice queue.
- **Specificity prompts**: `[RESEARCH COMPLETE]` injection now mandates naming specific tools, packages, numbers, and URLs — no more vague "various tools" summaries. Adaptive verbosity defaults research results to DETAILED (6-10 sentences).
- **Removed**: `drainResearchQueue()`, `scheduleDrain()`, `drainDebounceTimer`, `drainInFlight`, immediate/deferred dual injection paths, `.catch()` workarounds on `generateReply` return values.

---

### v0.4.2 — Non-Blocking Research + Live Progress
- **Non-blocking `ask_agent`**: Tool returns immediately, runs Claude research in background
- **Queue-based progress injection**: Research events (tool_use, tool_result, assistant_text) push to `pendingUpdates` queue; drains when voice model enters `listening` state via `agent_state_changed` event
- **`[RESEARCH UPDATE]` injections**: Batched progress sent to realtime voice model via `generateReply({ instructions, toolChoice: 'none' })` — model speaks natural status updates
- **`[RESEARCH COMPLETE]` injection**: Final results with research log injected when research finishes; deferred to next `listening` state if model is busy
- **Frontend visibility**: Progress drains and final results emit `claude_output` events with `agentRole: 'research-progress'` for chat panel visibility
- **`activeResearch` guard**: Prevents concurrent research tasks; cleaned up on disconnect/reconnect

---

### v0.4.1 — Voice UX Fixes
- **Double summarization fix**: `ask_agent` return value increased from 500 → 2500 chars with sentence-boundary truncation
- **Research log batching**: tool_use/tool_result/assistant_text events collected during execution, appended as `[RESEARCH LOG]` to tool return
- **Adaptive verbosity**: Realtime prompt guidance: BRIEF (1-3 sentences), STANDARD (3-6), DETAILED (6-10), FULL (all details)
- **Streaming research text**: `assistant_text` events wired to frontend as `claude_output` during `ask_agent`
- **Session workspace paths**: Full Claude session UUID instead of 8-char truncation (`.osborn/sessions/<full-uuid>/`)
- **Smithery proxy reconnection**: Patch covers both `McpServer.connect` and inner `Server._server.connect`

---

### v0.4.0 — Research Mode Refactor (Phase 1a)
- **Removed plan/execute/edit mode system**: ~200 lines of enforcement code deleted
- **Single research mode**: `RESEARCH_TOOLS` array replaces `PLAN_TOOLS`/`EDIT_TOOLS`/`DEFAULT_ALLOWED_TOOLS`
- **Simplified PreToolUse hook**: ~10 lines, only blocks Write/Edit outside `.osborn/sessions/` and `.osborn/research/`
- **Session workspace**: `.osborn/sessions/<id>/` with `spec.md` + `library/` structure
- **Always-on systemPrompt**: Research mode instructions injected via Claude SDK `systemPrompt` field
- **Frontend cleanup**: Removed Mode tab, Execute button, AgentModeState — static "Research" label
- **Data channel cleanup**: Removed `agent_mode_changed`, `edit_mode_changed`, `toggle_agent_mode`, `approve_plan`, `reject_plan`

---

### v0.3.0 — Enhanced Plan Mode
- **`PLAN_TOOLS`** replaces `READ_ONLY_TOOLS`: includes Write, Edit, Bash (filtered by PreToolUse hook)
- **Path filtering**: Write/Edit only to `.osborn/research/` and `.claude/plans/`
- **Bash deny-list**: Blocks destructive commands (rm, npm install, git push), allows read-only (ls, git log, cat)
- **`permissionMode: 'default'`**: Fixed from `'plan'` which blocked ALL tools
- **Research directory**: Per-session at `.osborn/research/<session-id-prefix>/`
- **Unified Files panel**: `GeneratedFile` replaces `PlanFile` — shows both plans and research artifacts
- **Claude SDK `systemPrompt`**: Plan mode injects write rules and artifact creation guidance

---

### v0.2.2
**Frontend Updates & Agent Intelligence**

#### Frontend Fixes
- **Fixed assistant messages not displaying**: Messages were being received but content wasn't rendering due to aggressive markdown parsing stripping content
- **Improved message parsing**: Conservative approach to parsing - only removes explicit reasoning blocks, preserves all other content
- **Better duplicate detection**: Tracks last 5 messages per role instead of just the last one
- **Added status_update handler**: Frontend now displays background task status updates
- **Debug logging**: Added comprehensive logging throughout message pipeline for troubleshooting

#### Agent Improvements
- **Internet access awareness**: Agent now knows it has full internet access for web search, fetching URLs, and API calls
- **Fixed task ID tracking**: Status manager now uses brain's task IDs to prevent ID mismatch between systems
- **Added registerTask()**: New method to register tasks with specific IDs from brain
- **Source tracking**: All messages now include source field for debugging (tool_result, direct_command, research_complete, etc.)
- **System status messages**: Shows "Running: ...", "Researching: ...", "Executing: ..." progress updates
- **No markdown in speech**: Updated instructions to prevent Gemini from adding **bold** headers in voice responses

---

### v0.2.1
**Bug Fixes & UI Improvements**

#### Bug Fixes
- **Fixed Claude Agent SDK warmup error**: Improved warmup prompt from minimal `'ready'` to proper instruction, with graceful error handling
- **Fixed agent speech not appearing in chat**: Added `playout_completed` event handler for Gemini realtime mode
- **Fixed user transcript not sending**: Added `input_speech_stopped` fallback handler for accumulated transcripts
- **Fixed mute button missing**: Added mute/unmute toggle button with microphone icons
- **Fixed button visibility**: Restructured header layout with compact visualizer (h-12 w-24)

#### UI Improvements
- Added mute button with visual feedback (red when muted)
- Improved header layout with better button spacing
- Status badge shows agent state properly

---

### v0.2.0
**Three-Layer Voice Architecture & UI Overhaul**

This release introduces a major architectural improvement and enhanced UI.

#### New Features

**Three-Layer Voice Architecture (Pipelined Mode)**
- **Layer 1 - Voice I/O**: Separate STT (Deepgram) and TTS (Gemini) for flexible voice handling
- **Layer 2 - Bridge LLM**: Gemini 2.5 Pro for intelligent conversation management, greetings, and context bridging
- **Layer 3 - Coding Agent**: Claude Code with Plan (read-only) and Execute (write) agents
- **Voice Mode Selection**: Choose between `realtime` (OpenAI/Gemini speech-to-speech) or `pipelined` (STT+LLM+TTS)
- **Smart Summarization**: Bridge LLM summarizes technical results for natural voice responses
- **Solves Gemini Greeting**: TTS speaks directly in pipelined mode - no more silent starts

**Improved Configuration**
- New `voiceMode` option: `'realtime'` (default) or `'pipelined'`
- Configurable pipelined providers: STT, Bridge LLM, and TTS
- Full config via `~/.osborn/config.yaml`

**Frontend UI Overhaul**
- **Markdown Rendering**: Assistant messages now render with full markdown support
- **Syntax Highlighting**: Code blocks with language badges and copy buttons
- **Better Status Indicators**: Animated status badges for listening/thinking/speaking states
- **Rich Text Support**: Headers, lists, links, tables, blockquotes rendered beautifully
- **GitHub-Dark Theme**: Code blocks styled with highlight.js github-dark theme

#### Backend Changes
- New `voice-io.ts`: STT/TTS factory with provider abstraction
- New `bridge-llm.ts`: Bridge LLM with context tracking and tools
- Updated `config.ts`: New types and helpers for pipelined config
- Updated `index.ts`: Dual-mode session creation and improved speech queue

#### Frontend Changes
- New `MarkdownMessage.tsx`: Full markdown renderer with syntax highlighting
- Updated `VoiceRoom.tsx`: Markdown integration and animated status badges
- Added dependencies: `react-markdown`, `remark-gfm`, `rehype-highlight`

#### Config Example
```yaml
# ~/.osborn/config.yaml
workingDirectory: /path/to/project
voiceMode: pipelined  # or 'realtime'

pipelined:
  stt:
    provider: deepgram
  llm:
    provider: gemini-pro
  tts:
    provider: gemini
    voice: Aoede
```

---

### v0.1.6
**Context Management & Voice Intelligence**
- **Dynamic Instructions**: Voice LLM now knows working directory and project context
- **Shared Context**: Actions and discovered files tracked between voice and coding agents
- **Improved Tool Routing**: Voice agent now properly delegates all coding tasks to Claude
- **Better Tool Description**: Clearer guidance for when to use `run_code` tool
- **Persistent Ready Signal**: Agent sends ready signal every 2s for 20s to ensure frontend receives it
- **Result Summarization**: Long coding results truncated for voice response

### v0.1.5
**MAJOR: Direct Connection Architecture**
- **Rewrite**: Agent now connects directly to rooms (no worker dispatch)
- **Works with cloud-hosted frontend**: Agent joins room first, waits for user
- **Self-generating room codes**: Run `npm run dev` to auto-generate code
- **Join existing room**: Run `npm run room abc123` to join specific room
- **Architecture**: Agent creates its own token, connects to LiveKit Cloud directly
- **Simplified**: Removed cli.runApp() worker pattern, cleaner code
- **Fixed**: Frontend room input to join agent-created rooms
- **Fixed**: Logger initialization for direct connection mode
- **Fixed**: localParticipant assignment for data channel communication

**How it works:**
```
Local Agent ─────► LiveKit Cloud ◄───── Hosted Frontend
     │                   │                    │
     └──── Same Room (osborn-abc123) ────────┘
```

**Testing Locally (both frontend + agent):**
```bash
# Terminal 1: Start the agent
cd agent
npm run dev
# Note the room code shown (e.g., "abc123")

# Terminal 2: Start the frontend
cd frontend
npm run dev
# Opens at http://localhost:3000

# In browser:
# 1. Enter the room code from Terminal 1
# 2. Click "Join"
# 3. Speak to test voice
```

### v0.1.4
- **Fixed**: VoiceRoom no longer remounts when agent connects (was causing immediate disconnect)
- **Fixed**: Room name properly accessed after connect() call
- **Fixed**: Session cleanup avoids WritableStream errors
- **Improved**: Unified waiting/connected states to keep VoiceRoom mounted
- **Architecture**: Dual agent system (Plan + Execute) with smart routing

### v0.1.3
- **Fixed**: Speech queue now tracks actual agent state (`listening`, `speaking`, etc.)
- **Fixed**: Permissions/status only spoken when agent is truly idle
- **Fixed**: Room code parsing with `npm run room <code>` script
- **Fixed**: Gemini model restored to working config (`gemini-2.5-flash-native-audio-preview-12-2025`)
- Better logging for speech queue debugging

**Frontend UX Improvements:**
- Auto-detect agent connection (no more manual "Agent Connected?" button)
- Persist provider/agent selection in localStorage
- File attachment support (images, code files)
- Improved audio visualization with state badges
- Better waiting screen with live connection status
- Agent sends heartbeat when ready

### v0.1.2
- Multi-agent pool (2 Claude handlers)
- Streaming feedback to voice LLM
- Smart silence mode ("let me know when done")
- Gemini greeting via instructions (not working)

### v0.1.1
- Tool logging to terminal
- All tools require permission by default
- npm package setup (`npx osborn`)

### v0.1.0
- Initial release
- OpenAI Realtime + Gemini Live support
- Claude Code + Codex backend options
- Room code system for hosted frontend
- Basic permission handling via UI buttons
