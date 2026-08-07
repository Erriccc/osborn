# Harness API — modes, endpoints, journeys, self-hosting

## Two modes
- **SHORT one-shot**: `OSBORN_SCENARIO=<name> npx playwright test specs/scenario.spec.ts` — fire a scenario, get a clip, done. Scenarios are YAML in `scenarios/` (steps: act/say/pause/assertScreen + improvised conversation goals).
- **LONG-RUNNING engine**: `npx tsx scripts/session-engine.ts` — ONE persistent browser, streams live, takes commands over HTTP. The director-controlled mode. Control on :8781 (`SESSION_ENGINE_PORT`), live viewer on :8080.

## Engine endpoints (:8781 — send `x-engine-token` when OSBORN_ENGINE_TOKEN is set)
| Endpoint | What |
|---|---|
| `GET /status` | ground truth: roomReady, pageUrl, pageState, idlePaused, brain ready/dead, activeTab, tabs+owners, lastFrameAgeMs, journey |
| `GET /tasks` | this run's task index (same as manifest.json) |
| `GET /clip?n=N` / `GET /artifact?n=N` | download task N's mp4 / screenshot |
| `GET /clip?n=N&audio=1` | task N's clip WITH the agent's aligned audio muxed in (mp4 video+audio). Current run only; decodes+aligns via the recording's own start, not rel0/rel1 |
| `GET /audio` | the whole run's captured audio as mp3 (the agent's voice — absent from the video-only clips/stream). Room-mode/ears only |
| `GET /logs` | full console+network+websocket buffers, all tabs |
| `GET /events` | SSE: live navigation/task/tab/journey/transcript/agent_output/lifecycle events (25-event replay on connect; `engine_stopping` announces sleep) |
| `POST /act {instruction, owner?, clipSeconds?, settleMs?}` | natural-language action → returns clip + screenshot + devtools + tab |
| `POST /say {text, ...}` | speak into the mic; returns media + `heard` (agent's spoken reply, transcribed) |
| `POST /hear {lastMs}` | transcript of recent agent audio |
| `POST /eval {expression, owner?}` | run JS in the page (the website console, programmatic); recorded as a journey step |
| `POST /shot` | on-demand screenshot (viewport only — NOT proof media; clips are) |
| `POST /tab {op: open\|navigate\|switch\|close\|claim\|release, url?, i?, owner?, viewport?, reuse?}` | tab ops. `open` REUSES a same-site tab unless `reuse:false`; `viewport:"mobile"` = 390×844; owners guard against other directors (409) |
| `POST /journey {op: start\|end\|list, name?, goal?, save?, cleanup?}` | journey framing — see below |
| `POST /brain` | re-init a detached Stagehand in place |
| `POST /recover` | reload the active tab |
| `POST /end` | graceful shutdown (bounded, manifest safe) |

## Journeys — how a deployment learns a site
`journey list` → known recipes for this site. `journey start {name, goal}` → run steps → `journey end` (closes extra tabs, resets viewport, SAVES the step sequence to `knowledge/<site>/journeys/<name>.yaml`). Site knowledge: `knowledge/<hostname>/{actions.json,rules.md,site.md,journeys/}` — rules.md is BINDING, read before operating on a site.

## Key environment
- `GOOGLE_API_KEY` — REQUIRED (Stagehand brain). `OPENAI_API_KEY` (TTS mouth), `DEEPGRAM_API_KEY` (transcription ears) recommended.
- `OSBORN_APP_URL` — the target site. `OSBORN_ENTRY=none` — just load the page, skip the voice-native room flow (ANY website).
- `OSBORN_ENGINE_TOKEN` — control-API auth (REQUIRED on public deployments).
- `OSBORN_IDLE_STOP_MS` (default 15min container) — self-sleep. `OSBORN_TAB_STALE_MS` (default 30min) — stale-tab sweep.
- `OSBORN_WEBHOOK_URL`/`OSBORN_WEBHOOK_TOKEN` — push events to any receiver.
- `OSBORN_TEST_EMAIL/PASSWORD` + `OSBORN_SUPABASE_URL/ANON` — mint an auth profile at boot from secrets (cloud auth without baking cookies into images).
- `OSBORN_DEVTOOLS=1` — DevTools panel on camera. `OSBORN_DISPLAY_SIZE` — virtual display size.

## Self-hosting the cloud engine (Fly)
From the harness dir: `fly launch` (or `fly deploy`), then `fly ips allocate-v4 --shared` + `fly ips allocate-v6` (Machines-API-created apps get NO public IPs), set secrets (GOOGLE_API_KEY, OSBORN_ENGINE_TOKEN required; stream token strongly advised — see streaming.md). You get wake-on-visit (~40s to pixels), idle self-stop, full-window capture (Xvfb+openbox+x11grab: real tab strip at real-time speed), tab-state restore across sleep. Updating = `fly deploy` from a fresh bundle; the version probe says when you're stale.
