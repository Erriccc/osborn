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
Version: 61
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
  `/tab {"op":"open","url":…,"viewport":"mobile"}` — an emulated iPhone 13
  (touch, mobile user agent, 3× pixels, `(hover:none) and (pointer:coarse)`
  match), signed in like your desktop tabs. `"tablet"` = iPad (gen 7).
- **Meeting needs a live browser on camera?** → STREAM: cast your tab
  (`/tab {"op":"cast","i":n}`), then put the Fly engine's public MJPEG into
  canvas `stream` mode. NO tunnels. → references/streaming.md
- **Exploring/researching any site?** → RESEARCH: `OSBORN_ENTRY=none` +
  `OSBORN_APP_URL=<site>`; save what you learn as journeys.
- **Testing a PR / deploy / journey that takes more than 3–4 actions?** →
  TESTER MODE: hand the goal to a background tester agent that logs every
  step to a ledger, reads an inbox for steering, and files what it trips over
  as findings — you stay free and nothing is lost if it gets stuck.
  → references/tester-mode.md
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
| **Hear the agent (audio)** | `GET /audio` · `GET /clip?n=N&audio=1` | your tab's mp3 / a clip WITH the page's audio muxed in (`X-Clip-Audio: yes\|none`; stream + clips are otherwise video-only) |
| **Console + network + websocket logs** | `drive.sh logs` (`GET /logs`) | per-tab console errors, failed requests, ws events |
| **DevTools panel ON the video** | boot with `OSBORN_DEVTOOLS=1` | Elements/Console visible in every clip |
| **Run JS in the page (site console)** | `drive.sh eval "<expr>"` | the value; also lands in /logs |
| Live event stream (navigation/task/transcript/agent_output) | `GET /events` (SSE) | push updates as they happen |
| Phone / tablet / any viewport | `drive.sh tab '{"op":"open","url":…,"viewport":"mobile"}'` (or `"tablet"`, or `{"width":…,"height":…}`) | emulated iPhone 13 / iPad (gen 7) with touch; a size is a desktop window resized |
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

**No harness checkout (curl only)?** The control API is `<engine>/control/<endpoint>`
(deployed: `https://osborn-voice-e2e-n.fly.dev/control`), JSON bodies, `x-engine-token`
when the engine has one, `x-driver-id: <you>` on every call. Open your OWN tab first:
```bash
E=https://osborn-voice-e2e-n.fly.dev/control; H=(-H 'content-type: application/json' -H "x-driver-id: me" -H "x-engine-token: $TOKEN")
curl -s "${H[@]}" -X POST $E/tab -d '{"op":"open","url":"https://example.com"}'   # your tab; navigate/act/shot go to it
curl -s "${H[@]}" -X POST $E/act -d '{"instruction":"click Learn more"}'           # → evidence.screenshot / evidence.clip (public URLs)
curl -s "${H[@]}" -X POST $E/input -d '{"type":"key","key":"Enter"}'              # a real key press (submit a form); also type|click|scroll
curl -s "${H[@]}" -X POST $E/shot -d '{}'                                         # → evidence.screenshot (add "inline":true for base64)
curl -s "${H[@]}" -X POST $E/tab -d '{"op":"close"}'                               # close your tab when done
```
Check `ok` on every reply: `/act` returns `ok:false, code:"noop"` when nothing on the page
matched. Reading page content: use `/eval` (there is no extract endpoint).

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
- `references/tester-mode.md` — delegated tester: ledger + inbox + step budget, brief template, supervisor takeover, dual view (backend ground truth), a spec's flight-log/assist loop
- `references/playwright-harness.md` — short mode: mouth/ears/brain/steps, running specs, reviewing media, scenarios, site knowledge, portability
- `references/gotchas.md` — hard-won failure modes; read BEFORE debugging the harness itself or trusting a surprising result

## What's new in v61
- **`/say` bounds copying and decoding the recording too, and copies only what is new.** Each turn copies just the audio recorded since the last peek out of the page; a decode that runs out of the turn's time returns "nothing transcribed: decoding the recording ran out of time" instead of hanging. A tab whose recording is past the 30-min decode cap says so in the `/say` warning, and `GET /status` shows `ears` (recording age against the cap) and `capturePaused` (idle screen-capture pause, which a `/status` read does not wake). Say tasks carry `hearSpan` and `clipSpan` (wall-clock ms) so a transcript and its clip can be compared.

