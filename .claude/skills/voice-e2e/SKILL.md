# Voice E2E Testing — ears, mouth, hands + brain for voice web apps

Use this skill when asked to test, debug, or measure the osborn voice app (or ANY
voice/audio web app) end-to-end in a real browser: speaking to it, hearing its
replies, interrupting it, checking UI flows, or gathering latency metrics.

## What this is

A Playwright harness at `tests/voice-e2e/` that gives an agent:
- **Mouth** — `lib/reactive-mic.ts`: patches `getUserMedia` so the app receives a
  test-controlled WebAudio stream. `speakText(page, '...')` synthesizes speech at
  runtime (`say` on macOS, espeak-ng on Linux) and speaks it mid-session, any
  number of turns, reacting to replies. Carries -68dBFS comfort noise (LiveKit
  mutes digitally-silent mics).
- **Ears** — `lib/audio-capture.ts` `startElementCapture(page)`: records everything
  `<audio>/<video>` elements play (works headless, no flags/permissions), plus
  millisecond `speech-start`/`speech-stop` energy events in `window.__osbornEars`.
  Verify what was SPOKEN by transcribing the capture via Deepgram REST.
- **Brain** — Stagehand OSS (`@browserbasehq/stagehand`, MIT, free) attached to OUR
  Chrome over CDP; `stagehand.act('natural language goal')` handles gates/modals
  without selectors. Model: `google/gemini-2.5-flash` (key in `agent/.env`).
- **Steps dictionary** — `lib/steps.ts`: `ensureAgentInRoom`, `enterFreshRoom`
  (handles both session-gate variants; `{ earsOn: true }` records from page load
  so the greeting is captured), `waitForSpeechEvent`, `logResult`.
- **Metrics** — every scenario appends a JSON line to `results/runs.jsonl`
  (stop latency, pivot latency, capture transcript, ...). Trend = aggregate it.

## Running

```bash
cd tests/voice-e2e
npx playwright test specs/stagehand-conversation.spec.ts   # 2-turn reactive convo
npx playwright test specs/barge-in.spec.ts                 # interruption metrics
npx playwright show-report                                  # replays: video/audio/muxed
```

Replays per run in `test-results/<test>/`: `agent-audio` webm, `screen-video` webm,
`replay-with-audio.webm` (muxed, time-aligned). `OSBORN_TEST_MONITOR=1` plays the
tester's voice on speakers during headed runs.

Target selection: `OSBORN_AGENT_URL` (default `https://osborn-d4f24f46-v2.fly.dev`),
`OSBORN_APP_URL` (default `https://www.voice-native.com`). Guest mode via
`/chat?...&agentUrl=<url>` needs no auth (known-open gap, deliberate for testing).

## Verify the media — never take the tester's word for it

A green assertion is a CLAIM, not proof of experience. Before reporting a
result (especially "logged in", "resumed", "explored X"), the supervising
agent MUST review the artifacts itself:

```bash
ffmpeg -i replay.mp4 -vf "fps=1/5" /tmp/frames/f%02d.jpg   # then Read the frames
```

- Watch key video frames (entry, mid-flow, ending) and check the UI actually
  shows the claimed state — real case: a "logged-in dashboard" run passed all
  assertions while the frames showed "Local (offline)" and zero conversations
  (authenticated cookie, wrong mode — assertions were too weak to notice).
- Listen to / transcribe the audio capture when the claim is about speech.
- Read devtools-diagnostics + flight log against the narrative.
- If frames contradict the assertions, the TEST is wrong — tighten its
  assertions (assert account-specific evidence: avatar/email, session counts,
  "Cloud (running)"), then rerun. Report only what the media shows.

## Dual-view testing — who sees what

The TESTER (Stagehand brain + harness) is app-agnostic: its only senses are
frontend ones — screenshot, screen text, audio capture, and the DevTools
buffer (`lib/devtools.ts`: console, page errors, failed requests, websocket
events). It never assumes backend access — that's what makes it portable to
any website. On a stall, its DevTools summary is fed to the recovery brain
and dumped as a `devtools-diagnostics` artifact.

The ORCHESTRATING AGENT (you, holding this skill) additionally has
privileged access to OUR backend — fly machine logs, /health, Railway. When
testing osborn: arm a backend log watcher (Monitor on the machine log, or
grep after) IN PARALLEL with the frontend run, then correlate both views.
The tester experiences the site like a user; you supply the X-ray.

## Supervisor loop — bidirectional agent↔agent channel (lib/flightlog.ts)

When supervising a run, ALWAYS arm a Monitor BEFORE starting the test:

```bash
tail -f results/live/flight.jsonl   # every milestone: in-room, tester-says,
                                    # agent-heard, assistance-requested, complete
```

