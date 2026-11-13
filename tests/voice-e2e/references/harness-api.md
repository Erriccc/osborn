# Harness API — modes, endpoints, journeys, self-hosting

## Two modes
- **SHORT one-shot**: `OSBORN_SCENARIO=<name> npx playwright test specs/scenario.spec.ts` — fire a scenario, get a clip, done. Scenarios are YAML in `scenarios/` (steps: act/say/pause/assertScreen + improvised conversation goals).
- **LONG-RUNNING engine**: `npx tsx scripts/session-engine.ts` — ONE persistent browser, streams live, takes commands over HTTP. The director-controlled mode. Control on :8781 (`SESSION_ENGINE_PORT`), live viewer on :8080.

## Engine endpoints (:8781 — send `x-engine-token` when OSBORN_ENGINE_TOKEN is set)
| Endpoint | What |
|---|---|
| `GET /status` | ground truth: roomReady, pageUrl, pageState, idlePaused, brain ready/dead, activeTab, tabs+owners, lastFrameAgeMs, journey, **agentUrl / agentUnreachable** (#49: null when the auto-joined chat's agent is reachable, else `"agent unreachable: <host>"` — the in-app Browser panel reads this via its /status proxy), **previousRun / restartRecovered** (#120: set when this process ADOPTED a journey from a process that died mid-journey — `restartRecovered:true` means "engine restarted, journey carried over", and `/clip?run=<previousRun>` reaches the pre-restart media) |
| `GET /tasks` | this run's task index (same as manifest.json) |
| `GET /clip?n=N` / `GET /artifact?n=N` | download task N's mp4 / screenshot |
| `GET /clip?n=N&audio=1` | task N's clip WITH the agent's aligned audio muxed in (mp4 video+audio). Current run only; decodes+aligns via the recording's own start, not rel0/rel1 |
| `GET /audio` | the whole run's captured audio as mp3 (the agent's voice — absent from the video-only clips/stream). Room-mode/ears only |
| `GET /logs` | full console+network+websocket buffers, all tabs |
| `GET /events` | SSE: live navigation/task/tab/journey/transcript/agent_output/lifecycle events (25-event replay on connect; `engine_stopping` announces sleep) |
| `POST /act {instruction, clipSeconds?, settleMs?}` | natural-language action → returns clip + screenshot + devtools + tab |
| `POST /say {text, ...}` | speak into the mic; returns a screenshot, `heard` (agent's spoken reply, transcribed) and a `clipUrl` that waits until the clip is encoded (`clipPending: true`; pass `waitClip: true` to get the clip in the reply) |
| `POST /hear {lastMs}` | transcript of recent agent audio |
| `POST /eval {expression}` | run JS in the page (the website console, programmatic); recorded as a journey step |
| `POST /shot` | on-demand screenshot (viewport only — NOT proof media; clips are) |
| `POST /tab {op: open\|navigate\|switch\|close\|claim\|release, url?, i?, viewport?, reuse?}` (owner = your `x-driver-id`) | tab ops. `open` REUSES a same-site tab unless `reuse:false`; `viewport:"mobile"` = 390×844; owners guard against other directors (409) |
| `POST /journey {op: start\|end\|list, name?, goal?, save?, cleanup?}` | journey framing — see below |
| `POST /brain` | re-init a detached Stagehand in place |
| `POST /recover` | reload the active tab |
| `POST /end {shutdown?, keep?}` | closes YOUR tabs; shuts the engine down (bounded, manifest safe) only when no other driver has a tab open, or with `{"shutdown": true}`; `{"keep": true}` never stops it |
| `x-profile: <name>` header | opens your new tabs in your own Chrome profile: cookies and sign-ins isolated from other drivers and saved across restarts (sign in once). Without it, tabs use the shared profile. The /browser panel uses the signed-in person's profile automatically. |

## Journeys — how a deployment learns a site
`journey list` → known recipes for this site. `journey start {name, goal}` → run steps → `journey end` (closes extra tabs, resets viewport, SAVES the step sequence to `knowledge/<site>/journeys/<name>.yaml`). Site knowledge: `knowledge/<hostname>/{actions.json,rules.md,site.md,journeys/}` — rules.md is BINDING, read before operating on a site.

## Key environment
- `GOOGLE_API_KEY` — REQUIRED (Stagehand brain). `OPENAI_API_KEY` (TTS mouth), `DEEPGRAM_API_KEY` (transcription ears) recommended.
- `OSBORN_APP_URL` — the target site. `OSBORN_ENTRY=none` — just load the page, skip the voice-native room flow (ANY website).
- `OSBORN_AGENT_URL` — the Voice Native agent machine the auto-joined chat talks to. **No default (#49)**: unset (or unreachable at boot) → the engine skips the room join, opens `OSBORN_APP_URL` for plain browsing, and marks `agentUnreachable` on `/status` + the live view instead of spinning on "Connecting…".
- `OSBORN_ENGINE_TOKEN` — control-API auth (REQUIRED on public deployments).
- `OSBORN_IDLE_STOP_MS` (default 3h container) — self-sleep. `OSBORN_TAB_STALE_MS` (default 30min) — stale-tab sweep.
- `OSBORN_RECOVER_JOURNEY` (default on; `=0` disables) — persist the active journey to `journey-state.json` in the results dir and ADOPT it on the next boot, so a mid-journey process restart (#120) keeps the journey instead of nulling it. `OSBORN_SAY_RETRIES` (default 2) — bounded in-process retries of a TRANSIENT (non-mic) speak failure at the Say step. (Caller-side: `drive.sh say` re-attaches once on an empty/gateway 502 — the restart signature — after polling `/status` for the engine to wake; `BSR_SAY_REATTACH=0` disables.)
- `OSBORN_WEBHOOK_URL`/`OSBORN_WEBHOOK_TOKEN` — push events to any receiver.
- `OSBORN_TEST_EMAIL/PASSWORD` + `OSBORN_SUPABASE_URL/ANON` — mint an auth profile at boot from secrets (cloud auth without baking cookies into images).
- `OSBORN_DEVTOOLS=1` — DevTools panel on camera. `OSBORN_DISPLAY_SIZE` — virtual display size.

## Self-hosting the cloud engine (Fly)
From the harness dir: `fly launch` (or `fly deploy`), then `fly ips allocate-v4 --shared` + `fly ips allocate-v6` (Machines-API-created apps get NO public IPs), set secrets (GOOGLE_API_KEY, OSBORN_ENGINE_TOKEN required; stream token strongly advised — see streaming.md). You get wake-on-visit (~40s to pixels), idle self-stop, page capture via CDP (set `OSBORN_CAPTURE=display` for full-window x11grab capture with the real tab strip; it costs most of a shared CPU), tab-state restore across sleep. Updating = `fly deploy` from a fresh bundle; the version probe says when you're stale.

## v24 additions

- **Control API on the stream port.** `https://<app>.fly.dev/control/<action>`
  forwards to the control server with the same `x-engine-token`. Use it when
  `:8781` is not reachable (443-only sandboxes and proxies). 403 when the
  engine has no token configured; 503 `engine_booting` until the control
  server is listening.
- **`/act` response**: `effect {changed, noop, urlBefore, urlAfter, titleAfter,
  scrollBefore, scrollAfter}`, `warning`, `result.did`, `brainModel`. Failures:
  `brain_error` (502, provider message), `brain_unavailable` (503),
  `bad_request` (400).
- **Async**: `POST /act|/say {"async":true}` → 202 `{job, resultUrl}`;
  `GET /result?id=<job>` → 202 `{done:false, runningSec}` or 200
  `{done:true, status, ...the synchronous response}`.
- **Tabs**: `takeover` / `handback` (supervisor borrows a driver's tab; the
  driver gets 409 `paused_by_supervisor` with `retryAfterSec`); `release` is
  owner-only; switching onto another driver's tab is 409 `tab_owned`; unknown
  op is 400, bad index 404. `/status.takeovers` lists active takeovers.
- **Brain**: provider fallback Gemini → Anthropic → z.ai
  (`GOOGLE_API_KEY`/`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `Z_AI_API_KEY`);
  `/status.brainModel`, `/status.brainError`; `POST /brain` re-picks.
- **Env**: `OSBORN_CHROMIUM_PATH` uses an existing Chromium binary.
- **Public evidence**: `/act` and `/say` return `evidence {run, task, screenshot, clip, log, markdown, note}` —
  signed `/media/<run>/<n>.jpg|mp4|txt?s=<sig>` URLs that need no token. `GET /evidence?run=&n=` (token)
  re-issues them for any stored run. `OSBORN_SHARE_SECRET` overrides the signing secret (default: derived
  from the engine token). `OSBORN_KEEP_RUNS` default is now 30.