## What's new in v59
- **A timed-out act holds the action lock until it has stopped.** Past `OSBORN_BRAIN_TIMEOUT_MS` the engine cancels the call and waits up to 15s for it to stop before the next action runs; a call still running after that is logged in the run's marks.

## What's new in v58
- The evidence-log redactor now also masks npm, AWS, PEM private-key, Fireworks and Soniox keys, and secret assignment values (`PASSWORD=…`, `token=…` keyword arguments, symbol-start or quote-split values).

## What's new in v57
- **A timed-out act never acts late.** Past `OSBORN_BRAIN_TIMEOUT_MS` the call is cancelled before it can start a new click or type (v59 also waits for it to stop); `/journey start` with the recovered journey's own name, from the driver who owned it, continues it with its steps and replies `continued:true`.

## What's new in v56
- **A deploy no longer drops your request silently.** A command in flight when the engine stops (a deploy or restart) gets `503 engine_restarting` with `retryable:true` and `retryAfterSec`, not an empty 502: wait, check `/status` (`restartRecovered`, `previousRun`) and send it again — the active journey carries over. `drive.sh say` re-attaches on it.
- `/journey end` of another driver's journey is `409 journey_owned` while that driver is still sending commands (a journey whose owner went quiet for 10 minutes can still be ended). Cleanup closes the journey owner's tabs and hands back a tab they had taken over instead of closing it.
- `/tab navigate` makes that tab your current tab: your next `/act` runs there. `x-driver-id` is trimmed and a `person:` id lowercased, so one driver is one driver whatever the spelling.
- `drive.sh` parses `BSR_ENGINE` with a real URL parser: query, fragment and trailing slashes are dropped, scheme and host lowercased, IPv6 understood, no scheme means `http://`; a URL with `user:pass@` or another scheme is refused, and `BSR_IP` is ignored (with a warning) for an IP or loopback host.

