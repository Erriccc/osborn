---
name: browser-screen-recorder
description: >
  Drives any web app in a REAL browser (natural-language clicks, speaks into
  the mic, hears and transcribes audio) and records proof — per-task video
  clips, screenshots, DevTools/network logs. Use whenever you are debugging
  anything web-reachable (never debug a frontend blind), ABOUT TO CLAIM a
  deployed web change works (no recorded proof = a claim, not a verification),
  reproducing a user-reported UI issue (mobile viewport included), testing a
  voice flow end-to-end, casting a live browser feed into a meeting, or
  exploring any website with evidence. Make sure to use this skill for any
  frontend debugging or web verification task.
---

# Browser Screen Recorder — see the web, prove what happened

## SKILL IDENTITY
Name: browser-screen-recorder
Version: 11
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

All commands and endpoints: references/harness-api.md.

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

## Rationalization table — these excuses are pre-refuted
| "…" | Reality |
|---|---|
| "All assertions passed" | Assertions once passed while the page showed "Local (offline)". Frames or it didn't happen. |
| "I watched the live stream" | Watching is not reviewing. Extract and read frames — they're what you can cite. |
| "It's just a quick exploratory run" | Exploratory runs still end with media delivered and a journey saved/discarded deliberately. |
| "The user is waiting" | An unverified report costs more than the 60 seconds review-run.sh takes. |
| "The brain said ok" | The brain has reported ok on clicks that hit nothing (stale cache, wrong tab). Ok is not evidence. |

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

## What's new in v11
- **Phone view (HLS)** — `/phone` on the live server serves a real `<video>`
  (H.264 HLS off the same display grab): native on iOS Safari, supports
  picture-in-picture, keeps playing minimized. ~5-10s latency; the MJPEG
  viewer at `/` stays for instant watching. Display-capture mode only.
  Honors the stream token (`/phone?key=…`).
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
