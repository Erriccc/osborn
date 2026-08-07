---
name: browser-screen-recorder
description: >
  Drives any web app in a REAL browser (natural-language clicks, speaks into
  the mic, hears and transcribes audio) and records proof — per-task video
  clips, screenshots, DevTools/network logs. THE QA PROTOCOL FOR UI WORK: use
  it IMMEDIATELY AFTER building, styling, or changing ANY frontend/UI — the
  final step of the build loop is recording proof at mobile + desktop widths,
  NEVER asking the user to eyeball or send screenshots of your own change.
  Also use whenever debugging anything web-reachable (never debug a frontend
  blind), about to claim a deployed web change works (no recorded proof = a
  claim), reproducing a user-reported UI issue, testing a voice flow
  end-to-end, casting a live browser feed into a meeting, or exploring any
  website with evidence. Make sure to use this skill after every UI change
  and for any frontend debugging or web verification task.
---

# Browser Screen Recorder — see the web, prove what happened

## SKILL IDENTITY
Name: browser-screen-recorder
Version: 23
Install path: ~/.claude/skills/browser-screen-recorder/SKILL.md
Harness path: ~/browser-screen-recorder-harness/
Served from: https://www.voice-native.com/api/browser-screen-recorder
Version probe (one GET): https://www.voice-native.com/api/browser-screen-recorder/version
(Formerly "voice-e2e"; old /api/test-skill URLs still resolve here.)

## IRON LAW
**NO RESULT REPORT WITHOUT FRAME-REVIEW EVIDENCE.** A green assertion is a
claim; a read frame is proof. Every run ends with media reviewed by you AND
delivered to the user. No silent runs.

## Which workflow? (route by the moment you're in)
- **Just built / styled / changed UI?** → BUILD-QA (the final step of every
  frontend change, not an option): deploy, then run a journey that renders
  the changed surface at BOTH mobile (`viewport:"mobile"`) and desktop
  widths; the frames are the proof you attach to your report. A deployed
  page change gets a fresh render captured BEFORE the next iteration starts.
  Asking the user "send me a screenshot / tell me if it looks off" for your
  own change is the anti-pattern this skill exists to kill.
- **About to claim a web fix/deploy works?** → VERIFY: run a journey that
  exercises the change; the clip is the verification. No clip = no claim.
- **Debugging a reported web issue?** → DEBUG: engine with `OSBORN_DEVTOOLS=1`
  (DevTools on camera), reproduce, read `GET /logs` (console+network) next to
  the video. Never diagnose a frontend from code alone.
- **User says "it looks broken / doesn't work on my phone"?** → REPRO:
  `/tab {"op":"open","url":…,"viewport":"mobile"}` — real 390×844 render.
- **Meeting needs a live browser on camera?** → STREAM: Fly engine's public
  MJPEG into canvas `stream` mode. NO tunnels. → references/streaming.md
- **Exploring/researching any site?** → RESEARCH: `OSBORN_ENTRY=none` +
  `OSBORN_APP_URL=<site>`; save what you learn as journeys.
- **Voice flow testing?** → VOICE: `/say` a riddle, `/hear` the reply —
  comprehension from AUDIO, never from the DOM.
- **User/operator says "can't hear / can't see / looks weird"?** → SYMPTOM:
  FIRST action is capturing media of both ends (engine frames + the user's
  view + relevant logs), never a code hypothesis. Diagnose from evidence.

## CAPABILITY MENU — everything the engine can hand you (don't drive blind)
You are NOT limited to clicking. Every one of these is on the running engine:

| Want | Get it via | Returns |
|---|---|---|
| Do an action + its proof | `drive.sh act "<nl>"` | video + frame (local files) |
| Speak / hear the app | `drive.sh say "<nl>"` | clip + `heard:` transcript |
| **Hear the agent (audio)** | `GET /audio` · `GET /clip?n=N&audio=1` | whole-run mp3 / a clip WITH the agent's voice muxed in (stream + clips are otherwise video-only) |
| **Console + network + websocket logs** | `drive.sh logs` (`GET /logs`) | per-tab console errors, failed requests, ws events |
| **DevTools panel ON the video** | boot with `OSBORN_DEVTOOLS=1` | Elements/Console visible in every clip |
| **Run JS in the page (site console)** | `drive.sh eval "<expr>"` | the value; also lands in /logs |
| Live event stream (navigation/task/transcript/agent_output) | `GET /events` (SSE) | push updates as they happen |
| Mobile / any viewport | `drive.sh tab '{"op":"open","url":…,"viewport":"mobile"}'` | real 390×844 render |
| Past-run media (after a restart) | `GET /clip?run=<stamp>&n=N`, `GET /runs` | old clips/frames |
| **Action-vs-process depth** | `drive.sh status` → `.depth` | `{pages, actions, kind, thin}` |
| Learned recipes for this site | `drive.sh journey '{"op":"list"}'` | saved processes + step counts |