## What's new in v55
- **The live view is private.** The public viewer (`https://<app>.fly.dev/`) and its `/stream` no longer follow whichever tab is fronted: they show only a tab a driver cast, else a "Nothing is being shared" frame. `/tab {"op":"cast","i":n}` shares one of YOUR tabs there (`409 not_your_tab` for anyone else's); `/tab {"op":"uncast"}` stops it (the caster or the tab's owner). Closing or releasing the tab stops it too. `/status.cast` and every `/tab` reply say which tab is cast. **Casting into a meeting: cast your tab first**, then point the canvas at the engine as before.
- Any ownership change of a cast tab (takeover, handback, release, `/end`) stops the cast, so a person signing in is never broadcast; the owner casts it again afterwards. Tab 0 (the voice room) is never cast: `409 room_tab`. The cast survives an engine restart (with its tab).
- **People see only their own tabs.** For a /browser panel person (`x-driver-id: person:<email>`) the only tab they can see or act on is one they own. Unowned tabs, tab 0 (the voice room) included, are invisible and untouchable to them, like every other driver's tab. `claim`, `switch`, `navigate`, `close` and `release` of any tab they do not own are `409 not_your_tab`; `takeover` works only on an agent's tab, and releasing a taken-over tab hands it back; releasing their own-profile tab closes it. With no tab of their own, `/act`, `/say`, `/shot`, `/hear` and `/recover` are `409 no_own_tab` (never tab 0). Other people appear only as `"person"`, and `/end` tells a person how many others still use the engine, not who.
- People cannot take, claim or switch to tab 0 even after an agent claimed it (`409 room_tab`). A person who took control of a tab gets its `/logs`, `/audio` and `/hear` only from the moment they took control. A person's clips come only from their own tab's recording (no clip rather than the shared screencast). `/status` shows a person only their own journey (`journey`/`mission` null otherwise) and counts only their tasks. `/end {"shutdown":true}` from a person is `409 engine_in_use` while other drivers still hold tabs. Agents and the default driver can still watch any tab, tab 0 included, on `GET /stream` (no `tab`: their current tab).
- What a person reads is scoped the same way: `/status` and every `/tab` reply show only their own tabs' URLs (other tabs are listed with `url:""`; no marks); with no tab of their own `/status` says `activeTab:null, pageState:"none"`. `/tasks`, `/clip`, `/artifact` (`403 not_your_task`), `/logs`, `/audio` and `/stream` cover only their tabs; `/events` sends them only events with no tab at all (engine status) or about their own tabs, so tab-0 transcripts and navigations never reach them. A tab is theirs from the moment `/tab open` starts loading it. Agents with the engine token, and the default driver, keep the full view.
- **Watch your own tab:** `GET /stream` on the control API (token + `x-driver-id`) is MJPEG of your current tab, following it as you switch; `?tab=i` picks another tab you own (`409 not_your_tab` otherwise). With no tab of your own it shows "Nothing is being shared". The in-app /browser panel uses this, so each person sees only their own tab (and needs the engine token on the web app).
- A public engine with no `OSBORN_ENGINE_TOKEN` now locks its control API: every route answers `503 engine_token_missing` (only `GET /health` and signed `/media` links still work). `GET /health` reports `tokenRequired` and `tokenConfigured`. A local run with no Fly app or public URL stays open, and says so at boot.
- `/shot` refuses a tab another driver owns (`409 tab_owned`, like `/eval`). A failed shot is still a task: the `500 no_screenshot` reply carries its `task` number and log link.
- A screenshot that times out never falls back to another tab's frame: you get `no_screenshot` (or `artifact:null`) instead of a picture of the wrong tab.
- `/tab close` and `/tab navigate` with no `i` act only on a tab you own (your current one, else the newest you own), never tab 0 (the voice room) or an unowned tab; with none it is `409 no_own_tab`. Pass `"i"` to act on another tab explicitly. After a close, `/tab list` reports your real tab, never a closed one at `i:-1`.
- A navigation that lands on another page of the same host (http→https, a trailing slash, `/login` → `/dashboard`) is a success with `redirectedTo`, not `502 nav_failed`. `netError` keeps codes with digits (`net::ERR_HTTP2_PROTOCOL_ERROR`). When `/tab open` reuses a same-site tab and the load fails, the error comes back with `reusedTab` (the tab now showing it) instead of a fresh tab opening silently.
- `clipUrl`, `audioClipUrl`, `artifactUrl`, `resultUrl` and webhook links are absolute whenever the engine knows its public URL, like `evidence`. Signed `/media` links answer `HEAD`.

## What's new in v54
- `/act` can fill a field but does not reliably press keys: "type X and press Enter" leaves X in the box unsent. Press the key yourself: `POST /input {"type":"key","key":"Enter"}` (Playwright key names: `Enter`, `Tab`, `Escape`, `ArrowDown`, `Control+A`). `/input` also takes `{"type":"type","text":…}` (real keystrokes into the focused field), `{"type":"click","x":0.5,"y":0.5}` (fractions of the frame) and `{"type":"scroll","dy":600}`, on your own tab.
- Setting a field's value from `/eval` does not submit a React form; a synthetic `keydown` does not either. Use `/input`, or `form.requestSubmit()` from `/eval`.

