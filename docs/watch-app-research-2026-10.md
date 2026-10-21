# Watch scenario — research briefs (Oct 2026)

> Two deep-research passes 2026-10-21, consolidated. Companion memories: watch-scenario.md.
> Settled earlier in the cloud session (not repeated): watch browsers dead (no web engine),
> native apps get mic+AirPods, cellular phone-call route works, Kuma Voice named as seed.

## A. Zero-build wrist yes/no (shippable this week)

- Apple Watch shows mirrored iPhone notifications only when the iPhone is locked/asleep and networked — no phone-independent third-party mirroring (Apple 108369). Only native watch apps with own push registration escape this.
- **ntfy** (self-hostable): iOS actions (`view`, `http`, ≤3 buttons); `http` action fires FROM the iPhone app when tapped (works from wrist via mirroring); `clear:true` dismiss bug on iOS (issue #1728).
- **Pushover — WINNER for blocking yes/no**: dedicated watchOS app; **emergency priority (priority=2) + `callback` URL → Pushover's servers POST our endpoint on acknowledge** (server-to-server, retries ≥30s until acked, max 3h/50; receipts API). Single acknowledge semantic — model yes=ack, no=expiry/fallback, or add supplementary URL actions.
- **Pushcut**: richest actions (multi-button, per-button webhooks via REST API; HomeKit/web/Automation Server from the wrist) — subscription; older reliability caveats on watchOS; execution locus undocumented.
- **Web push from PWA: DEAD for actions on iOS** — custom actions ignored, users only get "View".
- **Shortcuts from watch** (complication/Siri → Get Contents of URL → our HTTPS): viable user-initiated channel, pull-only.
- **Recommended stack**: agent blocked → Pushover `priority=2&retry=30&expire=600&callback=https://<osborn>/ack/<qid>`; ack=yes, expiry=no/escalate. Pushcut channel later for true multi-button. Shortcut complication as "ping osborn".

## B. Native live-voice (watch replaces iPad)

- **LiveKit Swift SDK: NO watchOS** (issue #288 closed not-planned); no practical WebRTC build for watchOS exists → **the watch can never join the room directly; a gateway is mandatory** (watch → WS → gateway on the Fly machine → LiveKit room via Node server SDK).
- **TN3135 runtime policy** (Apple technote, confirmed): low-level networking on watchOS only (1) while actively streaming audio with an active audio session (watchOS 6+), (2) during a CallKit call (watchOS 9+), (3) DeviceDiscoveryUI. `URLSessionWebSocketTask` counts as low-level; reliable path = Network.framework `NWConnection` in-process; plain HTTPS URLSession always allowed. watchOS 9 closed the old loophole. Audio session drops ⇒ socket dies ⇒ design for reconnect.
- **Kuma Voice VERIFIED** (github.com/itsperini/kuma-voice, MIT, ~Aug 2026): SwiftUI watch app streaming mic live (no iPhone) to self-hosted FastAPI; backend holds provider creds. Young (~10 commits) but exactly our shape → **fork blueprint**.
- **watchGPT** (github.com/TheMarco/watchGPT): watch 24kHz PCM → WatchConnectivity → iPhone bridge holds the OpenAI socket (author: watch couldn't hold the socket reliably — cautionary).
- **Home Assistant watch Assist**: watch→phone relay via WatchConnectivity (PR #5968), not watch→server direct.
- **Hermes Conduit + bielcarpi/hermes-live-voice**: closest shipped precedent — real-time voice calls from watch to self-hosted agent, agent-initiated calls, CarPlay/Siri/Action Button; v2.0 Oct 2026; standalone-cellular unverified.
- **nanochat downgraded**: dictation text turns, not live audio. Ask Watch AI now markets "full-duplex OpenAI Live" — unverified.
- **Scope**: UI+WS plumbing = days; hard parts = (a) background-audio session lifecycle (wrist-down, interruptions, AirPods handoff — watchGPT used HKWorkoutSession), (b) gateway jitter/format bridge (watch 24kHz PCM ↔ LiveKit 48kHz Opus, echo/barge-in). ~2–4 weeks part-time with Kuma scaffold.

## C. Self-approval dev logistics (no App Review, no business verification)

- **Individual Apple Developer Program $99/yr**: photo-ID verification only (no DUNS — that's organizations). Covers everything: APNs (.p8 self-minted), TestFlight, all entitlements self-service.
- **Free Personal Team**: works for watchOS via paired iPhone but 7-day profiles, 3 apps, NO push/TestFlight — dev-poking only.
- **Install with zero review**: (a) direct Xcode install — 1-year certs/profiles, rebuild ≈yearly, watch installs via paired iPhone (incl. watch-only apps), Developer Mode needed on both; (b) ad-hoc — 100 devices/yr per family, watch = register both UDIDs, awkward for watch-only; (c) **TestFlight INTERNAL = the sweet spot** — up to 100 internal testers, builds live minutes after processing with **no Beta App Review** (review triggers only on first build to an EXTERNAL group — Apple-implicit but multi-source-confirmed 2026), builds expire 90 days, watchOS supported.
- **Capabilities all checkbox-level** (managed-capability approval is for CarPlay/MDM-class only): mic = usage string; watch background audio = `UIBackgroundModes: audio` in the WATCH app's Info.plist (can't START recording from background — start in foreground); HealthKit + `workout-processing` keep-alive; push = .p8; CallKit/VoIP self-service.
- **THE CONSTRAINT — this Mac can't build it**: user's Mac = **MacBookPro14,1 (13" 2017, Intel)** → Ventura-forever (Sequoia needs 2018+). Since 2026-04-28 all App Store Connect uploads (incl. TestFlight) require Xcode 26 SDKs; Xcode 26.0–26.3 need macOS Sequoia 15.6+, 26.4.1+ needs Tahoe. Ventura tops out at Xcode 15.2 — can't talk to watchOS 26 devices or upload.
- **Ventura-safe path: GitHub Actions `macos-26` hosted runners** (GA Feb 2026, Xcode 26.x + watchOS 26 simulators, Apple Silicon): build + sign (fastlane match, secrets in repo) + `pilot` upload → TestFlight internal on our own devices. Scheduled CI job re-uploads ~quarterly (90-day expiry). Xcode Cloud ruled out (initial workflow creation needs local Xcode once).

### Bottom line (two tracks)
1. **This week**: Pushover emergency-ack bridge from the agent's question/permission events → yes/no on the wrist. No Apple account needed at all.
2. **Native app**: enroll Individual ($99), fork Kuma Voice, gateway on the Fly machine into the LiveKit room, build/sign/upload entirely on GitHub `macos-26` runners, install via TestFlight internal. Local Mac just edits code.

**Flagged unverifiable**: TN3135 exact text (paraphrase-confirmed + doc JSON); Pushcut execution locus/reliability; Hermes standalone-cellular; Ask Watch AI full-duplex claim; "internal TestFlight = no review" is Apple-implicit; HealthKit on free tier; watch-hardware ↔ watchOS 26 pairing (needs the physical watch).
