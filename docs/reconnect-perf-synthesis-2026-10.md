# Reconnect-survival + sub-second-connect — 4-agent adversarial synthesis (2026-10-21)

Four parallel agents: log-timing forensics, server/boot architect, transport/handoff architect, adversarial red-team. All read the live tree at `~/Developer/osborn` (the stale `~/Desktop/...` iCloud copy trapped the Explore sub-agents — avoid it).

## THE REFRAME (from the forensics — measured, not assumed)

**"Ready to respond" is already sub-second: median 0.74s warm (0.48–1.05s, n=12).** The sub-second target for the listen/respond path is already met when machine+session are warm. What's slow — and what actually hurts — is three different things:

1. **The post-reconnect context load: median 21s, up to 40s.** The proactive "Welcome back" greeting (and a context-aware answer) waits on the Claude SDK **replaying the session JSONL**. Measured to scale linearly with transcript size: **155MB/36k rows → ~14s; 323MB/93k rows → 21–39s.** This is 95%+ of connect→useful. It is THE bottleneck.
2. **Sessions die on any hard drop** (the teardown chain: `👋 User left` → kill subprocess → room destroyed → machine idle-stops). So you pay that 21–40s replay on *every* reconnect.
3. **Cold boot ≈ 6–8s** (Fly start + Node boot + the synchronous 6,739-artifact housekeeping scan — already deferred in 0.9.257 — + LiveKit connect).

The two monster transcripts: `4ba9e287` (AudosNextJsServer) = **323MB/92,967 rows** (130× the next file in its project), and `c97588f4` = **155MB/36,675 rows**.

**Implication:** warm re-attach isn't a nice-to-have — it **eliminates 21–40 seconds per reconnect**. And a *true* cold resume on a 323MB session is fundamentally ~21–40s unless the JSONL is shrunk. These two are the whole ballgame; token pre-mint etc. save hundreds of ms.

## RED-TEAM BLOCKERS (reshaped the plan)

- **B1 — two disconnect classes.** Transient blips self-heal via LiveKit auto-reconnect (agent never sees them); only *hard* `ParticipantDisconnected` reaches the teardown path. The deaths in the logs ARE the hard class, so the plan targets the right event — but don't add warm-billing for the transient case auto-reconnect already covers.
- **B2 — re-attach double-wires the event bus.** Re-running `createPipelineDirectLLM`/`createDirectSession` on a warm LLM registers duplicate `tts_say`/`permission_request`/etc listeners → double-speak, or points listeners at a dead LLM. Fix: `removeAllListeners` first (the `tts_say` handler already reads module-scope `currentSession`, so re-pointing it is enough for audio to follow). The `llmOverride` path on `createDirectSession` (used by auto-recovery :4830) is the existing, proven re-attach primitive.
- **B3 — bypasses the only sub-agent release site → billing-leak class.** `releaseAgents()` runs only inside `handleParticipantDisconnected` (:5105); `agentsActive()` suppresses ALL teardown timers while any slot lives. Keep-warm must NOT bypass it. Non-negotiable: one reconciled teardown state machine + an independent leak watchdog (this is the $123 empty-room bug's exact shape — `fly.toml` has `auto_stop_machines="off"`).
- **B4 — identity is `user-${Date.now()}` → handoff + single-client are unexpressible, teardown counts raw participants (two tabs already double-bill).** Must fix identity FIRST as a prerequisite.

## RECONCILED ARCHITECTURE (where the agents converged)

- Keep the Claude subprocess warm on a hard drop and **re-attach** a fresh AgentSession to it on reconnect (saves the 21–40s replay). Proven 3× in-codebase (meeting path :5078, auto-recovery :4830, connectRoomHook reuse :6334).
- **Cost control (red-team's better idea):** the idle warm subprocess is cheap (not generating tokens); the real costs are holding the LiveKit room (connection-minutes) and leaving background sub-agents *running*. So: keep the subprocess warm for the grace, but the meeting path proves the LLM doesn't need the room — tear the room down, keep only the brain, unless there's in-flight work worth the room. Gate the expensive bits on `slots.size>0 || dispatchInFlight`.
- **Identity = `user-<sessionKey>`** → LiveKit's native `DUPLICATE_IDENTITY` eviction IS the handoff + single-client primitive (verified: `disconnectReason` is exposed to the agent via rtc-node `participant.d.ts:27`; enum `DUPLICATE_IDENTITY=2`/`SIGNAL_CLOSE=9` confirmed; client docs confirm the incumbent is evicted when a same-identity client joins — the laptop→phone direction we want). A `DUPLICATE_IDENTITY` disconnect → keep brain, don't tear down; a `SIGNAL_CLOSE` → grace window.
- **Shrink the giant JSONLs** via `forkSession`/compaction at compaction boundaries so a true cold resume replays MBs, not 155–323MB. Decouple the greeting from full replay (or skip the proactive greeting on warm re-attach — no replay needed there).

## PHASED BUILD ORDER

**Phase 0 — prerequisites (small, unlock everything):** stable `user-<sessionKey>` identity (B4); reason-gate `onDisconnected` so a drop shows "Reconnecting…" instead of bouncing to /dashboard (transport step1, red-team MED-1 — biggest UX win, smallest change); observability counters (warm-starts / reconnect-hits / wasted-timeouts / leaks) + an independent leak watchdog (red-team insist #3).

**Phase 1 — warm re-attach (THE 90% win; saves 21–40s/reconnect):** on hard `ParticipantDisconnected` non-meeting, transfer `currentLLM→warmLLM`, close the AgentSession (release byte-stream), keep the subprocess alive, arm ONE grace that supersedes the 20s/3min timers (no 4th/5th overlapping timer). On reconnect + matching sessionId within grace: reuse `warmLLM` via `createDirectSession(sessionId, warmLLM)`; `removeAllListeners` first (B2); fresh Room per re-attach + `await pendingSessionClose` (HIGH-1). One-owner invariant; `releaseAgents` on every terminal path (B3).

**Phase 2 — shrink the JSONLs (required for cold <5s):** `forkSession`/compact `4ba9e287` (323MB) & `c97588f4` (155MB); decouple greeting from replay.

**Phase 3 — connect-path parallelism + early wake:** pass `sessionId` in the `/connect-room` body so subprocess cold-start begins immediately; wake the machine on session-page load (not click); parallelize the serial health/room-code polls (red-team HIGH-3); token pre-mint + `room.prepareConnection`.

**Phase 4 — client drop guards (make drops rare):** silent WebAudio keepalive (quiet-stretch tab-suspend); `navigator.wakeLock` (opt-in/activity-gated); `RoomOptions{disconnectOnPageLeave:false, reconnectPolicy, webAudioMix}`.

**Phase 5 — handoff + single-client:** `DUPLICATE_IDENTITY` takeover (enabled by Phase 0), `disconnectReason`-gated so takeover ≠ teardown; the dead-tab-from-logged-out-phone wake path (red-team HIGH-4, no `user.id`); link-as-credential threat model (red-team MED-3).

## Before anything ships (red-team's non-negotiables)
1. One reconciled teardown state machine superseding the 20s/3min/15min timers + the grace, proving: *no live client for session-key AND no in-flight sub-agent ⇒ machine stops within N min, always.*
2. Stable identity as its own prerequisite PR.
3. Warm-window observability + an independent leak watchdog (the $123 bug tripwire).

Each phase gets the established discipline: typecheck + full regression suite + adversarial regression tests before publish.
