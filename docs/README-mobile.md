# Mobile runbook — iOS shell, watch surfaces, CI

Companion to `docs/mobile-parity-map.md` (the inventory). This is the *how to
build/ship/flip* doc. Last updated 2026-10-24.

## Layout

```
frontend/native/          Capacitor iOS shell (own package.json — Railway
                          never sees iOS toolchain deps)
  capacitor.config.ts     REMOTE-URL mode: WKWebView loads www.voice-native.com
  www/offline.html        shown only when the remote URL is unreachable
  ios/App/                COMMITTED Xcode project (SPM — no CocoaPods anywhere)
    App/AppDelegate.swift AVAudioSession .playAndRecord/.voiceChat/
                          defaultToSpeaker at launch (WKWebView WebRTC-AEC fix)
    App/Info.plist        UIBackgroundModes audio · NSMicrophoneUsageDescription ·
                          ITSAppUsesNonExemptEncryption · portrait-locked
    CapApp-SPM/           SPM package: Capacitor core (swift-pm repo) + 8 plugins
                          as local Swift packages from node_modules
.github/workflows/
  ios-build.yml           macos-15, unsigned Release build → .app artifact
  frontend-lint.yml       ubuntu (free), tsc + lint gate on frontend changes
codemagic.yaml            overflow builder (500 free M2 min/mo, arm64 ≈2× faster)
```

## Why SPM, not CocoaPods
`cap add ios --packagemanager SPM` generates the `CapApp-SPM` marker package;
every later `cap sync` auto-detects it — CI needs only Xcode, no Ruby. Caveat:
the Capacitor 7 CLI has a case bug (`--packagemanager SPM` lowercases the flag
then compares `=== 'SPM'`, so it still demands CocoaPods on macOS). This repo's
ios/ was generated ONCE with a one-line local patch to
`@capacitor/cli/dist/index.js` (`if (packageManager?.toLowerCase() === 'spm')`).
You never re-run `cap add` unless deleting the platform — if you must, re-apply
that patch first (or `brew install cocoapods` just for the generation step).

## Trigger a build
- **GitHub Actions (primary):** Actions → *ios-build* → Run workflow. Auto-runs
  on pushes to `main` touching `frontend/native/**`. Private-repo free tier ≈
  200 real macOS min/mo (~5–10 builds; the run itself is ~8–15 min).
- **Codemagic (overflow):** codemagic.io → connect repo → start *ios-unsigned*.
  500 free M2 min/mo.
- **Artifacts (ios-build):** `VoiceNative-unsigned-<sha>` contains BOTH
  `VoiceNative-unsigned.app` (device slices — for the signed flip later) and
  `VoiceNative-sim.app` (simulator slices — **this is the one you run
  locally**; the device build won't install into a simulator).

## Where to test what (the ladder)
1. **PWA — today, $0, no build:** iPhone Safari → `www.voice-native.com` →
   Share → Add to Home Screen. This IS the mobile version; checklist below (§PWA).
   On the Mac's Xcode 15.2: iOS Simulator → Safari → same URL (mic works in
   sim on Intel builds).
2. **iOS shell in simulator — needs one CI run:** download `VoiceNative-sim.app`
   from the Actions artifact → `xcrun simctl install booted VoiceNative-sim.app
   && xcrun simctl launch booted com.voicenative.app`. Xcode 15.2's iOS 17.2
   runtime is fine (deployment target 14.0). If the runtime ever rejects a
   newer-SDK binary, fall back to the PWA-in-Simulator route.
3. **watch app in simulator:** `watchos-build` artifact `OsbornWatch-unsigned-<sha>`
   → install into a booted watch simulator the same way (it's already a
   simulator build).
4. **Real devices — after the $99 Apple account:** TestFlight (90-day expiry
   per build). Watch needs the account too.

## Pre-$99: the actual native-app-on-hardware options
You do NOT need the $99 for most of this. Tiers, cheapest first:

