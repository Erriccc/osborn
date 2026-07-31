# Browser Screen Recorder — drive any web app (with a voice, hands + a brain) and record proof

## SKILL IDENTITY
Name: browser-screen-recorder
Version: 7
Install path: ~/.claude/skills/browser-screen-recorder/SKILL.md
Harness path: ~/browser-screen-recorder-harness/
Landing page: https://www.voice-native.com/browser-screen-recorder
(Formerly "voice-e2e". The old /api/test-skill and /test-skill URLs still resolve
to this skill for backwards compatibility.)

Give a coding agent a web app + an intent ("log in and start a call", "join this
meeting", "check the upload flow") and this skill drives it in a REAL browser and
records PROOF that it did — screenshots, video clips, transcribed audio, DevTools
diagnostics, and structured metrics for every step. It can speak into the page's
microphone (synthesized on the fly), hear and transcribe everything it plays back,
click around via a natural-language brain (Stagehand, no selectors), and improvise
multi-turn conversations. Works on ANY website — nothing is injected into the page
and no backend access is assumed.

Input: a target URL + what you want done. Output: it doing that, plus the media
and metadata that prove it (per-action screenshot + mp4, audio capture, metrics).

## WHEN TO USE (broad — reach for this whenever the web is involved)
This is not just a test tool. It is the standard way for an agent to SEE and
PROVE the web. Trigger it for:
1. DEBUGGING anything web-reachable — MANDATORY step: reproduce the issue in
   the real browser, DevTools on camera (OSBORN_DEVTOOLS=1), read /logs
   (console + network + websockets) alongside the video. Never debug a
   frontend blind from code alone.
2. VERIFICATION — MANDATORY before claiming a deployed web change works: run a
   journey that exercises the change and attach the clip. "It works" without
   recorded proof is a claim, not a verification.
3. Reproducing user-reported issues — including mobile (`/tab` with
   `viewport:"mobile"` = real 390×844).
4. MEETINGS — the engine is the approved cast source for the meeting canvas
   (`stream` mode: its public MJPEG feeds the bot's camera; NO tunnels), and
   it can drive the meeting-join UI itself.
5. Research/exploration of ANY website — browse with proof, accumulate
   journeys and site knowledge as you go.
6. Voice testing (the original use) — mouth/ears/brain full loop.

MEDIA EVERY TIME: every engine task returns a clip + screenshot + devtools
state + (for /say) heard audio. Review it, then DELIVER the media to the user
on every use — no silent runs, ever.

## What's new in v7
- **Live event subscription** — `GET /events` (SSE, token-guarded): subscribe
  on the existing session and receive every event live — navigations ("the
  browser got forwarded"), task completions (with /clip & /artifact URLs), tab
  changes, journey saves, page errors, and lifecycle (`engine_stopping` fires
  BEFORE sleep so a dead stream is never a mystery). Last 25 events replay on
  connect.
- **Outbound webhooks** — set `OSBORN_WEBHOOK_URL` (+ optional
  `OSBORN_WEBHOOK_TOKEN`) and the same events POST to any receiver when no
  subscriber is connected. `/webhook-sink` is a built-in delivery-proof
  receiver.
- **One-GET version probe** — `GET /api/browser-screen-recorder/version`
  returns `{"version":N}`; the update check below uses it (no full download to
  detect drift).
- **Single-source updates** — this skill text + the harness bundle both build
  from the repo on every push; a git push IS the release.

## What's new in v6
- **Journey learning layer** — `POST /journey {op:start|end|list}`: frame
  every test as a named journey; `end` cleans up (closes extra tabs, resets
  viewport) and saves the proven step sequence to
  `knowledge/<site>/journeys/<name>.yaml`. Each deployment LEARNS its sites'
  real paths over time; consult `journey list` before acting.
- **Full-window capture** — headful Chrome on a virtual display (Xvfb +
  openbox + x11grab): real tab strip, URL bar, and cursor in the stream and
  clips, at true real-time speed.
- **DevTools on camera** (`OSBORN_DEVTOOLS=1`) + `POST /eval` (drive the
  page console programmatically; output lands in /logs).
- **On-demand lifecycle** — visiting the live URL wakes a stopped Fly machine
  (~40s to pixels, "waking up" screen); the engine self-stops after idle
  (OSBORN_IDLE_STOP_MS) and restores its tab layout on the next wake.
- **Multi-agent tab registry** — tabs can be claimed per director
  (`owner`); acts on someone else's tab are refused (409).
- **Per-task debug data** — every task response carries console/network
  state; `GET /logs` serves full buffers; `GET /clip?n` + `GET /artifact?n`
  download the proof media remotely.

## What's new in v5
- **Renamed voice-e2e → browser-screen-recorder.** Same harness, clearer name:
  the point is recording verifiable proof of what happened in the browser. Old
  install paths (`~/.claude/skills/voice-e2e`, `~/voice-e2e-harness`) and the
  `/api/test-skill` + `/test-skill` URLs keep working.
- **Per-action media, mandatory review.** Every `/act` and `/say` on the
  session-engine returns BOTH a screenshot AND a short mp4 clip (rolling
  screencast buffer → ffmpeg). ALWAYS review the returned media to confirm the
  action actually did what was asked — never trust the text result or a green
  status alone (the brain can report "ok" on a click that didn't land).
- **Persistent session-engine** (`scripts/session-engine.ts`): long-running
  director-controlled browser (`/act /say /hear /shot /clip /tab /recover /end`)
  with live stream + per-task video + task-window ledger. Keep tabs alive; open
  new tabs for parallel work.
- Meeting canvas + Recall output_media patterns for meeting-copilot flows.

## MANDATORY VERSION CHECK — run FIRST before any run
One cheap GET against the dedicated version route:
```bash
SERVED_V=$(curl -sf --max-time 10 https://www.voice-native.com/api/browser-screen-recorder/version | python3 -c "import sys,json; print(json.load(sys.stdin)['version'])" 2>/dev/null)
LOCAL_V=$(grep -m1 '^Version:' ~/.claude/skills/browser-screen-recorder/SKILL.md 2>/dev/null | awk '{print $2}')
if [ -n "$SERVED_V" ] && [ "$SERVED_V" != "$LOCAL_V" ]; then
  mkdir -p ~/.claude/skills/browser-screen-recorder
  curl -sS https://www.voice-native.com/api/browser-screen-recorder -o ~/.claude/skills/browser-screen-recorder/SKILL.md
  echo "SKILL WAS OUTDATED (local=${LOCAL_V:-none}, served=$SERVED_V) — updated. STOP and re-read the new instructions, then re-run the harness update in INSTALLATION step 2."
  exit 1
fi
echo "browser-screen-recorder skill ${LOCAL_V:-unknown} is current"
```
If this exits non-zero: re-read this file and refresh the harness files
(INSTALLATION step 2) before running anything. Offline → proceed with local.

## INSTALLATION (agent-executable, one time — also the update path)
1. `mkdir -p ~/.claude/skills/browser-screen-recorder ~/browser-screen-recorder-harness`
   and save this file to ~/.claude/skills/browser-screen-recorder/SKILL.md if not
   already there.
2. Download the harness bundle and write every file:
```bash
curl -sS https://www.voice-native.com/api/browser-screen-recorder/bundle -o /tmp/bsr-bundle.json
python3 - << 'EOF'
import json, os
b = json.load(open('/tmp/bsr-bundle.json'))
root = os.path.expanduser('~/browser-screen-recorder-harness')
for rel, content in b['files'].items():
    p = os.path.join(root, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, 'w').write(content)
print(f"harness v{b['version']}: {len(b['files'])} files written to {root}")
EOF
cd ~/browser-screen-recorder-harness && npm install && npx playwright install chromium
```
3. Configuration (ask the user for BOTH; put them in the environment or
   ~/browser-screen-recorder-harness/.env):
   - BSR_BROWSER_URL — WHERE the browser runs (security: always the user's
     explicit choice, never implicit). One line, three shapes:
       (blank)                                  → launch Chrome locally
       http://localhost:9222                    → attach to your own long-lived
                                                  Chrome / Docker container
       wss://production-sfo.browserless.io?token=...   → Browserless cloud
       (Browserbase session connectUrl)         → Browserbase cloud
     Fly-hosted engine: deploy the included fly.toml and trigger runs there
     instead of attaching a remote browser.
     (Legacy `VOICE_E2E_BROWSER_URL` is still honored.)
   - GOOGLE_API_KEY — REQUIRED. Powers the Stagehand brain (Gemini Flash).
     Get one at https://aistudio.google.com/apikey (free tier works).
   - OPENAI_API_KEY — recommended. Natural TTS mouth + conversation tester.
     Without it the mouth falls back to say/espeak and improvised
     conversations are unavailable.
   - DEEPGRAM_API_KEY — recommended. Lets the harness VERIFY speech by
     transcribing what it heard. Without it audio is recorded but unverified.
   Export before running: `export OSBORN_ENV_FILE=~/browser-screen-recorder-harness/.env`

## SELF-HOSTING THE CLOUD ENGINE (optional, deploy-and-forget)
The bundle ships Dockerfile + fly.toml. From the harness dir: `fly launch`
(or `fly deploy` into an existing app), `fly ips allocate-v4 --shared` +
`fly ips allocate-v6` (Machines-API-created apps get NO public IPs without
this), and set secrets: GOOGLE_API_KEY (+ OPENAI/DEEPGRAM as above) and
OSBORN_ENGINE_TOKEN (REQUIRED — the control port is public). You get:
wake-on-visit (~40s to live pixels), idle self-stop, full-window capture,
state restore across sleep. UPDATING a deployed engine = `fly deploy` from a
fresh bundle; the version probe above tells you when you're out of date.

## TWO MODES
- SHORT one-shot: `OSBORN_SCENARIO=<name> npx playwright test specs/scenario.spec.ts` — fire a scenario, get a clip, done.
- LONG-RUNNING: `npx tsx scripts/session-engine.ts` — ONE persistent browser that STAYS ALIVE, streams live, holds its room, and takes commands over HTTP (:8781: /status /tasks /act /say /hear /shot /eval /tab /journey /clip /artifact /logs /events /webhook-sink /brain /recover /end; token-protect with OSBORN_ENGINE_TOKEN) with a live viewer (:8080, or the Fly machine's public URL). Hook in, act, open tabs, get feedback — never abruptly closes. This is the director-controlled mode.

## USAGE — record any website
Point the runner at a target and a scenario:
```bash
cd ~/browser-screen-recorder-harness
OSBORN_APP_URL=https://your-app.example \
OSBORN_SCENARIO=talk-to-agent \
npx playwright test specs/scenario.spec.ts
```
Scenarios are plain YAML in scenarios/ — goal-driven, improvised
conversations plus deterministic steps (act/say/upload/assertScreen). Write
a new .yaml and the runner picks it up. Artifacts per run in test-results/:
video, audio capture, replay-with-audio.webm (muxed), devtools diagnostics,
and metrics appended to results/runs.jsonl.

## DOCTRINE (binding for the supervising agent)
- VERIFY THE MEDIA: after each run, extract frames (ffmpeg -vf fps=1/5) and
  READ them; transcribe audio claims; never report a green assertion without
  checking the replay agrees. Then deliver the media to the USER — every use.
- FRAME EVERY TEST AS A JOURNEY: `journey list` first (reuse known paths),
  `journey start` before acting, `journey end` after (cleanup + save). Tasks
  without framing are disconnected robot actions that teach the site nothing.
- Site knowledge lives in knowledge/<hostname>/ — cached UI actions
  (self-healing), rules.md (user-taught, binding), site.md (findings),
  journeys/ (learned sequences). Read rules before operating on a site;
  append what you learn.
- Every run must end gracefully (the runner's outro leaves sessions via the
  UI) and always leave any voice room before exiting.
- The recorder uses ONLY frontend senses (screen, audio, DevTools). If YOU have
  backend access to the target, watch it in parallel and correlate.

## CLOUD RUNNER (optional)
The harness ships Dockerfile + fly.toml for a self-stopping Fly.io runner
machine (run-on-start, artifacts to a volume). See fly.toml comments and
SELF-HOSTING above.
