# Phase 3 (fast-brain-speaks-first) + Phase 4 (keep-warm re-attach) — design

Grounded in verified code sites. Phases 1 (dashboard bounded read, `a22e708`) + 2
(skip redundant health poll, `7dfb78f`) already shipped. These two are the
remaining pieces: Phase 3 covers the *cold first turn* (so you're not in silence
during a replay), Phase 4 eliminates the replay entirely on *reconnect*.

---

> **DECISIONS (user, 2026-10-21) — pruned:** Phase 3 (fast-brain-speaks-first)
> is **CUT** (no "temporary handover" to the fast brain — avoids the wrong-answer
> risk). Speculative "warm the most-recent session on dashboard load" is **CUT**.
> The first-connect lever is **click-time overlap ONLY** (start the replay when the
> user clicks to connect, overlapping the handshake — NOT on hover, no speculation).
> Remaining deterministic stack: **click-time overlap** (first connect) +
> **keep-warm re-attach** (reconnects) + **cap/SDK-cache lever** (residual on huge
> cold sessions, pending the replay-cost agent).

---

## Click-time overlap (first-connect lever — replaces Phase 3)

**Goal:** the one-time cold replay for a selected session runs DURING the connect
handshake, not serially after the first spoken word.

Today the replay starts lazily on the first `pushMessage` after the full connect
(`claude-llm.ts:1874` cold-start). `/connect-room` takes no body
(`index.ts:743`); the sessionId only reaches the agent via JWT metadata on
`ParticipantConnected` (after the WebRTC join). So the replay can't begin until
late.

**Change:** carry the selected `sessionId` into `/connect-room` so the agent can
kick off the subprocess cold-start (an empty warm-up turn / `resume`) the instant
connect-room is called — in parallel with the frontend's token mint + WebRTC
join + the user getting situated.
- Frontend: `ChatSessionProvider.connect()` already knows `preSelectedSessionId`
  — include it in the `/connect-room` POST body (cloud: `/api/sandbox` action
  body; local: `/connect-room` body).
- Agent: `/connect-room` / `connectRoomHook` reads the body sessionId and, if
  present and not already warm, begins the cold-start resume immediately (fire-
  and-forget; the normal `participantConnectedHandler` then finds it in-flight or
  done instead of starting it). Guard against double-start.
- No speculation, no prediction: the session is the one the user just clicked.

**Residual:** for a 323MB session, replay (~30s) still exceeds the handshake
(~5–10s), so a gap remains on a first cold touch — covered by the cap (50–100MB)
and/or the SDK-cache lever, NOT the fast brain.

---

## Phase 3 — fast-brain-speaks-first — CUT (kept below for reference only)

### Current state (verified)
The fast brain runs in parallel on every turn (`pipeline-direct-llm.ts:458`
`askPipelineFastBrain`), produces `{ type: 'answer'|'research_needed'|'acknowledgment'|'error', script, toolsUsed }`
(`pipeline-fastbrain.ts:22`), and `onFastBrainResult` (`index.ts:4380`) **only
sends it to the UI** (`fast_brain_response`) — it never speaks. Claude's answer
is the only thing that reaches TTS (`session.say` via `tts_say`). So during a
cold replay you hear the static "Welcome back", then **silence for 21–40s** until
Claude's first answer. That silence is the problem.

### Risk to design around
The fast brain is a cheap history-search model; its own prompt says *"Your own
prior answers may have errors. Trust search results over your memory."*
(`pipeline-fastbrain.ts:325`). So it must **never confidently speak a wrong
answer** before Claude. The design gates hard on confidence and defaults to a
*bridge*, not a committed claim, when unsure.

### Design
1. **Add a confidence signal to the fast-brain result.** `pipeline-fastbrain.ts`:
   have the model emit `confidence: 'high'|'low'` (or derive it: `high` only when
   the answer is backed by ≥1 real `search_session`/`get_recent` hit this turn and
   `type==='answer'`; `low` otherwise). No new model call — fold into the existing
   structured output.