| Tier | On hardware? | Cost | What | Catch |
|---|---|---|---|---|
| PWA | iPhone | $0 | Add to Home Screen — live NOW | no push/haptics; is ~95% of the app |
| Pushover | **Watch** | $0 trial → $5 once | real wrist notifications + tap-to-approve (Track 1) | needs branch→publish→machine rebuild + keys; answers only, no voice |
| Free-Apple-ID sideload | iPhone | $0 | the ACTUAL Capacitor app on your phone via Sideloadly/AltStore | 7-day expiry, 3-app limit, needs 1 CI artifact + Mac |
| Simulator | Mac only | $0 | both apps in Xcode 15.2 sims | not hardware |
| Appetize.io | browser | ~free tier | CI sim artifact runs in a hosted simulator you can share as a link | minutes-limited; no mic |
| TestFlight | iPhone + Watch | $99/yr | real distribution, push, the watch voice app | the fee |

**Sideload steps (Tier 3, after one ios-build run):**
1. Actions run → download artifact → unzip → `VoiceNative-unsigned.app`
   (device build).
2. Zip it: `zip -r VoiceNative.app.zip VoiceNative-unsigned.app` — Sideloadly
   accepts .app-in-zip or .ipa; rename to match its prompt.
3. Install [Sideloadly](https://sideloadly.io) on the Mac, drag the zip in,
   sign with your everyday Apple ID (free personal team — NOT the $99
   program), connect iPhone by cable, Start.
4. On the phone: Settings → General → VPN & Device Management → trust your
   Apple ID. App appears on the home screen.
5. Refresh every 7 days (re-run Sideloadly; AltStore does it over WiFi
   automatically if you prefer).
   Limits: 3 sideloaded apps at a time, no push notifications (APNs needs the
   paid account), expires in 7 days.

**Watch, pre-$99, bluntly:** a native watch app on the WATCH itself is not
sideloadable with a free Apple ID — that road goes through the $99
(TestFlight). Pre-$99 you get: Pushover on the wrist (real hardware, real
taps) and the full watch app in the Mac's watch simulator.

## Signed flip (when the Apple Developer account is bought)
1. App Store Connect → Users & Access → Integrations → **Keys** → generate
   (App Manager). Download `.8`, note Key ID + Issuer ID.
2. GitHub repo secrets: `APP_STORE_CONNECT_KEY_CONTENTS`, `_KEY_ID`,
   `_ISSUER_ID`.
3. In `ios-build.yml` replace the unsigned xcodebuild flags with App Store
   Connect API signing (`xcode-project use-profiles` style flow or
   `-authenticationKeyPath`), bump MARKETING_VERSION in the pbxproj, add an
   upload step (`xcrun altool --upload-app` or Fastlane pilot).
4. Replace the placeholder app icon: extend
   `frontend/scripts/generate-icons.mjs` to emit the AppIcon.appiconset sizes
   from `src/app/icon.svg` (same sharp pipeline; the template default ships
   today).
5. TestFlight builds expire after 90 days — re-uplift periodically.

## PWA (live today, no Apple dependency)
iPhone Safari → **Add to Home Screen**. Verifies: dark splash + mic glyph icon,
notch safe-areas, no rubber-band, composer doesn't auto-zoom (16px floor),
lock/unlock mid-session → fast rejoin, "Tap to enable sound" bar when audio is
blocked, mic-denied recovery dialog. `start_url` is `/dashboard` (NOT `/chat` —
a cold launch must not auto-burn LiveKit minutes).

## Watch
- **Apps you download on the phone (that's the whole list):**
  **Pushover** (App Store — 30-day free trial, then $4.99 one-time; covers
  iPhone + iPad + Watch mirroring forever) and/or **ntfy** (free, open
  source). Nothing to download on the watch itself — notifications mirror
  from the phone, and the Osborn watch app arrives via TestFlight once the
  Apple account exists.
- **Track 1 (zero-build, live when keys land):** permission asks push to the
  phone (mirrored to the wrist). TWO providers, either or both:
  - **Pushover** — priority-2 push, retry 30s, expire 600s; settled semantics:
    **tap = approve · ignore-to-expiry (10 min) = deny** (receipts poll also
    cancels buzzing; late-ack recovery approves). Env: `PUSHOVER_TOKEN`,
    `PUSHOVER_USER_KEY`.
  - **ntfy** (free; self-host later on our Fly infra if we want zero third
    parties) — notification with REAL **Approve / Deny buttons** (http
    actions hitting the same signed ack route with `?ans=1|0`); no ack/retry
    machinery, deny is explicit. Env: `NTFY_URL` (e.g. https://ntfy.sh),
    `NTFY_TOPIC`, optional `NTFY_TOKEN`.
  - Both need `WATCH_ACK_SECRET` (random 32+ hex — same value on each agent
    machine AND in Railway) and `OSBORN_PUBLIC_URL` (each machine's public
    https base). All dormant unless set.
  - **Phone-free caveat:** mirrored notifications need the phone nearby — on
    a cellular watch away from the phone, Track 1 does NOT arrive. Phone-free
    wrist is Track 2's job.
- **Track 2 (scaffold, built by CI)** — `frontend/native/watchos/` SwiftUI
  app (watchOS 9+) + `agent/src/watch-gateway.ts` (Node `ws` server ↔
  `@livekit/rtc-node`, both already agent deps).
  - **Standalone by design:** Info.plist sets `WKRunsIndependentlyOfCompanionApp`
    and the app connects STRAIGHT to the machine's gateway over its own
    connection — including the watch's LTE/cellular plan, no phone involved.
    The watch is its own audio participant, so the phone stays free for other
    audio tasks while the wrist stays in the session.
- **Track 2 (scaffold, built by CI):** `frontend/native/watchos/` SwiftUI app
  (watchOS 9+) + `agent/src/watch-gateway.ts` (Node `ws` server ↔
  `@livekit/rtc-node`, both already agent deps).
  - Why a gateway: watchOS has no WKWebView and LiveKit's Swift SDK won't
    target watchOS (client-sdk-swift #288) — the watch speaks a small WS
    protocol (24kHz Int16LE PCM binary + JSON text) to the gateway on the
    user's own machine, which bridges into their LiveKit room (resample
    24k↔48k, data-channel JSON → watch state/question events; answers ride
    back as permission_response, same shape as the web UI).
  - App screens (3-6-9): Connect = 1 action · Live = 3 (Talk / Mute / End) ·
    question sheet = 2 (Yes / No). Protocol mirrored in GatewayLink.swift and
    watch-gateway.ts — keep them in sync.
  - Enable: agent env `WATCH_GATEWAY=1` (port `WATCH_GATEWAY_PORT`, default
    8742; open it on the machine's firewall/fly config before testing).
  - Build: Actions → *watchos-build* (macos-26). The xcodeproj is NOT
    committed — CI runs `brew install xcodegen && xcodegen generate` from
    `frontend/native/watchos/project.yml` (xcodegen needs full Xcode, which
    the CLT-only founder Mac lacks). Artifact = unsigned watchOS-Simulator
    .app — runs in any Mac's watch simulator, no dev account needed.
  - Real watch: needs the $99 account + TestFlight (90-day expiry re-uplift).

## Gotchas register
- **OAuth in the shell (G-OAUTH):** `signInWithOAuth` top-level redirect hits
  `disallowed_user_agent` inside WKWebView. Until the deep-link flow lands,
  auth flows must run via `@capacitor/browser` (SFSafariViewController) or
  outside the app.
- **App Store 4.2 risk:** remote-URL shells can be rejected as
  "minimum functionality". Mitigations shipped: background audio, AVAudioSession
  voice mode, haptics bridge, APNs path (inactive until .p8).
- **LiveKit minutes:** the web app auto-reconnects on focus — on mobile that's
  why `/dashboard` (not `/chat`) is the cold-launch surface.
