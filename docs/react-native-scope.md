# React Native (Expo) build — scope & phasing

Companion to `docs/mobile-parity-map.md` (the web route inventory) and
`docs/README-mobile.md` (the Capacitor/CI/watch runbook). This is the contract
for the **true-native** iOS app, decided 2026-10-26 after the Capacitor
remote-URL shell + a styled-web demo (`/native-demo`) were judged "web, not
native." Stack: **Expo (React Native, New Architecture) + TypeScript** —
chosen over Swift because the team writes React/Next, it's cross-platform
(iOS+Android), and logic/types can be shared with the web app.

**Signing reality (no $99 needed to build/feel it):** every native iOS build
sideloads to the real iPhone free via CI → Sideloadly (same pipeline as the
Capacitor app). $99 only gates: real Apple Watch install, CarPlay entitlement,
push notifications, TestFlight, and App Store production.

---

## Route → native screen map (reuse of parity-map §1)

| Web route | RN screen | Notes |
|---|---|---|
| `/login` | **Auth** | Supabase RN client + **native Google OAuth** (expo-auth-session / ASWebAuthenticationSession) — fixes the WKWebView `disallowed_user_agent` block for free |
| `/dashboard` | **Dashboard** | session list grouped by project, New Session, resume; real native FlatList + navigation |
| `/chat` (VoiceRoom, 5,861 LOC) | **Voice** (the big rock) | `@livekit/react-native` + `@livekit/react-native-webrtc`: mic, audio out, transcript, ~25 data-channel msg types, permission prompts, mobile 3-6-9 controls, meeting join, files, idle/reconnect |
| `/library` | **Library** | content studio list + fullscreen editor |
| `/settings` | **Settings** | iOS-style grouped settings (drill-in), secrets, machine controls |
| `/p/[handle]`, `/p/[handle]/[slug]` | — | public share links **stay web** — open in browser |
| all marketing (`/`, `/about`, `/blog`, `/compare`, `/founders`, `/drivers`, `/industries`, `/use-cases`, legal) | — | **not in the native app** — app cold-launches into Auth/Dashboard; marketing stays web |
| `/meeting-canvas` | — | bot-only Recall surface — no native work |

## Cross-cutting native layer (reuse of parity-map §3)
- **Auth/session**: Supabase RN (AsyncStorage/SecureStore session), deep-link OAuth callback (`vn://auth/callback`)
- **Transport**: LiveKit RN SDK (WebRTC audio); reuse the web's data-channel protocol (~25×2 message types) verbatim over the room data channel
- **Audio**: background audio mode (voice survives lock/app-switch), AVAudioSession `.voiceChat` (RN config plugin), CallKit later (optional)
- **State/data**: reuse web TypeScript types + API client where possible; the 18 API endpoints are called the same way
- **Native extras**: haptics (expo-haptics), share (expo-sharing), status bar, splash, secure storage
- **Deferred to $99**: push (expo-notifications/APNs), CarPlay, Watch, TestFlight/App Store

---

## Phasing (don't underscope — this is weeks, not days)

**Phase 0 — spike (prove the pipeline + feel real native) · ~days**
Expo app scaffold → one real native screen (Dashboard mock) → `.github/workflows/rn-ios-build.yml` (macos-26, `expo prebuild` + `xcodebuild` unsigned) → sideload to the iPhone. *Exit: founder holds a genuinely-native screen on their phone, $0.*

**Phase 1 — Auth · ~days**
Supabase RN + native Google OAuth (the thing the webview can't do) + deep-link callback + session persistence. *Exit: log in with Google, natively, on device.*

**Phase 2 — Dashboard · ~days**
Real session list (FlatList, project grouping, resume, New Session), React Navigation/Expo Router shell, native nav transitions. *Exit: browse + launch sessions natively.*

**Phase 3 — Voice (the big rock) · ~weeks**
LiveKit RN SDK integration; port VoiceRoom: connect/reconnect, mic + audio out, live transcript, the data-channel message handlers, permission-prompt UI, the 3-6-9 mobile control set (Mic + End primary; rest in a sheet), meeting join, files, idle overlay. Sub-phased: 3a connect+audio, 3b transcript+messages, 3c controls+permissions, 3d meeting/files. *Exit: full voice session, native.*

**Phase 4 — Library + Settings · ~days each**
Port both; iOS-grouped settings with drill-in; secrets/machine controls.

**Phase 5 — Native polish · ~days**
Background audio hardening, haptics across interactions, share sheet, splash/icon, offline states, wake handling.

**Phase 6 — post-$99 distribution & surfaces**
Push (APNs), TestFlight beta, App Store submission; **CarPlay** (entitlement request → now-playing + template UI for the meeting/audio use case); **Watch** (the existing SwiftUI OsbornWatch app ships via TestFlight; or a watch target on the RN app).

---

## Hardware-surface reality (pre- vs post-$99)

| Surface | Simulator (free) | Real hardware pre-$99 | Needs $99 |
|---|---|---|---|
| iPhone | ✅ | ✅ sideload (7-day re-sign) | permanent signing, push |
| Apple Watch | ✅ watch sim | ❌ (needs $99 + Xcode 26 on a Sequoia+ Mac) | real-watch install |
| CarPlay | ✅ CarPlay sim (but app icon only shows with the entitlement) | ⚠️ **now-playing audio only** (no entitlement needed) — custom CarPlay UI ❌ | CarPlay entitlement (Apple approval, case-by-case) |

**CarPlay nuance:** a custom CarPlay app UI (your screens on the car's home
screen) needs the CarPlay entitlement = paid account + Apple's category
approval (audio / communication / navigation / etc. — a meeting or audio
note-taking app is an eligible framing). BUT background-audio **now-playing**
controls (title + play/pause on the car's Now Playing screen) surface via
`MPNowPlayingInfoCenter` with **no entitlement** — the one pre-entitlement
foothold, available once the app is a real installed native app playing audio.