FULL schemas/params/fields: **references/harness-api.md** — open it for exact
shapes; the menu above is so you KNOW the data exists and never drive blind.

## RUN CHECKLIST — copy this into your response and check items off
```
Run Checklist [browser-screen-recorder]:
- [ ] journey list → reuse a known recipe?
- [ ] journey start "<name>" (goal stated)
- [ ] activeTab verified before each act (acts on the wrong tab report ok)
- [ ] steps executed (act/say/tab/eval) — media returned per task
- [ ] clips + screenshots pulled (/clip?n= /artifact?n=)
- [ ] scripts/review-run.sh <clip> → frames READ (viewed, not listed)
- [ ] audio transcribed if speech was involved (heard/hear)
- [ ] /logs cross-checked against what I'm about to claim
- [ ] evidence stated: "Reviewed frames <which> — they show <X>"
- [ ] media delivered to the user
- [ ] journey end (cleanup + recipe saved)
```
**Gate:** the result report may only be written AFTER the evidence line. If
frames contradict the assertion, the run FAILED — return to the steps, don't
soften the report.

## DRIVE THE ENGINE WITH scripts/drive.sh — NOT raw curl
Raw curl makes media "sometimes": the response only carries a Fly-VOLUME PATH
for the clip, so relaying it is 4 separate skippable steps — and under
pressure the agent skips them (proven in a live diagnostic: the engine's own
`nag` fired on the first action because the media was never fetched). USE THE
ATOMIC DRIVER instead — it does action + media download + review-prompt as ONE
inseparable operation and EXITS NONZERO if no media came back:
```bash
cd ~/browser-screen-recorder-harness
scripts/drive.sh act "click the Logs label"      # → task N: ok; prints VIDEO+FRAME local paths
scripts/drive.sh say "what color is the sky?"    # → also prints `heard:`
scripts/drive.sh tab '{"op":"open","url":"…","viewport":"mobile"}'
```
Every `act`/`say` writes the clip + screenshot to `$BSR_OUT` (default /tmp/bsr)
and prints `REVIEW+SEND these to the user`. Because the command fails without
media, "action succeeded but media missing" is impossible — the reproducibility
problem is solved mechanically, not by remembering.

## LIVE RELAY — review and forward media DURING the run, not after
The loop is **drive → review → relay**, interleaved: run `drive.sh act …`, it
hands you a VIDEO and FRAME path, READ the frame, say what it shows, send both
to the user, THEN take the next step. A `nag` line means the previous clip was
never reviewed — a stop sign, not a suggestion. Post-hoc media dumps hide
mid-run failures (a modal false-ok was once caught ONLY because a frame was
read between steps). After any act on a modal/state-changing control, the NEXT
step is reviewing that frame — no exceptions.

## AUDIO CLAIMS NEED AUDIO PROOF
After any audio-path change (TTS route, meeting speech), do not declare
quality from code or logs: download the Recall bot's own recording
(`GET /api/v1/bot/<id>` → `recordings[0].media_shortcuts` → download_url)
and listen/waveform it. Frames prove pixels; only audio proves audio.

## Rationalization table — these excuses are pre-refuted
| "…" | Reality |
|---|---|
| "All assertions passed" | Assertions once passed while the page showed "Local (offline)". Frames or it didn't happen. |
| "I watched the live stream" | Watching is not reviewing. Extract and read frames — they're what you can cite. |
| "It's just a quick exploratory run" | Exploratory runs still end with media delivered and a journey saved/discarded deliberately. |
| "The user is waiting" | An unverified report costs more than the 60 seconds review-run.sh takes. |
| "The brain said ok" | The brain has reported ok on clicks that hit nothing (stale cache, wrong tab). Ok is not evidence. |
| "I'll ask the user to check / send a screenshot" | The recorder renders exact iPhone/iPad/desktop widths and records it. Outsourcing QA of YOUR change to the user's eyes is the failure mode this skill exists to kill. |

