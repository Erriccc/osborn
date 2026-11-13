# Multi-agent runtime — build plan

Status: **scaffold landed, runtime pending.** This document is the file-level,
phased plan toward the "comm-layer" design (Tier-1 router / Tier-2 workers) and
the meeting multi-agent addressing/mute runtime. It records exactly what is real
today and what each future phase must add, so the work can proceed in small,
safe, additive steps without a risky rewrite of the single-agent voice path.

## What already exists (do NOT reinvent)

The runtime is further along than "nothing":

- **Tier-2 workers are real.** `agent/src/claude-llm.ts` exports `NAMED_AGENTS`
  (researcher / reasoner / writer / planner / reviewer / tester) with per-agent
  model + tool rosters. The Claude Agent SDK dispatches to them via the `Task`
  tool, and `ClaudeLLM` already tracks dispatches end-to-end: `noteTaskDispatch`
  → `claimTaskDispatch` (SubagentStart) → a background-task registry with
  per-flow stop (`stopAgent` / `stopTask`). Per-user named agents arrive from
  the frontend via `set_agents` and run beside the built-ins, which they can
  never override (a fork is a new name; `agent/src/agent-store.ts`).
- **A Tier-1-style triage already exists** for the single-speaker case:
  `agent/src/noise-gate.ts` classifies each utterance `directed | side_talk |
  ambiguous` (fail-open) before it reaches the agent. This is the nearest thing
  to a router today — but it is a binary admit/drop gate, not a lane/worker
  router, and it does not understand multiple addressable agents.
- **Meeting copilot** (`agent/src/meeting-transcript-poller.ts` +
  `index.ts` `recall.on('transcript')`) does fuzzy single-name matching for
  "Osborn" and a global interactive/observer latch (`meetingAddressedUntil`).

What is genuinely missing: (1) a router that picks a **lane / specific worker**
for a turn rather than admit/drop, and (2) **per-agent addressing + per-participant
mute** in a multi-speaker meeting.

## What this PR landed (REAL)

`agent/src/meeting-addressing.ts` — a pure, tested, flag-gated leaf module:

- `buildRoster()` / `resolveAgent()` — a typed addressable roster
  (`MeetingAgentDef[]`) the runtime can later point at `Object.keys(NAMED_AGENTS)`
  via `meetingAddressing.setRoster(...)`.
- `parseAddressing()` — resolves `@researcher` mentions (and a leading
  `reasoner, ...` address) against the roster, returns the target id + the
  utterance with only that one token stripped (never a paraphrase).
- `parseMuteCommand()` + `MuteRegistry` — conservative "mute/unmute <name>"
  command parsing and a case-insensitive muted-speaker set with mute-all.
- `meetingAddressing` singleton with an `enabled` getter reading
  `OSBORN_MEETING_ADDRESSING` lazily (off unless `on`/`1`/`true`) and
  `processUtterance()` that is a **pure pass-through when disabled**.

Wired into `index.ts` meeting transcript handler behind `if
(meetingAddressing.enabled)` — a strict no-op when the flag is unset. When on,
it honours `drop` for muted speakers and **logs** the addressed worker. Test:
`agent/tests/meeting-addressing.test.ts` (21 cases, `npx tsx`).

## What is still SCAFFOLD (not wired)

- `processUtterance().target` identifies the addressed worker but does **not**
  route the turn to it. Today the meeting flush still goes to the orchestrator.
- Mute currently only affects the live `recall.on('transcript')` buffer. The
  batch poller path and the frontend mute UI are not involved.
- No frontend affordance (mute buttons, "@agent" chips, drop tombstones for
  meetings). No per-user roster wiring from `NAMED_AGENTS`.

## Phased plan

### Phase A — addressing/mute scaffold (THIS PR, done)
Pure module + flag + mute-drop in the meeting buffer + logs + tests. Zero
behavior change when the flag is unset.

### Phase B — roster from the real agent set + frontend surface
- `index.ts`: on session start, `meetingAddressing.setRoster(Object.keys(
  effectiveAgents))` so `@`-addressing tracks the live NAMED_AGENTS / per-user
  agents (still behind the flag).
- Emit addressing/mute state to the frontend over the existing data channel
  (mirror the noise-gate `drop`/`state` events) so the meeting UI can show
  muted participants and an "addressed @agent" chip. Add a `mute_participant`
  control message (authenticated via `data-sender-auth.ts`).
- Still no routing — `target` remains advisory.

### Phase C — route an addressed turn to its Tier-2 worker
- When `target` is a worker (not `osborn`), inject a directive turn that makes
  the orchestrator dispatch that specific named agent via `Task` (the existing
  dispatch/registry/stop plumbing in `claude-llm.ts` already handles the rest).
  Prefer steering the existing orchestrator over a second parallel `query()` —
  one SDK session keeps memory/cache coherent.
- Reuse `statusManager.getActiveDispatchIds()` for concurrency headroom so a
  busy room cannot fan out unboundedly.

### Phase D — generalize Tier-1 from gate to router
- Promote `noise-gate.ts` from admit/drop to a lane classifier that can emit a
  worker/lane label (still fail-open to "orchestrator, no routing"). Share the
  roster with `meeting-addressing.ts`. This is the "comm-layer Tier-1 router"
  for the non-meeting voice path and must stay off by default until proven.

## Safety discipline for every phase
- Each phase stays behind a flag that defaults to current behavior; the
  single-agent voice hot path is never altered when flags are unset.
- Pure parsing/decision logic lands with `*.test.ts` (`npx tsx`) before any
  hot-path wiring.
- Fail-open everywhere: a broken router/gate degrades to "forward to the
  orchestrator", never to a deaf agent.
