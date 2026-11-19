# Playwright harness — short mode, scenarios and site knowledge

The engine (`scripts/session-engine.ts`) is built from the same parts as the
one-shot Playwright specs. Read this when writing or running a spec, adding a
scenario, or working on the harness itself.

## The parts
- **Mouth** — `lib/reactive-mic.ts`: patches `getUserMedia` so the app receives a
  test-controlled WebAudio stream. `speakText(page, '...')` synthesizes speech at
  runtime (`say` on macOS, espeak-ng on Linux) and speaks it mid-session, any
  number of turns, reacting to replies. Carries ~-68dBFS comfort noise (LiveKit
  mutes digitally-silent mics).
- **Ears** — `lib/audio-capture.ts` `startElementCapture(page)`: records everything
  `<audio>`/`<video>` elements play (works headless, no flags or permissions), plus
  millisecond `speech-start`/`speech-stop` energy events in `window.__osbornEars`.
  Verify what was SPOKEN by transcribing the capture (Deepgram REST).
- **Brain** — Stagehand (`@browserbasehq/stagehand`) attached to our Chrome over
  CDP; `stagehand.act('natural language goal')` handles gates and modals without
  selectors.
- **Steps dictionary** — `lib/steps.ts`: `ensureAgentInRoom`, `enterFreshRoom`
  (handles both session-gate variants; `{ earsOn: true }` records from page load
  so the greeting is captured), `waitForSpeechEvent`, `leaveRoom`, `logResult`.
- **Metrics** — every scenario appends a JSON line to `results/runs.jsonl`
  (stop latency, pivot latency, capture transcript, ...). Trend = aggregate it.

## Running specs
```bash
npx playwright test specs/osborn/stagehand-conversation.spec.ts   # 2-turn reactive conversation
npx playwright test specs/osborn/barge-in.spec.ts                 # interruption metrics
npx playwright show-report                                        # replays: video/audio/muxed
```
Replays per run land in `test-results/<test>/`: `agent-audio` webm, `screen-video`
webm, `replay-with-audio.webm` (muxed, time-aligned). `OSBORN_TEST_MONITOR=1` plays
the tester's voice on speakers during headed runs. Targets: `OSBORN_AGENT_URL`,
`OSBORN_APP_URL` (default `https://www.voice-native.com`); guest mode via
`/chat?...&agentUrl=<url>` needs no sign-in.

## Reviewing the media (the mechanics)
- Pull frames and read them: `ffmpeg -i replay.mp4 -vf "fps=1/5" /tmp/frames/f%02d.jpg`.
  Check entry, mid-flow and ending frames show the claimed state.
- Listen to or transcribe the audio capture when the claim is about speech.
- Read the devtools-diagnostics artifact and the flight log against the narrative.
- If frames contradict the assertions, the TEST is wrong: assert account-specific
  evidence (avatar/email, session counts, "Cloud (running)"), then rerun.
- Files on the machine's disk are invisible to the user. Upload each artifact and
  put its public URL in the reply (the `send-media` skill has the contract):
  `curl -s -X POST "https://www.voice-native.com/api/upload" -F "file=@clip.mp4"` → `.url`,
  rendered as `[Image: frame.png](URL)` or `[File: run.mp4](URL)`. Never upload
  anything holding a secret: the URL is public.

## Scenario store — workflows as files
`scenarios/<name>.yaml` is one stored workflow: `entry: fresh|resume`, optional
`viewport` (mobile), optional `url` (landing-page entry), `steps[]` (`act` ·
`say` · `waitSpeech` · `pause` · `assertScreen` · `upload`), and a
`conversation:` phase where an LLM tester improvises each utterance toward
`goal` (assert with `minAudibleReplies` / `assertHeard`). `meeting-join` needs
`OSBORN_MEETING_URL`.
```bash
OSBORN_SCENARIO=file-attachment npx playwright test specs/scenario.spec.ts
```
To store a new workflow, write a yaml; nothing else.

## Writing a new spec
Compose from steps: `ensureAgentInRoom` → launch Chrome with a CDP port → attach
Stagehand → `enterFreshRoom(page, act, url, { earsOn: true })` → speak/listen/assert
→ `logResult(scenario, metrics)` → attach replays. Copy
`specs/osborn/barge-in.spec.ts` as the template. Every spec has `test.afterEach` →
`POST /leave-room`: an abandoned empty room breeds the alone-timer/watchdog wedge.

## Site knowledge — the per-site profile
`knowledge/<hostname>/` holds `actions.json` (compiled UI actions, managed by the
step cache), `site.md` (findings the agent discovers) and `rules.md` (rules the
user taught — BINDING: read before operating on a site; append new user guidance
with `addSiteRule()` in `lib/knowledge.ts` so every later agent inherits it), plus
`journeys/`. Frame every directed engine test as a journey (`list` → `start` →
steps → `end`); pass `"save":false` to `end` for a failed or exploratory run.

## Portability
Specs attach over CDP, so any CDP endpoint works (a Browserless container:
`ws://host:3000/chromium/playwright?token=...`; pin `@playwright/test` to its
supported version). Linux/CI: the `mcr.microsoft.com/playwright` image plus
espeak-ng or OpenAI TTS for synthesis.
