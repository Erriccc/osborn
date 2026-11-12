# Adversarial review of PRs merged 2026-11-12

First run of the `pre-pr-reviewer` agent (`.claude/agents/pre-pr-reviewer.md`), retroactively, on the PRs merged on 2026-11-12. Three reviewers, read-only. Findings are the reviewers' and have not been independently re-verified. Line numbers refer to `origin/main` at `c75af48`.

Cleanup of merged code is owned by the local session; new work (PR #152 onward) is handled on `claude/vibrant-hamilton-1zfd2n`.

## Browser engine (#135, #142, #145, #150) — verdict: fix first

`tests/voice-e2e/scripts/session-engine.ts` grew from 1088 to 1578 lines in one day.

Bugs:
1. **Disk fill (#145).** `peekAudioToWav` writes a new `_peek-<id>.wav` per call (`:405-407`); `muxClipAudio` (`:416-429`) and `GET /audio` (`:922`) never delete it. Each `/clip?n=N&audio=1` or `/audio` leaves a whole-recording decode (up to ~170–345 MB) on the Fly volume, kept across 30 runs (#142 raised `KEEP_RUNS`). Fix: `rmSync(a.wav)` in a `finally` in both callers.
2. **Wrong `/say` warning (#145).** `:1222` counts `OPENAI_API_KEY` as a speech-to-text key; `hearSince` only uses Soniox or Deepgram. Fix: drop it from the check.

Ownership / growth:
3. Brain provider selection (`pickBrainModel`, `:264-298`) and the provider-down retry live in the HTTP handler script; the `/act` handler is 163 lines with snapshot, effect detection and scroll logic. Belongs in `lib/` (e.g. `lib/brain.ts`, `lib/effect.ts`).
4. `reqClip` (`:360-368`) is dead; `/act` and `/say` inline `clipRange` with copied error strings.
5. Scroll direction is parsed three times and the mouse wheel implemented twice (`:1032-1045`, `:1080-1092`, `:1118-1125`).

Shrink, about 150–170 lines: one `wheelScroll` helper; `reqClip` on `clipRange`; `muxClipAudio` as a call to `muxSayAudio`; hoist `bounded` and replace five hand-written `Promise.race` timeouts (`:437, 640, 829, 998, 1253`); use `loadRunTasks` in `/clip?run=` and `/runs`; one `lockedDrive(driver, fn)` wrapper for the repeated focus/ownership/409 preamble; one `forgetCached` call; drop response fields that duplicate `evidence`; about 80 lines of history comments; `BrowserPanel.tsx` repeats the "Not authenticated" 401 check three times and `refreshEngineState` re-implements `jget`.

Unconfirmed: `SHARE_SECRET` is random per process when neither `OSBORN_ENGINE_TOKEN` nor `OSBORN_SHARE_SECRET` is set (old evidence links 403 after a restart); an async job evicted after 200 entries makes `jobs.get(id)!` throw inside the fake `res.end`; `x-control-base`/`x-forwarded-host` are client-controlled (needs the engine token).

## Frontend (#147, #149, frontend part of #145) — verdict: fix first

1. **#149 — one session's history saved under another's id.** `serializeTranscript` (`frontend/src/lib/transcript-cache.ts:74`) does not drop `fromCache` rows; after `session_resume_failed` (`VoiceRoom.tsx:2242`) `currentSessionId` becomes B with A's rows on screen, and the save at `VoiceRoom.tsx:871` writes A's transcript under B. Fix: skip `fromCache` (and foreign `prior-`) rows in `serializeTranscript`; clear them on `session_resume_failed`.
2. **#149 — the 8-session cap can evict the current session.** `capSessions` (`transcript-cache.ts:103`) assumes `localStorage.key(i)` is insertion-ordered. Fix: store a timestamp and evict by it.
3. **#145 — a warm-pool claim can move a spare back to an older image.** `repointAndStartSandbox` (`machines.ts:848`) always overwrites the image; on registry/token failure the resolver falls back to `:latest`. Fix: keep `existingConfig.image` on fallback.
4. **#147 — "Connect without account" on `/login` still ends in a sign-in error.** `/api/token` refuses every signed-out caller, so the guest email form (`/api/demo-access`) leads to the new early return in `ChatSessionProvider.tsx:473`. Fix: remove the guest form, or give `/api/token` a guest path. Self-hosted installs without Supabase are not broken.

Shrink: `machines.ts:123-195` (~75 lines) plus its 95-line test may be unnecessary now that #145 also retags `:latest` on every 15-minute image check; `getSandboxImage(await resolveOsbornLatest())` gives a pinned tag in one line (as `updateOsborn` does). If kept, it repeats `compareVersions` (`image-build-check.ts:313`), the tag-list call (`image-build-check.ts:131`, `harness-deploy-check.ts:97`), and a third copy of the npm-latest lookup (`machines.ts:928`, `sprites.ts:122`, `image-build-check.ts:115`). #147 left ~20 lines of dashboard code that can no longer run (`dashboard/page.tsx:1728-1746`, `:1172-1181`).

Unconfirmed: `image-build-check.ts` retags `FLY_SANDBOX_APP` (default `osborn-sandbox`) while new machines use `FLY_SANDBOX_IMAGE` (default `osborn-sandbox/agent`); if they differ in production the retag does nothing. #149's reload retry runs ~2.5 minutes and never clears cached rows if the agent keeps returning an empty list.

## Agent (#148) — verdict: fix first

The "Claude v0.9.277" badge seen on a no-Claude test account was the old release, which hardcoded `provider: 'claude'`. #148 bumps to 0.9.278 and resolves `zai` for that machine. It can still report `claude` if `CLAUDE_CODE_OAUTH_TOKEN` is set to anything non-empty: `hasOAuthTokenEnv()` (`claude-auth.ts:148`) does no expiry check and no `cleanEnvKey`.

1. **The "No working model" notice never clears and the badge stays wrong after sign-in.** After Claude sign-in (`index.ts:6171-6183`) `agentKeyHealth` keeps the failed z.ai entry and no new `agent_ready` is sent; the frontend only updates key health when `/health` includes it (`VoiceRoom.tsx:786`) and `mainProvider` stays `zai` (`VoiceRoom.tsx:4033`). Fix: reset `agentKeyHealth` and resend the provider; set the state from `d.keyHealth ?? undefined`.
2. **"No configured model works" after testing only one key.** The probe tests the chosen tier only (`index.ts:5217`); `resolveAgentHealth` reports all failed (`agent-health.ts:145-155`). Fix: name the provider, or try the next tier on 401/402.
3. **`provider: null` leaves the old badge** (`index.ts:5883`; frontend ignores non-strings at `VoiceRoom.tsx:1748`). Fix: clear `mainProvider` on null.

Shrink, ~70 lines: `key-health.ts` header and restating doc comments (~35), the unused `'claude-3-5-haiku-latest'` default, #87-history comments in `index.ts` (~25), a 10-line comment for one prop in `VoiceRoom.tsx:4021-4030`. `KeyHealthEntry` is defined in both `agent/` and `frontend/` (acceptable: no shared package).

Unconfirmed: a leftover `ANTHROPIC_AUTH_TOKEN` is labelled `'anthropic'`; pipeline-fastbrain skips `cleanEnvKey` for z.ai/OpenRouter keys (`pipeline-fastbrain.ts:74, 472`), older code.
