# Mobile / iOS Parity Map — voice-native frontend

**Generated:** 2026-10-24 · **Repo:** `Erriccc/osborn` @ `feature/mobile-ios-watchos`
**Scope:** every frontend route, control, browser API, storage key, network call → its
iOS/mobile equivalent, current status, and gap. Companion to the mobile compatibility
plan (`~/.claude/plans/concurrent-leaping-beaver.md`). Source of truth for the mobile
IA restructure (**3-6-9 rule**, §0.2).

---

## 0. How to read this

### 0.1 Status legend
- ✅ works on iOS Safari today
- 🟡 degraded (works; missing recovery/native polish)
- 🔴 broken on iOS
- ⛔ no iOS-Safari equivalent possible (web API) — native shell or bust
- ➖ N/A (bot-only / desktop-only / parked)
- ⏳ planned (Phase 1/2/3 work item, per §5 gap register)

### 0.2 The 3-6-9 rule (mobile IA constraint)
Every **mobile** screen exposes at most:
- **3 primary actionable controls** — the screen's job
- **5–6** only when absolutely required
- **9 max** on *technical pages* (the More menu, settings sections, machine console)
Everything else lives in popups, nav, or a separate page. Each deep-map section below
carries an **IA (3-6-9)** row assigning every control a tier + overflow destination.

**Counting exemption (founder, 2026-10-24):** persistent navigation chrome — nav bars,
tab bars, menus/burger sheets, and footers — does **not** count against a screen's 3-6-9
tally. The rule measures the screen's *content* actionables (the screen's job); the nav
that gets you between screens is infrastructure. A burger sheet may therefore hold any
number of overflow entries regardless of the host screen's tier.

### 0.3 Completeness guarantee
- Routes enumerated from `frontend/src/app` — 20 user routes + 1 bot route + 1 redirect.
- API endpoints enumerated from `frontend/src/app/api` — 18 handlers.
- Storage keys from the canonical grep (§3.4).
- Every per-route section reconciles against
  `grep -cE '<button|onClick|onSubmit|<input|<a ' <file>` — each hit is a row or is
  explicitly grouped into a listed composite control.

---

## 1. Route inventory

| # | Route | File (LOC) | Auth | Surface |
|---|---|---|---|---|
| 1 | `/` | `app/page.tsx` + `components/landing/*` (15 sections) | public | marketing |
| 2 | `/v2` | `app/v2/page.tsx` (37) + `components/landing-v2/*` | public, noindex | marketing (parked preview) |
| 3 | `/login` | `app/login/page.tsx` | public (authed → /dashboard) | auth + legacy local setup |
| 4 | `/chat` | `app/chat/page.tsx` (164) + `ChatSessionProvider.tsx` (675) + `VoiceRoom.tsx` (5,861) | session-gated in practice | **voice app** |
| 5 | `/dashboard` | `app/dashboard/page.tsx` (1,826) | Supabase | app console |
| 6 | `/settings` | `app/settings/page.tsx` (1,259) | Supabase | app console |
| 7 | `/library` | `app/library/page.tsx` (689) | Supabase | content studio |
| 8 | `/p/[handle]` | `app/p/[handle]/page.tsx` | public | public author index |
| 9 | `/p/[handle]/[slug]` | `app/p/[handle]/[slug]/page.tsx` | public | public article |
| 10 | `/use-cases` | `app/use-cases/page.tsx` | public | marketing |
| 11 | `/use-cases/[slug]` | `app/use-cases/[slug]/page.tsx` | public, static | marketing |
| 12 | `/about` | `app/about/page.tsx` | public | marketing |
| 13 | `/blog` | `app/blog/page.tsx` | public | marketing + community |
| 14 | `/compare` | `app/compare/page.tsx` | public | marketing |
| 15 | `/founders` | `app/founders/page.tsx` | public | marketing |
| 16 | `/drivers` | `app/drivers/page.tsx` | public | marketing |
| 17 | `/industries` | `app/industries/page.tsx` | public | marketing |
| 18 | `/privacy` | `app/privacy/page.tsx` | public | legal |
| 19 | `/terms` | `app/terms/page.tsx` | public | legal |
| 20 | `/browser-screen-recorder` | `app/browser-screen-recorder/page.tsx` | public | skill install |
| 21 | `/test-skill` | — | public | redirect → #20 |
| 22 | `/auth/callback` | `app/auth/callback/route.ts` | OAuth flow | infra |
| 23 | `/meeting-canvas` | `app/meeting-canvas/page.tsx` (318) | none (bot) | **bot-only** |

