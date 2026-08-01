# Hard-won gotchas (do not relearn these)

Failure modes paid for in real debugging hours. Read before debugging the
harness itself or trusting any surprising result.

## Trust & verification
- **A green assertion is a CLAIM, not proof.** Assertions have passed while the
  page showed "Local (offline)". Frames are proof.
- **Cached actions can false-ok.** A UI redesign once made cached clicks
  "succeed" on nothing (selector matched a different/gone element) — 3 blind
  acts before detection. The cache now fingerprints targets, but treat any
  surprising no-effect act as a possible stale hit; `/eval` DOM enumeration
  (`querySelectorAll('button')` → aria-labels) is the precision fallback.
- **Check `activeTab` before every act.** Tab restore once left the dashboard
  tab active; two acts "succeeded" against the wrong page.
- **Never `.catch(() => '')` around a sense.** A silent catch in /hear masked
  an audio-timeline bug for a day ("agent said nothing" — audio provably
  contained the answer). Errors from hearing/seeing must surface.

## Audio
- **Audio file timeline ≠ wall clock.** The ears recording starts at the FIRST
  tapped source (room join), not capture start — a 38.3s skew once made
  `hearSince` filter out every real word. `__osbornAudioAnchor` +
  `anchorOffsetMs` convert between timelines; never compare transcript
  timestamps to wall-clock windows without the anchor.
- `--use-file-for-fake-audio-capture` hijacks tab capture AND loops — the
  reactive mic + element-tap ears replace it entirely.
- LiveKit mutes silent synthetic mics (`LocalAudioSilenceDetected`) — comfort
  noise (~-68dBFS) in the mic graph prevents it.
- The in-room "Previous Sessions" prompt MUTES the mic until answered.
- Reply words must NOT appear in prompt audio (use riddles: "yellow curved
  fruit" → assert "banana").

## Capture & display
- **CDP screencast is per-page and paint-driven**: it does not follow tab
  focus (retarget on switch) and starves on static pages (heartbeat frames
  fix). Full-window mode (Xvfb + x11grab) avoids both and shows the real tab
  strip — but **Xvfb without a window manager silently breaks window
  raise/focus** (openbox required; a mobile-tab clip once showed the wrong
  window entirely).
- Page screenshots (`/shot`, artifacts) are viewport-only BY DESIGN — the tab
  strip exists only in clips/stream.
- Clips encode at capture fps — display mode is real-time; CDP mode can
  timelapse (static) or slow-mo (animated).

## Engine & lifecycle
- **Engine teardown MUST be time-bounded** — Stagehand/CDP close can hang
  forever (a run's index once died to exactly that). `/end` races every step
  + 45s watchdog; the manifest writes incrementally so nothing depends on a
  clean exit.
- **A double page reload detaches Stagehand** ("uninitialized Stagehand
  object") — `POST /brain` re-inits in place.
- The control API starts BEFORE the room join (a wedged "Connecting…" once
  left the engine totally headless for 20+ minutes) — `roomReady` in /status
  tells you which phase you're in.
- Machines-API-created Fly apps get NO public IPs — `fly ips allocate-v4
  --shared` + `allocate-v6` or DNS never resolves.
- Deploys rebuild machine config from fly.toml — machine-level env overrides
  are WIPED every deploy; durable config belongs in fly.toml.

## Platform interplay (voice-native specific)
- Agent must be in its LiveKit room BEFORE the browser joins; pre-connect via
  `POST /connect-room` then poll `/health` for `livekit.status==='connected'`.
- `/health` can lie "connected" after zombie-watchdog leaves on old agents.
- Don't assert on DOM text counts for repeated replies — the chat UI merges
  bubbles; audio transcript is the source of truth.
- Stagehand attach needs the ws URL from `http://127.0.0.1:<port>/json/version`,
  not the bare port; set `GOOGLE_GENERATIVE_AI_API_KEY` for its model client.
- Room hygiene: every run leaves the room via the UI outro + `POST /leave-room`.
