# Regression suites — fast-brain / meeting-mode / steering-stop contracts

Characterization tests written 2026-10-20 (agent 0.9.254) to **pin current
behavior before the noise-gate feature** touches the fast-brain and
meeting-mode paths. They assert what the code does TODAY; any change that
breaks one of these contracts must fail loudly here (and if the break is
intentional, update the matching check in the same commit).

## Run

```bash
bash agent/tests/regression/run-all.sh        # everything (recommended)
npx tsx agent/tests/regression/<suite>.ts     # one suite
npx tsc --noEmit -p agent/tests/regression/tsconfig.json   # type pins only
```

All commands are run from anywhere (paths are script-relative). **HOME
sandbox:** `claude-llm.ts` writes `~/.claude/settings.json` at module load, so
run-all.sh gives every behavioral suite a throwaway `$HOME`; the suites also
self-sandbox via `sandboxHome()` in `_shared.ts`, so a bare `npx tsx` run is
safe too.

## Suites

| Suite | Kind | Protects |
|---|---|---|
| `static-checks.ts` | source-anchored | Ported verbatim from `/tmp/osborn-regression/`. 0.9.253/254 contracts: `perTaskStopAffordance` declared where `enableFileCheckpointing` is set; interrupt enrichment truthful (SURVIVED, never "SEVERED"/re-dispatch, no rows failed at interrupt); fast-brain `emergency_stop` is interrupt-only; `pushMessage` priority stamping + deferred push behind `#pendingInterrupt`; `stop_dispatch` awaits `stopAgent` with truthful `stopped`. |
| `behavior-registry.ts` | behavioral (`new ClaudeLLM({})`) | Ported from `/tmp/osborn-regression/` + hardened `2-B6c-hard`. Per-flow stop correlation: FIFO dispatch pairing, `getRunningTasks` shape (only running/pending live), terminal `task_notification` removes + unmaps, **terminal pairing never retargets another agent's task**, single-task type fallback (ambiguous → none), junk-input robustness, `closeSession` clears registry. |
| `fastbrain-contract.ts` | behavioral (stubbed `fetch`) | Contract A. `askPipelineFastBrain` guards (`pending` session, missing key); tool set is exactly `search_session`+`get_recent`, `emergency_stop` added **only** with `agentControl`; `emergency_stop` awaits `agentControl.interrupt()` (never `abort`), then sends an `[EMERGENCY STOP]` redirect via `sendPrompt` carrying reason + recent user messages; tool result claims "background sub-agents unaffected"; `[RESEARCH_NEEDED]` mapping; result shape. |
| `meeting-mode.ts` | behavioral (prototype-stubbed `ClaudeLLM.chat`/`interruptQuery` — no SDK subprocess) + anchored | Contract B. `[MEETING` chunks never consume interrupt context, never fire `interruptQuery`, never fire the fast brain, set `suppressMeetingTTS`, pass text through unmodified; real turns consume once, fire `interruptQuery` once, get the `[INTERRUPTED]` template, clear `suppressMeetingTTS`; suppressed-only → `[CONTEXT]`, no interrupt. Anchored: steer-priority guard excludes `[MEETING`/`[SYSTEM` and is suppressed on `permissionPending`/`compacting`; index.ts `tts_say` meeting gate runs **before** the `currentSession` guard. |
| `pipeline-direct-contract.ts` | behavioral (unpatched) | Contracts C/D. `PipelineDirectLLM.chat` is a **synchronous** function (not `AsyncFunction` — the LiveKit voice pipeline consumes the return as `llm.LLMStream`); `stopAgent` → `Promise<boolean>` resolving `false` with no live task; `getRunningTasks` passthrough; `suppressMeetingTTS` defaults false; `interruptAgent`/`abortAgent`/`hasActiveAgent`/`sendPrompt`/`events`/`sessionId` surface. |
| `steering-stop.ts` | source-anchored | Contract C details private state blocks from behavioral reach: `sdkOptions` sets `perTaskStopAffordance: true`; turn end (`'result'`) clears stale pending dispatch ids; `#resolveTaskId` returns `null` on a terminal pairing **before** the type fallback; `stopAgent` signature + `stopTask` guard; index.ts `stop_dispatch` marks the statusManager row failed **only when `stopped === true`** and sends `runningTasks`. |
| `frontend-voiceroom.ts` | source-anchored | Contract E. `agent_stopped` handler keeps/restores the flow row when `stopped === false && runningTasks > 0` (spared runaway stays visible + stoppable) and clears it otherwise; stop-dispatch click still sends reliably and optimistically clears. |
| `type-pins.ts` (via `tsconfig.json`) | tsc type-identity | Contracts A/C/D/F. Exact-shape `Eq<>` pins: `AgentControlCallbacks` keys + signatures; `askPipelineFastBrain(workingDir, sessionId, question, opts?)`; `ClaudeLLM.stopAgent/getRunningTasks/note/claim/track/pushMessage(pushOpts?: {priority?: 'now'\|'next'\|'later'})`; `PipelineDirectLLM.chat(): llm.LLMStream` (sync); SDK typings `Options.perTaskStopAffordance`, `Query.stopTask(taskId: string): Promise<void>`, `SDKUserMessage.priority`. **Only meaningful under `tsc`** — tsx strips types without checking. An SDK upgrade dropping any of these fails this suite. |

`_shared.ts` holds the helpers (`check`, `sandboxHome`, `anchoredSlice`,
`balancedBlock`, `captureLogs`). Source assertions are anchored to
declarations/branches (throwing when the anchor disappears), never whole-file
substring greps.

## Notes / adversarial observations captured while writing these

- `ClaudeLLM.stopAgent` resolves `false` whenever no persistent query exists,
  even when the task-id resolution chain succeeds — "stopped" is only ever
  reported when `query.stopTask` was actually issued.
- A terminal pairing (`tool_use` claimed, task completed) resolves to `null` —
  it does **not** fall through to the single-task-of-type fallback, so stopping
  a finished agent can never kill a sibling's live task (`2-B6c-hard`, `S3a`).
- The fast brain's whole tool loop is capped by an 8s wall-clock deadline
  (`FASTBRAIN_DEADLINE_MS`) on top of the 20s per-request fetch timeout.
- `emergency_stop` gathers `getRecentUserMessages(10)` and recent activity
  BEFORE interrupting, awaits `interrupt()`, then `sendPrompt`s the redirect.
- SDK `Query.interrupt()` returns `Promise<SDKControlInterruptResponse |
  undefined>` (not `Promise<void>`) — pinned loosely on purpose.
- The `[MEETING` guard in `PipelineDirectLLM.chat` leaves a pending
  interruption context UNCONSUMED for the next real user turn (meeting chunks
  must not burn it) — a noise gate inserted upstream must preserve this.