*(all paths under `frontend/src/`)*

**Middleware:** `src/middleware.ts` refreshes Supabase session on all routes except
`/auth/`, `/api/`, `/p/`, sitemap/robots; bounces authed users off `/login`.

---

## 2. Per-route deep maps

### 2.1 `/chat` — the live voice app (90% of mobile parity)

Wrapper states (`chat/page.tsx`): (1) pre-token orb spinner + **Cancel**; (2) error +
**Retry** / **Back**; (3) optimistic waiting-mode VoiceRoom + connecting indicator until
`agent_ready` (+ **Cancel**); (4) idle dead-state "Session paused" + **Reconnect**
(rejoins same room) / **Back to dashboard**.

#### Controls (VoiceRoom.tsx)

| Control | Line (approx) | Browser API | Storage | Network | iOS status | IA (3-6-9) |
|---|---|---|---|---|---|---|
| Message composer (input, send) | 990–1100 | — | — | DC `user_text` | ✅ 🟡 auto-zoom ⏳P1.5 | **Primary 1** (composer group) |
| Attachment picker (file input + paste-image) | 958–963, composer | File/paste/clipboardData | — | `/api/upload` | 🟡 ⏳P1.5/P1.10 | in composer group |
| Mic mute toggle | 2592, mobile 5396–5445 | setMicrophoneEnabled | — | — | ✅ | **Primary 2** |
| Noise-cancel toggle | 3005 | DC `noise_cancel` | — | — | ✅ | More menu (tech) |
| End session / Leave | header | — | — | `/api/sandbox leave-room` + `fetch-log` | ✅ | **Primary 3** |
| Header: back, status pill, connection quality, More menu | 5150–5200 | — | — | — | ✅ | chrome (not actionables) |
| Permission modal (approve/deny) + auto-approve toggle | 3351–3376 | — | `osborn-auto-approve-permissions` | DC `permission_response` | ✅ | modal (event-driven) |
| Claude OAuth flow (URL display, paste-code input, submit) | 3646–3680 | clipboard r | — | DC | 🟡 ⏳P1.5 | modal (event-driven) |
| Sub-agent slots panel + spawn | 3773–3830 | — | — | DC `list_slots`/`spawn_background_session`/`stop_background_session` | 🟡 targets ⏳P1.10 | More → Sub-agents panel |
| Instances panel (per-instance stop) | 3803+ | — | — | DC | 🟡 | More → Instances |
| Skills panel (list/install/create/remove; catalog fetch) | 3624–3640, 4480–4496 | clipboard | — | DC + same-origin fetch | 🟡 | More → Skills |
| Agents panel (editor: name/desc/prompt/tools/when; edit/delete) | 3628 | — | — | DC `agents_status` | 🟡 | More → Agents |
| Session browser (list 10/pg, tools tab, switch-confirm modal) | 3394+, SessionBrowser.tsx | — | sessions cache | `${agent}/sessions` + DC `resume_session`/`continue_session`/`list_sessions` | 🟡 | More → Sessions |
| Resume prompt gate (Resume recent / Start fresh) | 4497–4530 | — | — | DC `session_selected` | ✅ | modal (event-driven) |
| Files panel + explorer modal (favorites, copy) | 2312–2424, FilesExplorerModal.tsx | clipboard | `osborn-favorite-files` | `/api/favorites`, `/api/session-files`, Storage URLs | 🟡 | More → Files |
| Diff viewer (show full diff toggle) | 3312+ | — | — | DC `permission_request.diff` | 🟡 | in permission modal |
| Meeting join (URL input, Join/Leave) | 2478+, 4312–4335 | — | — | DC `join_meeting`/`leave_meeting` | 🟡 | More → Meetings |
| Toasts / Dismiss | — | — | — | — | ✅ | passive |
| Jump-to-latest pill, speaking pill | — | — | — | — | ✅ | passive |
| More menu (viewport-cut fallback @5707) | 5707 | — | — | — | ✅ | **technical page (≤9)** |