## MANDATORY VERSION CHECK — run FIRST
```bash
SERVED_V=$(curl -sf --max-time 10 https://www.voice-native.com/api/browser-screen-recorder/version | python3 -c "import sys,json; print(json.load(sys.stdin)['version'])" 2>/dev/null)
LOCAL_V=$(grep -m1 '^Version:' ~/.claude/skills/browser-screen-recorder/SKILL.md 2>/dev/null | awk '{print $2}')
if [ -n "$SERVED_V" ] && [ "$SERVED_V" != "$LOCAL_V" ]; then
  mkdir -p ~/.claude/skills/browser-screen-recorder
  curl -sS https://www.voice-native.com/api/browser-screen-recorder -o ~/.claude/skills/browser-screen-recorder/SKILL.md
  echo "SKILL WAS OUTDATED (local=${LOCAL_V:-none} served=$SERVED_V) — updated. STOP, re-read it, refresh the harness (INSTALLATION step 2)."
  exit 1
fi
echo "browser-screen-recorder v${LOCAL_V:-unknown} is current"
```

## INSTALLATION (one time — also the update path)
1. Save this file to `~/.claude/skills/browser-screen-recorder/SKILL.md`.
2. Materialize the harness (references/ + scripts/ ride along):
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
print(f"harness v{b['version']}: {len(b['files'])} files → {root}")
EOF
cd ~/browser-screen-recorder-harness && npm install && npx playwright install chromium
```
3. Keys (ask the user): `GOOGLE_API_KEY` REQUIRED (brain); `OPENAI_API_KEY`
   (mouth) and `DEEPGRAM_API_KEY` (verified hearing) recommended. Where the
   browser runs is ALWAYS the user's explicit choice: local launch (default),
   your own CDP endpoint, Browserless/Browserbase cloud, or the self-hosted
   Fly engine (references/harness-api.md → Self-hosting).

## References (in the harness dir — read the one your workflow needs)
- `references/harness-api.md` — every endpoint, journeys, env, self-hosting Fly
- `references/streaming.md` — live view, meeting casting, NO-TUNNELS policy, stream token
- `references/gotchas.md` — hard-won failure modes; read BEFORE debugging the harness itself or trusting a surprising result

## What's new in v23
- **Hear the agent — audio, not just video.** Clips + the MJPEG stream are
  VIDEO-ONLY; the agent's voice is captured separately. New `GET /audio` (the
  whole run as mp3) and `GET /clip?n=N&audio=1` (a clip with the aligned agent
  audio muxed in). `/say` + `/act` responses now carry `audioClipUrl`. On the
  cloud engine (no speakers) this is the ONLY way to hear the agent — the live
  stream never carries audio. Alignment maps wall-clock → recording time via the
  recording's own start, NOT the manifest's rel0/rel1 (skewed timeline — raw
  slicing returned silence).
- **Local audibility fix** — the ears' WebAudio tap was starving the `<audio>`
  element's speaker output, so the agent went silent on headed/local runs even
  though the element read muted=false/volume=1. The tap now also routes to the
  speakers (no-op on headless cloud).

## What's new in v21
- **Multi-agent RESILIENT (one engine, many drivers, safe)** — pass an
  `x-driver-id` header (any string identifying you). Your tabs are auto-owned;
  you act on YOUR OWN tab (brought to front under an action lock so drivers
  can't interleave in the one browser); acting on another driver's tab is
  REFUSED (409). No more spinning up a second engine or claiming a mission by
  hand — isolation is the default. `drive.sh` sets it from `BSR_DRIVER`
  (default your username). `/status` shows `drivers` + `tabsByOwner`.
- **drive.sh JSON-body bug fixed** — `${ARG:-{}}` appended a stray brace,
  making every journey/tab/eval call fail with "op must be…". This is why
  the mission lock never engaged.

## What's new in v20
- **CAPABILITY MENU in the main skill** — the full data menu (logs, DevTools,
  /eval, /events SSE, mobile viewport, cross-run media, depth, journeys) is
  now front-and-center, not buried in references/. Agents were driving blind,
  knowing only click+screenshot because the rest sat one file too deep.
- **drive.sh hardened** — clip fetch retries 3× (kills transient media misses,
  1/10 in the depth test) and journey/tab/eval POST bodies fixed.

## What's new in v19
- **Process-depth signal (action vs process)** — `/status.depth` = `{pages,
  actions, kind:"action"|"process", thin:bool}`. A single navigation shows
  `thin:true` LIVE so robotic one-link runs are visible; a real exploration
  climbs (pages:5, actions:12, kind:process). journey_end reports depth and
  flags "THIN: single navigation, not exploration". The infra now distinguishes
  and MEASURES the two, per site, so directors (and you) can see when a
  "process" was actually just an action.
- **Auto-update** — the version check now auto-pulls the new skill (first-party
  tooling; no prompt), matching the always-current cloud engine.

## What's new in v18
- **Atomic driver `scripts/drive.sh`** — one command = action + media
  download + review-prompt, and it EXITS NONZERO without media. Fixes the
  "actions don't reliably return media" problem mechanically (a live
  diagnostic proved raw-curl driving skips the 4-step media retrieval).
- Removed the inline `keyframeB64` from act/say responses (66KB base64 made
  responses 71KB and broke strict JSON parsers); `clipUrl`/`artifactUrl`
  point at the retrieval endpoints instead.
- Screenshot fallback: `artifact` falls back to the live stream frame when
  page.screenshot fails in headful mode (was returning null → /artifact 404).

## What's new in v17
- **Idle window 10 → 15 minutes** (container default) — more breathing room
  for gates, meetings forming, and slow human steps before self-sleep.

## What's new in v15
- **No chat-tab restore** — tab restore skips /chat tabs (the boot flow owns
  the session tab); restoring one created a second room participant and broke
  the session gate (2026-08-02 live-test churn).

## What's new in v14
- **Meeting-aware self-protection** — the engine detects an active meeting on
  its own page: idle-stop DEFERS while a Meet/Zoom is live (journey or not),
  and shutdown SKIPS the Disconnect click + /leave-room during meetings so an
  engine drop rides the agent's 75s leave-grace instead of killing the
  copilot. (Real incident: 10-min idle stopped the engine mid-Meet; its
  shutdown clicked Disconnect; the bot sat deaf in the call.)

## What's new in v13
- **Mission lock + hold-awake** — `journey start` with an `owner` claims the
  engine (`mission` in /status; a second owner's start gets 409); an open
  journey suspends idle-stop (2h cap). Born of two real mid-mission machine
  kills, one from each driving agent.
- **Live relay support** — act/say responses carry `keyframeB64` inline + a
  `nag` when the previous clip was never fetched (the act-verify gate's
  teeth). New LIVE RELAY doctrine: act → review → relay, interleaved.
- **Cross-run media** — `GET /runs` lists all runs on the volume;
  `/clip?run=<stamp>&n=N` (and /artifact) reach past runs (they used to 404
  after every restart).
- **Symptom + audio doctrine** — "can't hear/see/looks weird" → capture
  media first; audio claims require the Recall recording, not logs.

## What's new in v12
- **QA-protocol triggers** — this skill is the FINAL STEP of every UI build
  loop: after changing frontend code, record proof at mobile + desktop widths
  instead of asking the user to eyeball your change (new BUILD-QA workflow +
  rationalization row).

## What's new in v11
- **CI deploys** — pushes touching the harness auto-deploy the cloud engine
  (GitHub Action), completing "git push = release" for skill, bundle, AND
  engine.
- **Clean installs** — osborn's own app tests moved to `specs/osborn/`
  (repo-only); the installable bundle now ships ONLY the generic harness +
  generic proof specs.

## What's new in v10
Restructured for enforcement (borrowing Anthropic skill-authoring + superpowers
patterns): frontmatter trigger contract, Iron Law, workflow router, copyable
run checklist with a hard gate, rationalization table, references/ split
(progressive disclosure), `scripts/review-run.sh` (deterministic review).
Engine features by version: v9 generic entry + stream token + cache target
validation; v8 tab economy + staleness sweep + activity events; v7 SSE
/events + webhooks; v6 journeys + full-window capture + /eval.
