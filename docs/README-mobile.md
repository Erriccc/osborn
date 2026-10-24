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
- **Artifact:** Actions run page → `VoiceNative-unsigned-<sha>` (.app, 14-day
  retention). Run unsigned on any Mac's simulator:
  `xcrun simctl install booted VoiceNative-unsigned.app && xcrun simctl launch booted <bundle-id>`

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
- **Track 1 (zero-build, live when keys land):** Pushover priority-2 push →
  yes/no tap on the wrist → HMAC-signed callback route → agent permission
  auto-answer. See `agent/src/pushover.ts` + `frontend/src/app/api/watch/ack/`.
  - Settled semantics: **tap = approve · ignore-to-expiry (10 min) = deny** —
    the expiry receipts-poll also cancels further watch buzzing.
  - Setup (one-time, $5): pushover.net → create application (token) + note
    your user key; install Pushover on the iPhone (Watch mirroring is
    automatic). Then set on EACH agent machine:
    `PUSHOVER_TOKEN`, `PUSHOVER_USER_KEY`, `WATCH_ACK_SECRET` (random 32+ hex),
    `OSBORN_PUBLIC_URL` (that machine's public https base) — and the SAME
    `WATCH_ACK_SECRET` in the Railway frontend env (it verifies the callback).
    All dormant unless set: no keys, no behavior change.
  - Flow: agent permission blocks → pushover.ts POSTs messages.json
    (priority=2, retry=30s, expire=600s, callback=…/api/watch/ack/<signed
    token>) → tap on Watch → Pushover hits the frontend route → route verifies
    HMAC + expiry, POSTs the ack to the agent's `/watch/ack` → pending
    permission resolves allow. Web-UI answers always win; late wrist acks are
    no-ops; an ack whose callback got lost is recovered by the expiry poll.
- **Track 2 (scaffold):** `native/watchos/` SwiftUI app + `agent/src/watch-gateway.ts`
  (Node ws gateway ↔ @livekit/rtc-node). Needs the Apple account + TestFlight
  to reach a real watch.

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