#### IA (3-6-9) — voice screen (✅ shipped P1.e, commit series Oct 2026)
- **Primary 3:** mic · composer (incl. attach) · End session — the mobile composer strip
  now carries exactly Mic + End (Auto/Ask, Agents, Skills, Filter were removed from it)
- **Extended (≤6, only while relevant):** resume-prompt modal, permission modal, OAuth
  modal, reconnect overlay, autoplay-unlock bar, mic-denied dialog — all *event-driven*,
  never ambient
- **Overflow destination:** the mobile **burger sheet** (nav chrome — counting-exempt,
  §0.2): Auto-approve, Noise filter (with send-anyway count chip), Agents, Skills, Files
  Explorer, Copy all, Meeting join/leave, Session History = 8 rows. Agents/Skills rows
  bridge to the header-less popover panels (`requestOpen`/`hideTrigger`). The sheet's old
  Disconnect row was removed — End is a permanent primary, never cut.
- Desktop header (status/clock/popovers/More) is untouched by the restructure.

#### Subsystems owned here
See §3 (audio pipeline, connection lifecycle, data-channel protocol, idle timer).

---

### 2.2 `/dashboard` — console (1,826 lines)

| Control | API | Storage | Network | iOS | IA |
|---|---|---|---|---|---|
| LiveClock header | — | — | — | ✅ | chrome |
| Region badge ("Cloud · Chicago") | — | `osborn-machine-region` | `${agent}/health` | ✅ | chrome |
| Resume-a-session card | — | — | `${agent}/sessions` | ✅ | **Primary 1** |
| Start new chat | — | — | → `/chat` | ✅ | **Primary 2** |
| Project cards (expand/collapse; per-project menu: Download, Copy sync info, Delete) | — | — | `${agent}/sessions/export`, clipboard | 🟡 | **Primary 3** (Projects group; menu = popup) |
| Share modal (email input, Share; Shared-with-me Import) | — | — | Supabase share tables | 🟡 | project menu → popup |
| New project form | — | — | `${agent}/sessions/import` | ✅ | Projects → subpage/modal |
| Skills / Agents panels | — | — | `${agent}/skills`, `/agents` | 🟡 | **Machine subpage (tech)** |
| Secrets editor (draft, save, delete) | — | — | `${agent}/secrets` + Bearer sync token | 🟡 | Machine subpage |
| Sync token copy | clipboard | — | `/api/instance` | ✅ | Machine subpage |
| Sandbox: Start / Stop / Restart / Delete (two-click arm 4s) | — | — | `/api/sandbox` POST/DELETE | ✅ | Machine subpage |
| Version check + layer consistency | — | — | `/api/sandbox check-version` | ✅ | Machine subpage |
| Turbo toggle | — | — | Supabase `instances.turbo` | ✅ | Machine subpage |
| Profile menu + Sign out (clears all `osborn-*`) | — | wipes 10 keys | — | ✅ | chrome |
| Logs drawer (RAM thresholds) | — | — | inherited | 🟡 | Machine subpage |

**IA:** Primary 3 = Resume · New chat · Projects. **Machine subpage** (technical, ≤9):
sandbox lifecycle, version, secrets, skills, agents, logs, region, turbo, sync-token.

### 2.3 `/settings` (1,259 lines) — technical page (9 max per section)
Sections (sidebar on desktop / back-button nav on mobile): Voice-mode toggles ·
Connection (local/cloud radio, agent-URL input) · Sandbox (Start/Stop, Update,
Restart, Delete → `DeleteSandboxDialog`) · Sync (copy tokens) · Secrets manager ·
Skills/Agents. Network: `/api/sandbox`, `/api/instance`, `${agent}/skills|agents|secrets|health`.
**IA:** already sectioned; enforce ≤9 rows per section + 44pt targets (P1.10).