2. **A "Claude is slow" trigger, not "always speak".** In `#firePipelineFastBrain`,
   after the fast-brain result resolves, start a short timer (`OSBORN_FB_SPEAK_DELAY_MS`,
   default ~1500ms). If Claude has **already** emitted its first `tts_say` by then
   (warm path — Claude is fast), the fast brain stays **silent** (no change from
   today). Only if Claude is still quiet past the delay (the cold-replay case) does
   the fast brain speak. This makes it a no-op on warm connects and only engages
   exactly when there'd otherwise be dead air.
3. **What it speaks, by confidence:**
   - `high` → speak the actual answer (`result.script`), prefixed internally so the
     turn is tracked.
   - `low` → speak a brief **bridge** only ("One sec — pulling that up.") so you're
     not in silence, and let Claude deliver the real answer.
4. **Supersession / no double-answer.** When Claude's `tts_say` finally arrives:
   - If the fast brain already spoke a `high` answer, inject a one-line note into
     Claude's turn (via the existing enrichment path) — *"A preliminary answer was
     already spoken to the user: '<script>'. Only respond if you have more or need
     to correct it; otherwise acknowledge briefly."* — so Claude doesn't repeat it
     verbatim. (Claude is the authority; it can always override.)
   - If the fast brain spoke only a `low` bridge, Claude just answers normally.
5. **Barge-in:** if the user interrupts the fast-brain line, normal interrupt
   handling applies (unchanged).
6. **Rollout safety:** behind `OSBORN_FAST_BRAIN_SPEAK=on` (default **off**), so it
   ships dark and we enable after live A/B. The noise-gate kill-switch pattern.

### Touchpoints
- `pipeline-fastbrain.ts` — add `confidence` to the result + prompt line.
- `pipeline-direct-llm.ts` `#firePipelineFastBrain` — the delay timer + speak
  decision; expose a `speakFastBrain(script)` hook on the pipeline.
- `index.ts` `onFastBrainResult` — route a speak-decision to `session.say` (gated
  on Claude-not-yet-speaking, which `currentSession` state already tracks), and
  set the "preliminary answer spoken" note for Claude's next enrichment.
- Interaction with the replay-speedup agent: **if** that agent finds a
  decouple-first-answer-from-replay SDK path, this phase becomes the *fallback*
  and that becomes primary; otherwise this is the primary cold-turn cover.

---

## Phase 4 — keep-warm re-attach

### Core (verified feasible — the primitive already exists)
`createDirectSession(resumeSessionId?, llmOverride?)` already reuses a passed LLM
instead of building one (`index.ts:3433/:3442`), and the auto-recovery path
already does exactly this re-attach (`index.ts:4830`). The meeting path already
keeps the LLM alive across a voice drop (`index.ts:5078`). So Phase 4 generalizes
proven code.

### State (module scope, near `index.ts:2070`)
```
let warmLLM: PipelineDirectLLM | null = null
let warmSessionId: string | null = null
let warmExpiry = 0
const REATTACH_GRACE_MS = Number(process.env.OSBORN_REATTACH_GRACE_MS || 150_000) // user: 2–3 min
const WARM_HARD_CEILING_MS = Number(process.env.OSBORN_WARM_CEILING_MS || 420_000) // 7 min superset sweep
let warmWatchdog: NodeJS.Timeout | null = null
// observability
let warmStats = { starts: 0, reattachHits: 0, wastedTimeouts: 0, watchdogKills: 0 }
```

### On hard `ParticipantDisconnected` (non-meeting) — `index.ts:5048`
Replace the unconditional `killCurrentLLM` + `releaseAgents` + `armFastLeaveTimer`
with:
- **If** `participant.disconnectReason === DisconnectReason.DUPLICATE_IDENTITY`
  → this is a device handoff/takeover, NOT a session end. Do **nothing**
  destructive: keep `currentLLM`, do not releaseAgents, do not arm teardown —
  the incoming device's `participantConnectedHandler` owns continuation. (H1 fix.)
  rtc-node exposes `disconnectReason` (`participant.d.ts:27`).