## What's new in v53
- `viewport:"mobile"` is now a real phone: the tab opens in its own browser context from Playwright's `iPhone 13` descriptor (touch, iOS user agent, devicePixelRatio 3, 390×664 page), so `(hover:none)`/`(pointer:coarse)` CSS and touch-only code run. `viewport:"tablet"` = `iPad (gen 7)` (810×1080, 2×). A `{width,height}` viewport is still a desktop window resized.
- The device tab starts with the same sign-ins (cookies, localStorage) as your desktop tabs; a sign-in made inside it is not saved back. It is reused only for another open with the same device, and its context closes with its last tab.
- `/tab` replies, `activeTab` and `/status.tabs` mark device tabs (`device`, `emulates`). `/act`, `/eval`, `/shot` and clips work on them; screenshots come at device pixels (1170 px wide for the phone).
- `/act` always acts on your own tab. When the action opens a new tab (a `target=_blank` link, `window.open`), that tab becomes your tab: the reply's `effect.openedTab` names it, its screenshot is the reply's artifact, and your next `/act` runs there. `/tab {"op":"switch","i":…}` goes back.
- It is Chromium emulating a phone, not iOS Safari: Safari-only behaviour (zooming into a focused field under 16px, safe-area insets, rubber-band scrolling) does not happen. Check those with `/eval` (a field's computed `font-size`) instead.

## What's new in v52
- A stuck command no longer freezes the engine: after 4 minutes (`OSBORN_LOCK_MAX_MS`) the next driver's command may run, while the stuck caller still gets its own answer.
- Low memory (under `OSBORN_MIN_FREE_MB`, default 300) closes the least recently used tab that no working driver owns or is in; `/status.freeMemoryMb` shows what is left. After a restart at most 3 tabs are reopened (`OSBORN_RESTORE_MAX`): the active tab and owned tabs first. Close tabs you are done with.
- A plain scroll (`/act "scroll down"`) works while the brain is down: it never used the brain.

## What's new in v51
- Every engine reply, `/events` event and webhook is redacted like the public logs: tokens, keys and `NAME=secret` values in URLs, transcripts and results read `••••`. Only `/eval` values and `/shot`'s `jpegB64` are raw, so read a raw URL (an OAuth callback, a magic link) with `/eval` `location.href`. Spoken-turn clip captions are redacted too; the audio track cannot be.

## What's new in v50
- `/say` and `/hear` find the reply by position in the recording, not by wall clock. On a CPU-throttled engine the tab's audio ran slower than real time (0.37x measured), so wall-clock windows landed in the wrong part of the recording and came back "nothing heard". Clip audio is aligned the same way.
- `ears.audioClock` (in `/say`, `/hear` and every `ears` object) is how fast the tab's audio ran over the last 30s; 1 is real time. Under 0.9, `/say` adds a warning: the recording is time-compressed against the video and the page may have heard and played audio slowed down.
- The screencast fits 960×540 while nobody watches the live stream (clips are 640 wide, so they lose nothing) and 1280×720 while someone does, to keep the engine's CPU under its share. Per-tab clip recorders always use the smaller size.

## What's new in v49
- Public evidence logs hide more credential shapes (`Authorization: Token|Basic …`, `NAME=secret` settings, Google `AIza…`, GitHub `ghs_/ghu_/ghr_`, Fly tokens, `session_token`-style URL parameters) using the same redactor as the Voice Native app; hidden values read `••••`.

## What's new in v48
- `/say` keeps working after the page stops its mic (a hang-up, a mic toggle, a LiveKit reconnect): each `getUserMedia` call gets its own copy of the synthetic mic, so a restarted call hears you. The no-mic error now says to start the page's mic or call first.
- The ears hear more: sound the top page plays through WebAudio (no `<audio>` element; not inside iframes) is recorded once, an element whose call ended and restarted (new tracks) is recorded again, and a muted element (a page's own mic or camera preview, a muted participant) is not recorded while it is muted.
- `/act` arms the ears on its tab, so `GET /clip?n=N&audio=1` carries what the page played during the action, delayed to match the picture when the recording began mid-action. An action that navigates to a new page starts a fresh page with no recording, so its clip is video only until the next `/act`, `/say` or `/hear` on that page. The reply has header `X-Clip-Audio: yes` when an audio track was muxed in (it can still be silent) or `none` when no page audio could be added (video only): the tab recorded nothing during the clip, or the task's tab has since closed or moved to another URL.
- `GET /audio` reads YOUR tab, not whichever tab another driver fronted last. With nothing recorded yet it returns 404 with `ears`; it never arms them itself (`/act`, `/say` or `/hear` does), so have the page play audio, then call again.

## What's new in v47
- Evidence logs no longer leak secrets: tokens in URLs (a LiveKit room's `access_token`, OAuth `code`, `#access_token=` fragments, api keys) and any JWT are blanked in the public `/media/<run>/<n>.txt` log and the DevTools buffers.
- A detached brain heals itself: `/act` re-initialises it once before answering `brain_unavailable` (after a failed try it waits a minute before trying again). A `brain_unavailable` whose error says *re-initializing* means a revive is already running: retry in a few seconds, do not `POST /brain`. If you still get `brain_unavailable`, `POST /brain {}` re-picks it without restarting the engine; `/eval`, `/tab` and `/shot` keep working meanwhile.

## What's new in v46
- `/act` returns `ok:false` with `code:"noop"` when the brain found nothing to do (it used to say `ok:true` plus a warning). A compound instruction can still do only part of the job: check `result.did` and the screenshot.
- `/tab navigate` and `/tab close` with no `i` act on YOUR tab, not whichever tab another driver fronted last. `drive.sh act` prints NOOP and exits 5 when nothing matched.
- Navigation errors are clean: `400 bad_url` for a non-http(s) or malformed URL, `502 nav_failed` with `netError` for a failed load, and no error when the page loaded anyway.
- A failed `/act` clip returns `clipUrl:null` and keeps its `clipError` on `/clip?n=N`. Malformed JSON gets `400 bad_json`; an instruction over 4,000 characters gets `413 too_large`.
- `/shot` no longer inlines the image as base64 unless you pass `"inline":true` (or `?inline=1`); use `evidence.screenshot`. It now returns `ok:true`.
- A plain curl quick-start is in "DRIVE THE ENGINE" above.

## What's new in v45
- A `/say` clip that fails after the reply now says why: `/clip?n=N` and its public evidence link return 404 with `clipError` (the encoder's message) instead of a bare "not found". Retry the say, or use `/audio` for the voice.

## What's new in v44
- `drive.sh` works against the deployed engine with no setup beyond the token: its default is the public control URL (`https://osborn-voice-e2e-n.fly.dev/control`), and any `BSR_ENGINE` URL with a path or port is parsed correctly. It no longer pins a fixed IP (set `BSR_IP` only if DNS fails).
- `/shot` returns `task` and public `evidence` links, so a desk review can attach a screenshot without a fake `/act`. `/act` returns `task` at the top level.
- Opening a clip through its public evidence link counts as reviewing it (the "clip was never fetched" nag clears).
- The tab label in screenshots is small and sits bottom-left, so it no longer covers page headers.
- Ending a journey already closes your tabs; a following `/end` reports 0 closed.

## What's new in v43
- `drive.sh` sends `x-profile` from `BSR_PROFILE=<name>` (as it sends `x-driver-id` from `BSR_DRIVER`). Two different driver ids from one machine make multi-driver behaviour (takeover, scoped `/end`, profile isolation) testable.
- To record voice (`/say`, ears, clips) in a real signed-in session, sign in once under your profile (see v40); a person may need to hand you a one-time code.
- **Every issue gets evidence:** paste the `evidence.markdown` from the response; even a desk proposal can attach a `/shot` of the current screen.

## What's new in v42
- `POST /end {"keep": true}` closes your tabs and never stops the engine, even when you are the last driver (the /browser panel's "Close my tabs").
- Evidence links (`evidence.screenshot`, `.clip`, `.log`, `.markdown`) are always absolute public URLs on the deployed engine, whichever port you called, so they render when pasted into an issue. `https://<engine>/media/…` also works without the `/control` prefix.

## What's new in v41
- Sign-ins in the shared profile (no `x-profile`) now survive restarts too. Profiles keep cookies and localStorage, not IndexedDB. Profile names ignore case and extra spaces.
- `/end` also counts drivers working in unclaimed tabs, and ending a journey closes only your own tabs.
- The engine token is the trust boundary: anyone holding it can drive any tab, so profiles separate drivers' sign-ins, not mutually untrusted callers.

## What's new in v40
- Send `x-profile: <name>` to get your own browser profile: its sign-ins are isolated from the shared profile and from the /browser panel's people (anyone sending the same name shares it), and they survive engine restarts, so you sign in once. The /browser panel gives each signed-in person their own profile.
- `POST /end` closes only your tabs while another driver is still working; the engine shuts down when you are the last one, or with `{"shutdown": true}`.

## What's new in v39
- The engine records the page itself (Chrome's own screenshots) instead of the whole screen. That cuts most of its idle CPU use. Clips no longer show Chrome's tab strip and address bar; a label at the top of the page names the tab and URL. Set `OSBORN_CAPTURE=display` to record the whole window again.
- `/say` replies without waiting for its clip: the reply has `clipPending: true`, and `clipUrl` (and the evidence link) wait until the clip is ready. Pass `waitClip: true` to get the clip in the reply as before. Clips are 640px wide.
- The engine stops itself after 3 idle hours instead of 15 minutes. A freshly started machine gets throttled almost at once, and staying up lets it build up CPU credit.

## What's new in v38
- A failed clip now says why (too few frames, ffmpeg error, or the encode ran past 20s), and `/say` `timings` include `encode`, the part of `clip` spent encoding.
- Clips encode at the capture rate (5fps in full-window mode) instead of 10fps, so the encoder has half as many frames to write.

## What's new in v37
- When nobody is watching and no command has arrived for 2 minutes, the engine stops recording the screen and restarts it on the next command. On Fly's shared CPUs a machine that never idles gets throttled, which slowed speech playback and clip encoding. Set `OSBORN_CAPTURE_IDLE_MS` to change the wait (0 turns it off).

## What's new in v36
- `/say` reports which voice spoke (`voice`) and splits speaking into `synth` and `play` in `timings`. The engine warms its speech connection at boot, so the first turn isn't slow, and falls back to another voice after 10s.
- Clips are encoded with the fastest preset, so a turn's clip is back in seconds.

## What's new in v35
- Speaking in `/say` is capped at 30s per attempt, and it retries only when the turn has time left. Each turn's `timings` are also saved on its task (`/tasks`), so a turn whose response you gave up on can still be diagnosed.

## What's new in v34
- `/say` returns `timings` (speak, listen, clip, decode, hear, mix, total in ms), so a slow turn shows which step was slow.
- On a page with no audio or video element, `/say` skips hearing and answers "nothing heard" straight away. The turn deadline now runs from the request, not from speaking.

## What's new in v33
- **A tab's owner is always your `x-driver-id`.** An `owner` field in a `/tab` body is ignored, so nobody can act as another driver. Set `x-driver-id` on every call.
- `/input` only works on a tab you opened or took over (`not_your_tab` otherwise).
- `/say` answers within about 90 seconds of speaking, even on a page that won't answer: hearing and the clip mix share one deadline, and a turn that runs out reports "nothing heard" with the reason.

## What's new in v32
- When the page plays nothing back, `/say` and `/hear` now report "nothing heard" instead of a speech-to-text error ("Invalid audio file").

## What's new in v31
- Opening the in-app Browser (`/browser`) inside the engine no longer shows an endless mirror of itself; its live view is hidden there.

## What's new in v30
- A person can take control of a tab from the in-app Browser and hand it back. While they hold it, your actions on that tab answer `paused_by_supervisor`: wait and retry. `POST /input` (click / type / key / scroll) is how a person drives by hand.

## What's new in v29
- `/status.build` says which engine build is answering (commit, skill version, start time).

## What's new in v28
- `/say` stays faster late in a long run (the recording is decoded once per turn).

## What's new in v27
- **No more engine zombies or stuck locks.** A crash exits (on Fly the
  machine restarts on the next request) instead of answering as a half-dead engine; a
  brain call that hangs past `OSBORN_BRAIN_TIMEOUT_MS` (120s) fails the action
  and frees the lock; `/tab {"op":"list"}` no longer waits behind an action.
- **A journey recovered after a restart keeps its steps** (so `/journey end`
  can still save them) and **no longer keeps its mission lock**, so a crash or
  redeploy never locks other drivers out.
- Temporary audio files from `/clip?audio=1` and `/audio` are deleted, so a
  long run no longer fills the disk.
- **Hearing no longer slows down over a run, and Soniox stops rejecting it.**
  `/say` and `/hear` now send speech-to-text only the current turn (a short
  16 kHz wav), not the whole raw recording, so a reply takes seconds even
  late in a long run.

## What's new in v26
- **Speech-to-text health is visible.** `/status.stt` lists each configured
  transcription provider with `ok` and the HTTP status of a live key check (at
  boot and on `POST /brain`). When transcription fails, the `/say` warning now
  names every provider that failed and why, not just the last one.
- **Drivers no longer wait on each other.** Every tab is recorded on its own,
  so the action lock is held only for the input itself (focus + the action, or
  focus + speaking). Listening, clip cutting, transcription and audio mixing
  run after it is released. Measured with two drivers: while one listened for
  15s, the other's /eval returned in ~0.03s and its /act in ~1s; each clip
  showed only its own tab. Recording starts on a tab's first action and keeps
  its last 60s. On a display-mode engine the live view still shows the whole
  window, but task clips show the page content of the acting tab only (no tab
  strip or URL bar): the right tab matters more than the browser chrome.
- **Spoken-turn clips are reviewable by a person.** Players autoplay video
  muted, so the clip shows its sound: a waveform strip along the bottom, a
  "TESTER SAID" caption while the question plays, and the transcript of the
  reply (or "no speech transcribed") afterwards. Audio is stereo and
  loudness-normalised. Unmute to hear both sides.

## What's new in v25
- **Clips play in true time.** Each frame is held for as long as it was really
  on screen, so one second of clip is one second of wall clock (a 30s window
  used to come out as ~23s). `/act` clips start at the action; `/say` clips run
  from just before speaking to the end of the listen window (`listenMs`,
  default 6000) and are cut before transcription, so the spoken moment is
  always in the clip.
- **Spoken-turn clips have sound — both sides.** The `/say` clip carries what
  the tester said (placed at the instant it went into the mic) and what the
  page played back. `clipAudio: {said, heard}` says which tracks made it in.
- **Ears arm themselves on any tab.** Page-audio capture used to exist only on
  the boot tab, so a voice session in another tab was deaf. `/say` and `/hear`
  now arm the ears on the caller's tab and report `ears: {armed, armedNow,
  audioElements, playing}`; `/say` adds `heardAnything` and a `warning` that
  says WHY nothing was heard (no audio element, nothing playing, ears only
  just armed, or a late reply). `/hear` no longer throws on an unarmed tab.
- **`effect.changed` is no longer fooled by animated pages.** The page is
  sampled twice before each action; if its text changes by itself
  (`effect.textVolatile`), text is not counted as evidence. A scroll
  instruction is judged on scroll position alone, and when the brain's scroll
  moves nothing the engine retries it as a mouse-wheel gesture
  (`effect.fallback: "mouse-wheel"`).
## What's new in v24
- **`ok:true` is no longer the whole story.** Every `/act` returns `effect`
  (`changed`, `noop`, URL/scroll before and after, title), `result.did` (what
  the brain chose to do) and a `warning` when nothing observable changed or
  nothing matched. A recipe with no visible effect is dropped from the action
  cache, not replayed.
- **Long actions are pollable.** `{"async":true}` on `/act` or `/say` answers
  202 with `job` + `resultUrl`; `GET /result?id=` returns pending or the exact
  synchronous response. Never blind-retry a timed-out action.
- **Control API on 443.** `https://<app>.fly.dev/control/<action>` reaches the
  whole API with the same `x-engine-token`, for agents that cannot reach
  `:8781`. Through it, `clipUrl`/`artifactUrl`/`resultUrl` are absolute.
- **Supervisor takeover.** `/tab {"op":"takeover"|"handback","i":N}`; the
  borrowed driver gets `409 paused_by_supervisor` with `retryAfterSec` and gets
  its tab back. `/tab release` is owner-only.
- **Brain provider fallback.** Gemini → Anthropic → z.ai, picked by a live
  probe at boot and re-picked when a provider refuses mid-session; `/status`
  shows `brainModel`/`brainError`. The engine no longer dies on a model error
  and boots without a brain (`/eval`, `/tab`, `/shot` keep working).
- **Clips cover the action's own time window**, not the last 20s of screen.
- **Public evidence links.** `/clip` and `/artifact` need the engine token, so
  a link to them is a 401 for anyone reading an issue. Every `/act` and `/say`
  now returns `evidence` with token-free signed links (`screenshot`, `clip`,
  `log`) and a paste-ready `markdown` block — use THOSE in issues, PRs and
  reports. They last while the run is among the newest 30 on the volume;
  `GET /evidence?run=<run>&n=<N>` re-issues them later (omit `n` for the
  whole run).
- **Tester mode** — see references/tester-mode.md.

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