### 2.4 `/library` (689 lines)
Filter pills · search · card grid · featured · reading modal (fullscreen on mobile) ·
platform renditions (Blog/X/LinkedIn/Short/Newsletter) · Generate rendition
(`/api/content/refine`) · iteration refine · Publish/Unpublish (`/api/content/publish`)
· Copy public link · Refine-in-chat (→ seeded `/chat`).
**IA:** Primary 3 = Search · Filter · Open item. All studio actions inside the reading
modal (technical ≤9).

### 2.5 `/login`
Google OAuth · GitHub OAuth (top-level redirect, `signInWithOAuth`) · legacy local-mode
block (SetupWizard steps, provider/voiceArch/codingAgent toggles, agent-URL input,
SessionBrowser, Auto-connect, Sign out).
**IA:** Primary 3 = Google · GitHub · Local setup (collapsible). OAuth redirect is the
**Phase-2 landmine** in WKWebView (§5 G-OAUTH).

### 2.6 `/auth/callback` — OAuth code exchange, public-origin resolution, redirect to
`next`. Native equivalent: ASWebAuthenticationSession/deep-link handler (Phase 2).

### 2.7–2.17 Marketing/static (public, no device APIs)
`/` (15 sections, JSON-LD), `/v2` (**parked** — noindex founder preview; inherits global
viewport/manifest only; no dedicated work), `/p/[handle]`, `/p/[handle]/[slug]`
(markdown + **TalkAboutItButton** → seeded `/chat`, sign-in gated; **FastBrainChat**
signed-in streaming chat → `/api/content/chat`), `/blog`, `/use-cases(+/[slug])`,
`/about`, `/compare`, `/founders`, `/drivers`, `/industries` (ScenarioImage 16:9 slots),
`/privacy`, `/terms`, `/browser-screen-recorder` (single clipboard copy-prompt button).
**iOS:** all ✅ (links/copy only). Touch-target + copy-paste-button audit in P1.10 pass 2.
**Ruling:** responsive-marketing treatment only; no per-page mobile work beyond globals.

### 2.18 `/meeting-canvas` — **➖ bot-only.** Rendered by Recall.ai as the bot's camera
tile. APIs: EventSource `${agent}/canvas-stream`, Web Audio (webkitAudioContext) TTS
queue, `{kind:'stop'}` interrupt, speechSynthesis. No human mobile navigation reaches
it. Mapped, zero mobile work.

---

## 3. Cross-cutting subsystems

### 3.1 Audio pipeline
- Mic: **no direct getUserMedia** — `LiveKitRoom audio={{echoCancellation:true,
  noiseSuppression:true, autoGainControl:true}}` (ChatSessionProvider:659). iOS-AEC
  workaround re-enables mic on `listening` (VoiceRoom:3148) — 🟡 race, ⏳P1.9.
  `MediaDevicesError` log-only (:2785) — 🔴 no denied-recovery UI, ⏳P1.7.
- Speaker: `RoomAudioRenderer` only. No setSinkId/volume/picker (⛔ Safari). Autoplay:
  `AudioPlaybackStatusChanged` log-only — 🔴 no unlock UI, ⏳P1.6.
- Camera: hard-off (`ALLOW_VIDEO=false` :630) — by design.
- Native equivalents: AVAudioSession `.playAndRecord/.voiceChat` (Capacitor Swift
  plugin, P2.3); permission → NSMicrophoneUsageDescription + native prompt.

### 3.2 Connection lifecycle
connect(): click-ts marks → `POST /api/sandbox connect-room` → discovery/start →
`GET /api/token` → LiveKitRoom mount. Reconnect: `onDisconnected` reason-gated
(DUPLICATE_IDENTITY stand-down; ≤3 auto-rejoins; budget reset on `markAgentReady`).
Keepalive: EventSource SSE `${agent}/events` + 20s health-ping fallback (:149–196).
Idle: 15-min voice-inactivity → sandbox stop (60s checks; meeting heartbeat exempt).
**iOS gaps:** no visibilitychange/pagehide handling (🔴 ⏳P1.8); SSE suspended in
background (🟡 ⏳P1.8); wake lock absent (⏳P1.8). Native: app lifecycle events +
APNs (Phase 2).