- **Else** (network/tab-close hard drop): transfer ownership
  `warmLLM = currentLLM; warmSessionId = currentLLM.sessionId; currentLLM = null`;
  close `currentSession` (releases the Soniox WS + byte-stream handler) and null it;
  **destroy the LiveKit room** (the brain doesn't need it — meeting path proves)
  to stop connection-minute burn, but DO NOT `killCurrentLLM` and DO NOT
  `releaseAgents` (sub-agents keep running — user's choice); arm `warmExpiry =
  now + REATTACH_GRACE_MS`; start `warmWatchdog` at `WARM_HARD_CEILING_MS`.
  `warmStats.starts++`.

### On connect — `participantConnectedHandler` before `:4355`
```
const requested = preSelectedSessionId || undefined
if (warmLLM && warmSessionId && requested === warmSessionId && Date.now() < warmExpiry) {
  // RE-ATTACH — zero replay
  clearWarmWatchdog()
  const llm = warmLLM; warmLLM = null; warmSessionId = null
  llm.events.removeAllListeners('tts_say')          // B2: no double-wire
  llm.events.removeAllListeners('assistant_text')
  llm.events.removeAllListeners('tool_use'); llm.events.removeAllListeners('tool_result')
  // (re-wire happens inside createDirectSession)
  await pendingSessionClose                          // HIGH-1: byte-stream race
  const r = await createDirectSession(requested, llm)  // llmOverride path
  session = r.session; agent = r.agent
  warmStats.reattachHits++
} else {
  if (warmLLM) { killCurrentLLM-on(warmLLM); warmLLM = null; warmSessionId = null } // mismatch → no leak
  // ... existing cold-start path (createPipelineDirectLLM + createDirectSession) ...
}
```
Always a **fresh Room + AgentSession** on re-attach (never reuse the dropped Room);
only the LLM subprocess is reused. TTS routing follows automatically because the
`tts_say` handler reads module-scope `currentSession` (`index.ts:3713`).

### Teardown invariant + watchdog (the non-negotiable, Phase 0c)
- `warmWatchdog` fires at `WARM_HARD_CEILING_MS`: unconditionally
  `killCurrentLLM(warmLLM)`, `releaseAgents()`, null warm state, arm idle-exit.
  `warmStats.watchdogKills++`. This is the independent backstop that guarantees
  teardown even if the grace logic has a bug — the $123-billing-bug tripwire.
- Grace expiry (`warmExpiry` passed with no reconnect): same teardown,
  `warmStats.wastedTimeouts++`.
- **Invariant (executable test):** no live client for a session-key AND no
  in-flight sub-agent ⇒ machine stops within `WARM_HARD_CEILING_MS + idle-grace`,
  ALWAYS. One-owner: the subprocess is owned by exactly one of
  `{currentLLM, warmLLM}` or is killed — never two live, never orphaned.
- Expose `warmStats` on `/health` for observability.

### Identity H2 fix (prerequisite, in Phase 0a's file)
`token/route.ts`: for a brand-new session (`!sessionId`), do NOT fall back to the
machine-stable `roomCode` — use a per-connection unique suffix so two new
conversations on one machine don't collide/evict. `sessionKey = sessionId ||
\`new-${crypto.randomUUID()}\``. Stable identity still holds for any
dashboard-launched session (which carries sessionId). Optionally bind userId into
identity for the link-as-bearer-takeover threat (M2) — later.

### Backward-compat tests (red-team's list, before ship)
warm-reattach listener hygiene (exactly one `tts_say` listener after re-attach);
teardown invariant (executable, no-live-client ⇒ stop); new-session identity
non-collision; handoff preserves warm brain (no `killCurrentLLM('previous_session_cleanup')`
on DUPLICATE_IDENTITY); cold-resume parity (SDK `resume` path unaffected);
export-one round-trip; store-rebuild-after-model-bump; incremental-ingest-across-fork.

### Interaction with Phase 3 and the cap
- Warm re-attach → zero replay on reconnect (the common case). Phase 3 covers the
  cold first turn. The 50–100MB cap (separate, later) bounds how big a *cold*
  replay can get. All three compose: warm=0 replay, cold=bounded replay + fast-brain
  bridge.