Outbound: the tester narrates its state to `results/live/flight.jsonl`.
Inbound: when stuck beyond self-recovery, it writes
`results/live/assist-request.json` (problem + url + screen text + DevTools
view) and WAITS up to 3 min. You — with backend logs, /health, knowledge —
investigate and write `results/live/assist-response.json`:
  {"instruction": "click the ... button"}   → fed to the Stagehand brain
  {"command": "reload"}                     → agent re-seat + fresh entry
  no response → tester runs its own end-game (fail with evidence)

This is the Director pattern: the tester runs autonomously on known ground,
escalates when uncertain, and neither side sits stuck.

## Pair every browser observation with machine ground truth

```bash
FLY_API_TOKEN=$(cat ~/osborn-backups/new-fly-account-token.txt)
curl -s -H "Authorization: Bearer $FLY_API_TOKEN" -X POST \
  "https://api.machines.dev/v1/apps/<app>/machines/<id>/exec" \
  -d '{"command":["sh","-c","grep -E \"FINAL transcript|TTS say\" /workspace/osborn.log | tail"]}'
```
`FINAL transcript` = what the agent heard; `TTS say` = what it spoke. When a UI
assertion fails, check here FIRST — twice the backend was right and the UI/DOM
assertion was the liar.

## Hard-won gotchas (do not relearn these)

- `--use-file-for-fake-audio-capture` hijacks getDisplayMedia audio AND loops by
  default — never combine it with audio capture; the reactive mic replaces it.
- LiveKit mutes silent synthetic mics (`LocalAudioSilenceDetected`→`TrackMuted`);
  comfort noise in the mic graph prevents it.
- The in-room "Previous Sessions" prompt MUTES the mic until answered
  (VoiceRoom.tsx `setMicrophoneEnabled(false)`); dismiss it before speaking.
- Agent must be in its LiveKit room BEFORE the browser joins (ParticipantConnected
  only fires for later joiners; fixed agent-side in 0.9.76 but always pre-connect:
  POST `/connect-room` then poll `/health` for `livekit.status==='connected'`).
- `/health` can LIE "connected" after a zombie-watchdog leave on agents <0.9.76 —
  if the room never gets an agent, the machine process needs a restart (ask user).
- Don't assert on DOM text counts for repeated identical replies — chat UI merges
  bubbles. The audio capture transcript is the source of truth.
- Reply words must NOT appear in prompt audio (use riddles: "yellow curved fruit").
- Stagehand attach needs the ws URL from `http://127.0.0.1:<port>/json/version`,
  not the bare port; set `GOOGLE_GENERATIVE_AI_API_KEY` env for its model client.
- Manual `chromium.launch` bypasses config-level video recording — pass
  `recordVideo` on the context and `video.saveAs` after `context.close()` but
  before `browser.close()`.

## Portability

Nothing here requires local Chrome specifically: specs attach over CDP, so point
them at any CDP endpoint (Browserless container: `ws://host:3000/chromium/playwright
?token=...`; pin @playwright/test to the container's supported version). Linux/CI:
use `mcr.microsoft.com/playwright` image + espeak-ng or OpenAI TTS for synthesis.

## Scenario store — workflows as files (the native format)

`scenarios/<name>.yaml` = one stored workflow: `entry: fresh|resume`,
optional `viewport` (mobile), optional `url` (landing-page entry), `steps[]`
(`act` NL ui action · `say` · `waitSpeech` · `pause` · `assertScreen` ·
`upload`), and a `conversation:` phase where an LLM tester IMPROVISES each
utterance toward `goal` (different words every run; assertions via
`minAudibleReplies` / `assertHeard`). Existing: talk-to-agent, resume-session,
mobile-responsiveness, file-attachment, meeting-join (needs
OSBORN_MEETING_URL), login-guest.

```bash
OSBORN_SCENARIO=file-attachment npx playwright test specs/scenario.spec.ts
npx playwright test specs/scenario.spec.ts        # all scenarios
```

To store a NEW workflow: write a yaml (agents may do this), nothing else —
the runner picks it up.

## Site knowledge — the per-website "digital profile"

`knowledge/<hostname>/` holds three layers (all skill accompanying files):
- `actions.json` — compiled UI actions (step-cache manages automatically)
- `site.md` — learnings & findings the agent discovers while working
- `rules.md` — **RULES & REMINDERS taught by the user** ("always leave the
  room before exiting"). BINDING: read rules.md BEFORE operating on a site;
  when the user gives site-specific guidance, APPEND it there
  (`addSiteRule()` in lib/knowledge.ts) so every future agent inherits it.

## Room hygiene (mandatory)

Every spec has `test.afterEach` → POST `/leave-room`. Never add a spec
without it: an abandoned empty room breeds the alone-timer/watchdog wedge.

## Writing a new scenario

Compose from steps: `ensureAgentInRoom` → launch Chrome with CDP port → attach
Stagehand → `enterFreshRoom(page, act, url, { earsOn: true })` → speak/listen/
assert → `logResult(scenario, metrics)` → attach replays. Copy
`specs/barge-in.spec.ts` as the template.