### 3.3 Data-channel protocol (`user-input` → / `osborn-updates` ←)
**Send (~25):** noise_cancel, list_slots, permission_response, plan, get_plan_file,
get_research_artifact, list_processes, list_sessions, resume_session,
continue_session, user_text, replay_message, mcp_toggle, get_mcp_status,
spawn_background_session, dispatch_background, stop_background_session, join_meeting,
leave_meeting, start_ide, stop_ide, session_selected, skill_get, skill_remove,
skill_add.
**Recv (~25):** agent_ready, agent_state, user_transcript, tts_chunk_playing,
assistant_response, system, research_task_started/complete, agent_started,
noise_cancel_state, gate_dropped, agent_stopped, task_completed, tool_use,
task_review, claude_output, permission_request, permission_response, status_update,
progress_update, sessions_list, current_session, session_resume_set/failed,
session_switched, plan_file_updated/content, research_artifact_updated/content,
session_artifacts, fast_brain_response, mcp_status/servers_changed/toggle_result,
skills_status, agents_status, skill_content/remove_result/add_result,
claude_auth_required/url/waiting_code/submitting/complete/error,
meeting_joining/joined/left/error, ide_status, background_update, slots_list,
process_list.
**iOS:** the protocol itself is transport-agnostic ✅ — native shells reuse it verbatim
over the same WebRTC DC (iOS) or WS-gateway JSON (watchOS Track 2).

### 3.4 Storage inventory
localStorage (10): `osborn-agent-url`, `osborn-provider`, `osborn-voice-arch`,
`osborn-coding-agent`, `osborn-connection-mode`, `osborn-auto-approve`,
`osborn-auto-approve-permissions`, `osborn-machine-region`, `osborn-favorite-files`,
`osborn-setup-completed`. sessionStorage: `voice-native-seed` (≤20K seed drafts).
Cache: sessions TTL JSON (dashboard). Auth cookies: Supabase SDK (httpOnly).
Sign-out wipes all `osborn-*`. No IndexedDB/cookies writes in app code.
**Native:** UserDefaults; sync-token + auth → Keychain (P2).

### 3.5 Network inventory (by caller)
- `/chat`: `/api/sandbox` (GET, POST connect-room/start/keepalive/leave-room/fetch-log),
  `/api/token`, `${agent}/health` (15s poll), `${agent}/events` (SSE),
  `${agent}/session-messages`, `${agent}/connect-room` (fallback), DC traffic.
- `/dashboard`+`/settings`: `/api/sandbox` (all actions + DELETE), `/api/instance`,
  `${agent}/sessions(+/export|/import)`, `/secrets`, `/skills`, `/agents`, `/health`.
- `/library` + `/p/*`: `/api/content/{chat,refine,renditions,publish}`, Supabase reads.
- All 18 API endpoints: token · sandbox(GET/POST/DELETE) · instance · favorites ·
  session-files · upload · content×4 · browser-screen-recorder×4 · sync-skill ·
  test-skill×2.

### 3.6 Browser-API matrix
| API | Where | iOS Safari | Native equivalent |
|---|---|---|---|
| getUserMedia (via LiveKit) | /chat | ✅ 13.4+ incl. A2HS | AVCaptureSession (P2) |
| WebRTC/RTCDataChannel | /chat | ✅ | LiveKit Swift SDK (P2); WS gateway (watch) |
| AudioContext | meeting-canvas only | ✅ | AVAudioEngine |
| EventSource | keepalive, canvas | 🟡 background suspend | app lifecycle + push (P2) |
| clipboard (write/read, paste) | ~20 sites | ✅ (all gesture handlers) | UIPasteboard |
| localStorage/sessionStorage | §3.4 | ✅ | UserDefaults/Keychain |
| history.replaceState | connect flow | ✅ | n/a in shell |
| **Absent by design** | no SW · no push · no wakeLock · no vibration · no IndexedDB · no setSinkId · no camera · no MediaRecorder · no fullscreen | — | SW/push → P2 APNs; wakeLock → P1.8 + native idle-disabled |

