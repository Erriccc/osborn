# Harness API — modes, endpoints, journeys, self-hosting

## Two modes
- **SHORT one-shot**: `OSBORN_SCENARIO=<name> npx playwright test specs/scenario.spec.ts` — fire a scenario, get a clip, done. Scenarios are YAML in `scenarios/` (steps: act/say/pause/assertScreen + improvised conversation goals).
- **LONG-RUNNING engine**: `npx tsx scripts/session-engine.ts` — ONE persistent browser, streams live, takes commands over HTTP. The director-controlled mode. Control on :8781 (`SESSION_ENGINE_PORT`), live viewer on :8080.

## Engine endpoints (:8781 — send `x-engine-token` when OSBORN_ENGINE_TOKEN is set; a public engine without one refuses with 503 `engine_token_missing`)
| Endpoint | What |
|---|---|
| `GET /health` | no token needed: `{ok, tokenRequired, tokenConfigured}` (plus `code:"engine_token_missing"` when the control API is locked) |
| `GET /status` | ground truth: roomReady, pageUrl, pageState, idlePaused (the app's own "Session paused" screen), capturePaused (the engine's idle screen-capture pause; reading /status does not wake it), ears (the shown tab's page-audio recording: `recordingMin`, `decodeCapMin`, `overCap` — past the cap /say clips carry no page audio; reload the tab for a fresh recording), freeMemoryMb (MB left; null off Linux), brain ready/dead, activeTab, tabs+owners, lastFrameAgeMs, journey, **agentUrl / agentUnreachable** (#49: null when the auto-joined chat's agent is reachable, else `"agent unreachable: <host>"` — the in-app Browser panel reads this via its /status proxy), **previousRun / restartRecovered** (#120: set when this process ADOPTED a journey from a process that died mid-journey — `restartRecovered:true` means "engine restarted, journey carried over", and `/clip?run=<previousRun>` reaches the pre-restart media) |
| `GET /tasks` | this run's task index (same as manifest.json) |
| `GET /stream?tab=i` | MJPEG of one of YOUR tabs (`409 not_your_tab` for another's); without `tab` it follows your current tab, "Nothing is being shared" while you have none. The public viewer on :8080 shows only the cast tab — see streaming.md |
| `GET /clip?n=N` / `GET /artifact?n=N` | download task N's mp4 / screenshot |
| `GET /clip?n=N&audio=1` | task N's clip WITH the page's aligned audio muxed in (mp4 video+audio). Current run only; decodes+aligns via the recording's own start, not rel0/rel1. Header `X-Clip-Audio: yes` when an audio track was muxed in (it can still be silent), `none` when no page audio could be added (video only): the tab recorded nothing during the clip, or the task's tab has since closed or moved to another URL |
| `GET /audio` | your tab's captured audio as mp3 (`<audio>`/`<video>` elements and WebAudio output — absent from the video-only clips/stream). 404 with `ears` until the tab has recorded something; it does not arm them (`/act`, `/say` or `/hear` does). WebAudio output of the top page only, not iframes |
| `GET /logs` | full console+network+websocket buffers, all tabs |
| `GET /events` | SSE: live navigation/task/tab/journey/transcript/agent_output/lifecycle events (25-event replay on connect; `engine_stopping` announces sleep) |
| `POST /act {instruction, clipSeconds?, settleMs?, vision?}` | natural-language action → returns clip + screenshot + devtools + tab; arms the ears on the tab so `/clip?n=N&audio=1` can carry its sound; a tab the action opens becomes your tab (`effect.openedTab`) |
| `POST /input {type: key\|type\|click\|scroll, key?, text?, x?, y?, dy?}` | raw input on your tab: a real key press (`Enter` submits a form; `/act` fills fields but does not reliably press keys), keystrokes into the focused field, a click at frame fractions, a wheel scroll |
| `POST /say {text, ...}` | speak into the mic; returns a screenshot, `heard` (agent's spoken reply, transcribed) and a `clipUrl` that waits until the clip is encoded (`clipPending: true`; pass `waitClip: true` to get the clip in the reply) |
| `POST /hear {lastMs}` | transcript of recent agent audio |
| `POST /eval {expression}` | run JS in the page (the website console, programmatic); recorded as a journey step |
| `POST /shot` | on-demand screenshot of your tab; recorded as a task, so it returns `task` and public `evidence` links to paste into an issue |
| `POST /tab {op: open\|navigate\|switch\|close\|claim\|release\|cast\|uncast, url?, i?, viewport?, reuse?}` (owner = your `x-driver-id`) | tab ops. `cast` shares one of your tabs on the public live view (a meeting's camera), `uncast` stops it; replies carry `cast` (the cast tab's index or null). `open` REUSES a same-site tab unless `reuse:false`; `viewport:"mobile"` = emulated iPhone 13 and `"tablet"` = iPad (gen 7) (own context: touch, mobile UA, device pixels, same sign-ins; closed with its last tab), `{width,height}` = desktop window resized; owners guard against other directors (409) |
| `POST /journey {op: start\|end\|list, name?, goal?, save?, cleanup?}` | journey framing — see below |
| (all replies) | JSON replies, `/events` and webhooks are redacted (`••••`); `/eval` values and `/shot` `jpegB64` are raw — read raw URLs with `/eval location.href`. Run files (`manifest.json`, `scenario.yaml`) and saved journeys are written redacted, and a step carrying a token-shaped value or typing into a password field is never cached in `actions.json` (an older such entry is dropped on its next use) |
| `POST /brain` | re-init a detached Stagehand in place |
| `POST /recover` | reload the active tab |
| `POST /end {shutdown?, keep?}` | closes YOUR tabs; shuts the engine down (bounded, manifest safe) only when no other driver has a tab open, or with `{"shutdown": true}`; `{"keep": true}` never stops it |
| `x-profile: <name>` header | opens your new tabs in your own Chrome profile: cookies and sign-ins isolated from other drivers and saved across restarts (sign in once). Without it, tabs use the shared profile. The /browser panel uses the signed-in person's profile automatically. |

## Journeys — how a deployment learns a site
`journey list` → known recipes for this site. `journey start {name, goal}` → run steps → `journey end` (closes extra tabs, resets viewport, SAVES the step sequence to `knowledge/<site>/journeys/<name>.yaml`). Site knowledge: `knowledge/<hostname>/{actions.json,rules.md,site.md,journeys/}` — rules.md is BINDING, read before operating on a site.

## Key environment
- `GOOGLE_API_KEY` — REQUIRED (Stagehand brain). `OSBORN_ENGINE_GEMINI_MODEL` — its Gemini model (default `gemini-3.5-flash-lite`); on a 404 the engine tries `gemini-3.1-flash-lite`, then `gemini-3.8-flash`, and `brainError` names the failing model (`gemini 404 (<model>)`). `OPENAI_API_KEY` (TTS mouth), `DEEPGRAM_API_KEY` (transcription ears) recommended.
- `OSBORN_APP_URL` — the target site. `OSBORN_ENTRY=none` — just load the page, skip the voice-native room flow (ANY website).
- `OSBORN_AGENT_URL` — the Voice Native agent machine the auto-joined chat talks to. **No default (#49)**: unset (or unreachable at boot) → the engine skips the room join, opens `OSBORN_APP_URL` for plain browsing, and marks `agentUnreachable` on `/status` + the live view instead of spinning on "Connecting…".
- `OSBORN_ENGINE_TOKEN` — control-API auth (REQUIRED on public deployments: with `FLY_APP_NAME` or `OSBORN_ENGINE_PUBLIC_URL` set and no token, every control route answers 503 `engine_token_missing`; a local run without either stays open and warns at boot).
- `OSBORN_ENGINE_PUBLIC_URL` — the engine's public control base (default `https://$FLY_APP_NAME.fly.dev/control`); every link in a reply (`evidence`, `clipUrl`, `artifactUrl`, `resultUrl`, webhooks) is built on it.
- `OSBORN_IDLE_STOP_MS` (default 3h container) — self-sleep. `OSBORN_TAB_STALE_MS` (default 30min) — stale-tab sweep. `OSBORN_MIN_FREE_MB` (default 300) — under it the least recently used idle tab is closed. `OSBORN_RESTORE_MAX` (default 3) — tabs reopened after a restart. `OSBORN_LOCK_MAX_MS` (default 4min) — longest one command holds the action lock before the next may run.
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
  scrollBefore, scrollAfter}`, `warning`, `result.did`, `brainModel`, `tokens {prompt, completion, reasoning, total}` and `modelMs` (model use of this act, also on the task in `manifest.json`; a cached replay normally reports 0, more than 0 means Stagehand re-asked the model to heal it; an engine scroll reports 0). Failures (the first three carry `tokens` and `modelMs` too):
  `noop` (`ok:false`, nothing on the page matched), `unverified` (`ok:false`, a vision retry ran something it could not confirm), `brain_error` (502, provider
  message), `brain_unavailable` (503), `bad_request` (400), `too_large` (413).
- **Vision retry** (on by default): when the DOM brain finds nothing to match (a
  canvas, an embedded frame) the engine makes ONE screenshot-based attempt under
  the same action lock (its own timeout, capped by the lock time left; skipped
  under 10s): look at a screenshot, then make one interaction. Only exactly one
  `click`, `type` or `keys` call that succeeded after a screenshot that returned
  an image is counted; anything else it ran (scroll, goto, the DOM `act` tool,
  several calls, a click sent blind) is named in `effect.visionNote`. Counted:
  `effect.fallback:'vision'`, `result.did`, and `ok:true` only if `effect.changed`
  is true. Not counted but something ran, or no observable change:
  `ok:false, code:'unverified'`, `effect.visionActed:true` (check the screenshot
  before retrying; `drive.sh` exits 6). Nothing ran: the original `noop`. Never
  cached, never a 500. Skipped for conditional ("if ... otherwise") or
  destructive wording (pay, delete, send, submit, order, post, cancel ...) unless
  `"vision":true`, off per call with `"vision":false` or engine-wide with
  `OSBORN_NO_VISION_RETRY=1`, and on Gemini brains on a tab whose viewport is not
  the brain's. `modelMs` is wall time (nested act time may be counted twice);
  `tokens` are not exact (the forced `done` call is not counted; an error reports
  0). Click accuracy on the default Gemini Flash brain is unverified.
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

## Error codes and tab defaults (v46–v56)

Every failure reply is `{ok:false, code, error, ...}`.

| Status | `code` | When |
|---|---|---|
| 400 | `bad_json` | the request body is not valid JSON |
| 400 | `bad_url` | a malformed or non-http(s) URL for `/tab open` or `navigate` (checked before any tab opens or moves) |
| 400 | `bad_request` | a missing or invalid field |
| 409 | `no_own_tab` | `/tab close` or `navigate` with no `i`, and you own no tab besides tab 0; `/audio` for a /browser panel person with no tab |
| 409 | `room_tab` | `/tab cast` of tab 0 (the voice room) |
| 403 | `not_your_task` | `/clip` or `/artifact` of another driver's task, asked by a /browser panel person (`x-driver-id: person:…`) |
| 404 | `task_unknown` / `no_frame_captured` / `frame_file_missing` | `/artifact`: no such task in that run; the task recorded no frame (screenshot and live stream frame both failed); its frame file is gone from disk |
| 409 | `tab_owned` | the tab belongs to another driver (`/act`, `/say`, `/eval`, `/shot`, `/recover`, `/tab navigate\|release`) |
| 409 | `not_your_tab` | `/input`, `/stream?tab=i` or `/tab cast` on a tab you neither opened nor took over; `/tab uncast` of someone else's cast |
| 409 | `paused_by_supervisor` | your tab is taken over; retry after `retryAfterSec` |
| 409 | `journey_owned` | `/journey end` of another driver's journey while that driver sent a command in the last 10 minutes |
| 413 | `too_large` | an `/act` instruction over 4,000 characters |
| 500 | `no_screenshot` | `/shot` could not capture your tab; still recorded as `task` |
| 502 | `nav_failed` | the page did not load; `netError` is the browser's `net::…` code, and `reusedTab` names the tab when `/tab open` reused one |
| 502 / 503 | `brain_error` / `brain_unavailable` | the brain's provider failed, or the brain is down |
| 503 | `engine_restarting` | the engine was stopped (a deploy or restart) while your request ran; `retryable:true`, retry after `retryAfterSec` — an active journey is carried across the restart |
| 503 | `engine_token_missing` | a public engine has no `OSBORN_ENGINE_TOKEN`; only `/health` and signed `/media` links answer |
| 200 | `noop` (`ok:false`) | `/act` found nothing on the page to do; `drive.sh act` exits 5 |
| 200 | `unverified` (`ok:false`) | a screenshot-based retry ran something not counted or with no observable change (`effect.visionActed`); `drive.sh act` exits 6 |

- A navigation that settles on another page of the same host (http→https, trailing slash, `/login` → `/dashboard`) succeeds with `redirectedTo` set to where the tab landed.
- `/tab navigate` and `/tab close` with no `i` act on a tab you OWN (the one you last used, else the newest you own), never tab 0 (the voice room), an unowned tab or a tab another driver fronted. After a close, `/tab list` and the close reply report the same `activeTab`.
- `/shot` returns `ok:true`, `task` and `evidence`; the base64 image only with `"inline":true` (or `?inline=1`). A screenshot that times out uses the tab's own recorded frame or fails: never another tab's frame.
- Signed `/media` links answer `GET` and `HEAD`.
- `/tab navigate` makes the navigated tab your current tab (your next `/act` runs there, and it counts as the tab you are working in). `x-driver-id` is trimmed, and a `person:` id lowercased: one driver whatever the spelling.
- `/journey end` cleans up the journey owner's tabs; a tab the owner had taken over is handed back, not closed. `/end` decides who else is using the engine at once, outside the action lock (the close-my-tabs reply re-checks who is still here under it); a tab of yours someone has taken over is released to nobody when they hand it back after your `/end`.
- A saved profile (`x-profile` or a person's) that cannot be read is moved aside (`.bad`) and opens fresh, like the shared one.
- **Person scoping — the rule.** For a caller whose `x-driver-id` is `person:<email>` (the /browser panel), the only tab they can see or act on is one they own (`personOwns` in `lib/event-scope.ts`, the one check every person rule goes through). Unowned tabs, tab 0 included, are invisible and untouchable to them. Reads: `/status` and `/tab` replies list other tabs with `url:""` and no `marks`, and report their own tab (`activeTab:null`, `pageState:"none"` with none); `/tasks`, `/clip`/`/artifact` (`403 not_your_task`), `/logs`, `/audio`, `/hear` and `/stream` cover only their tabs; `/events` sends only events with no tab context or whose every tab owner is them. Any other driver id, including no header (`default`), keeps the full view.
- **Person extras.** `takeover`/`claim`/`switch` of tab 0 is `409 room_tab` for a person even after an agent claimed it. After a takeover, a person's `/logs`, `/audio` and `/hear` start at the takeover. A person's `/act`/`/say` clips use only their tab's own recording. `/status` gives a person `journey`/`mission` only for their own journey and `taskCount` of their visible tasks. A person's `/end {"shutdown":true}` is `409 engine_in_use` (with `otherCount`) while other drivers hold tabs. `GET /stream` for agents and the default driver: any tab (`?tab=i`) or, without it, their current tab, tab 0 included.
- **Person actions.** `claim`, `switch`, `navigate`/`close`/`release` with an explicit `i`, and `cast` refuse (`409 not_your_tab`) any tab the person does not own; `takeover` is allowed only on an agent's tab, and their `release` of a taken-over tab hands it back to its previous owner; `release` of their own-profile tab closes it. `guardOwnership` (`/act`, `/say`, `/shot`, `/eval`, `/recover`) answers `409 no_own_tab` instead of falling back to tab 0. Other people show as `"person"` in every owner field; `/end` gives a person `otherCount` instead of `others`. The `tab` event carries `by` and only the caller's own tab.
- **Any ownership change ends a cast** of that tab (takeover, handback, idle handback, release, `/end`). For a person, every `/tab` reply blanks other drivers' tab URLs like `/status`; with no own tab `/status` reports `activeTab:null`, `pageState:"none"` and `lastFrameAgeMs:null` (for a person it is their own tab's newest frame), and `/recover` is `409 no_own_tab`. `/tab open` owns the tab before it loads, so its load events never reach other people. The cast is saved with the tab layout and restored after a restart.