---

## 4. Native-equivalent rules (iOS 17–26)
getUserMedia → AVAudioSession/AVCaptureSession · WebRTC → LiveKit Swift (iOS ok;
watchOS needs gateway) · SSE keepalive → lifecycle+APNs · localStorage → UserDefaults ·
secrets/tokens → Keychain · tab-visibility → UIApplication states via Capacitor App
plugin · wake lock → `isIdleTimerDisabled` · clipboard → UIPasteboard · A2HS/manifest →
the native app itself.

## 5. Gap register (numbered → phase item)
- **G1** 🔴 No audio autoplay-unlock UI → P1.6
- **G2** 🔴 No mic-permission-denied recovery → P1.7
- **G3** 🔴 Background/lock = ≤3 FULL reconnects, no visibility fast-rejoin → P1.8
- **G4** 🟡 SSE keepalive dies in background → P1.8
- **G5** 🔴 No `viewport-fit=cover` → env(safe-area-*) inert → P1.1
- **G6** 🔴 No manifest/apple meta/icons → P1.1–P1.3
- **G7** 🟡 iOS AEC re-enable race → P1.9
- **G8** 🟡 Input auto-zoom (<16px inputs) → P1.5
- **G9** 🟡 Touch targets <44pt → P1.10
- **G10** 🟡 Mobile IA violates 3-6-9 on several screens → P1.e restructure
- **G-OAUTH** 🔴 (Phase 2) `signInWithOAuth` in WKWebView → `disallowed_user_agent`;
  needs SFSafariViewController/ASWebAuthenticationSession + deep link + one-time code
- **G-PUSH** ⛔ Web-push actions dead on iOS → APNs in Phase 2 shell
- **G-BGAUDIO** ⛔ Background audio impossible in Safari → UIBackgroundModes `audio`
  in Phase 2 shell
- **G-WATCH** ⛔ LiveKit Swift has no watchOS target (#288) → WS gateway (Track 2)

## 6. Watch parity (from docs/watch-app-research-2026-10.md)
- **Track 1 (answers-only):** permission prompts + blocking questions push to the
  wrist via Pushover priority=2; ack (tap) = yes, expiry (10 min) = no. Maps the
  `permission_request` DC event and agent blocking-question paths → push →
  `/api/watch/ack/[qid]` (HMAC) → agent `permission_response`. No other controls.
  **3-6-9: watch = 1 action (the tap).**
- **Track 2 (full voice):** watch app streams 24kHz PCM over WS to a gateway on the
  user's Fly machine bridging into LiveKit; reuses §3.3 protocol as WS JSON. Glance
  (agent state) + tap-to-talk + question sheet. **3-6-9: 3 (glance/talk/answer).**

## 7. Test matrix
| Feature | Safari tab | A2HS standalone | Capacitor (TestFlight) | watchOS |
|---|---|---|---|---|
| Safe areas (G5) | n/a | ✅ P1.1 | ✅ | n/a |
| Dark splash + icon (G6) | n/a | ✅ P1.2/3 | native | native |
| Mic + denied recovery (G2) | ✅ P1.7 | ✅ P1.7 | native prompt | n/a |
| Autoplay unlock (G1) | ✅ P1.6 | ✅ P1.6 | native AVAudioSession | n/a |
| Lock/unlock mid-session (G3/G4) | 🟡 | ✅ P1.8 | ✅ lifecycle | Track 2 |
| Background audio (G-BGAUDIO) | 🔴 | 🔴 | ✅ UIBackgroundModes | Track 2 |
| Push (G-PUSH) | 🔴 | 🔴 | ✅ APNs | ✅ native |
| 3-6-9 IA (G10) | ✅ P1.e | ✅ P1.e | ✅ | 1-tap |
| OAuth (G-OAUTH) | ✅ | ✅ | P2.2 deep link | n/a |
