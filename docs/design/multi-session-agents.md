# Multi-Session Agents — design & build-toward doc

Status: **design / not built.** Captures the vision, the one hard problem and its
solution, the UX, and — importantly — **which pieces we already have**, so we can
land an MVP cheaply and grow into the full thing without throwing work away.

Author context: voice-first coding agent. Stack = **LiveKit Agents** (voice
transport) + **Anthropic Claude Agent SDK** (the coding agent) + a **per-user Fly
sandbox** per session. Everything below is scoped to that stack.

---

## 1. The idea (in one line)

Talk to **all your projects from a single voice call** — tag one agent, mute the
rest, dispatch work that keeps running in the background, and never lose your seat
in the current conversation.

Two flavors, same principle:

- **MVP — "tag & continue"** (small, ships first): one live agent that speaks;
  you can fire an instruction at *another* project's session in the background and
  get a notification when it's done. No disconnect, no "who speaks?" problem.
- **Full — "the deck"** (later): multiple sessions live at once, shown as a stack
  of cards (playlist / Twitter-Space / Zoom vibe). Mute/unmute/focus each; only the
  focused one holds the mic.

---

## 2. The one hard problem — and the fix

> "If I send a message to two agents, they both reply — **which reply gets spoken
> aloud?**"

This is the crux, and it's solved by separating two channels that we've been
conflating:

- **Delivery** — who *receives* your message. Can be one agent or many. Cheap, no
  conflict.
- **Voice / the mic** — who *speaks aloud and hears you live*. This is a
  **single-holder lock**. Exactly one agent holds it at a time.

**Rule: only the agent holding the mic sends output to TTS.** Every other agent
can receive tagged messages and work, but their output goes to the transcript /
a notification — never the speaker. So "both reply" is fine: nobody auto-speaks
unless they hold the mic.

"Mute" = demote an agent from mic-holder to background (keeps running, stops
speaking, stops live-listening). "Focus/unmute" = promote to mic-holder **and
inject a `you're-live-now, here's-what-you-missed` prompt** (same mechanism as our
interruption injections).

### The orchestrator is NOT a third LLM session

Arbitration is a **deterministic router in the LiveKit/VoiceRoom backend**, not an
LLM. Its whole job: hold the "who owns the mic" pointer, route input to the
mic-holder (+ any @-tagged sessions), gate TTS to the mic-holder, buffer everyone
else into transcript + notifications. ~A small state machine, **zero extra token
cost.** (An LLM orchestrator for smart auto-routing is a later, optional add.)

### Switching ≠ disconnecting

Switching *today* tears down the room because that's how session-switch is
currently implemented. In this model **all sessions stay connected; only the
mic-ownership pointer moves** — a lightweight in-room state change (mute A, unmute
B, inject catch-up), no reconnect.

---

## 3. Topology & caveats (from research)

Of the three canonical shapes — **handoff/swarm**, **supervisor/orchestrator**,
**group-chat/blackboard** — go **supervisor/orchestrator**: workers explore in
their **own context windows** and return only **compact summaries**, so the
orchestrator never holds every agent's full output (the thing that would blow the
context window). Borrow one affordance from group-chat: the **@-mention "tag"**
gesture.

Caveats to design around (sourced):

- **Cost:** multi-agent uses **~15× the tokens** of a chat (Anthropic). Start
  narrow; the multiplier only pays off for high-value work.
- **Silent context loss** is the #1 production failure — pin everything to a
  durable `session_id` (we already do).
- **Notification spam** into a *voice* channel is worse than text — buffer detail,
  surface only on lifecycle events (done / blocked / needs-input) at the next
  natural pause.
- **Resume fidelity:** load a *summary* on resume (keeps context small) backed by
  an external per-project "living spec" / progress file so detail isn't lost.

Reference: Anthropic — *Building a multi-agent research system*
(anthropic.com/engineering/multi-agent-research-system). Their multi-agent setup
beat single-agent Opus by ~90% but at the ~15× token cost.

---

## 4. UX / conversation lifecycle

### MVP — tag & continue (turn-by-turn)

```
You (in the Frontend call): "Tag the Osborn agent — migrate the session-files
                             API to v2, report back."
Osborn:  → runs in the background (its own session), does NOT take the mic.
Agent:   "Sent to Osborn as a background task. It'll ping you when done.
          Back to Frontend — where were we?"
...
(later, at a natural pause)
Agent:   "Heads up — Osborn finished: 4 of 7 endpoints migrated, one blocked on
          an auth question. Summary now or later?"
```

Only the one live agent ever speaks → **no "who speaks" problem**, no room
teardown, no orchestrator LLM.

### Full — the deck (the "playlist / Twitter-Space" view)

A stack of session cards. Each card = a session/agent with: name, colored avatar,
status pill (Speaking / Working 60% / Idle / Blocked·needs you), a mini waveform,
and per-card controls: **mic mute/unmute**, **focus (take the mic)**, **tag**, ⋯.

- Exactly one card is **ON AIR** (amber ring) — it holds the mic.
- Others are muted/background — still running, buffered, surfacing notifications.
- Bottom: a shared composer — "Message focused · @tag others" + mic.
- Focus swap = mute current, unmute target, inject catch-up. No disconnect.

Manage it like a call: mute the ones you don't want, tag the ones you do, tune in
to one at a time; kill / check / get-back-results per agent.

---

## 5. What we ALREADY have (the easy wins)

This is why the MVP is cheap — most primitives exist:

| Need | Existing component |
|---|---|
| Session registry + switching | Session list + `handleResumeSession` / `session_switched` / `session_switch_success` in `VoiceRoom.tsx`; `listSessions` / `sessionExists` / `getSessionWorkspace` in agent `config.ts` |
| Agent definitions + CRUD UI | `NAMED_AGENTS` in `claude-llm.ts`; `AgentsPopover` (create/edit/delete/restore named agents) in `VoiceRoom.tsx` |
| Dispatch / tag transport | Data channel: `sendToAgent` / `sendToFrontend` (typed message envelopes already used for resume, skills, permissions, artifacts) |
| Mute/unmute catch-up prompt | Interruption / context-preservation **prompt injection** pattern already used on interrupt |
| Background-agent notifications | The compaction "teaching" banner + toast pattern (lifecycle-event surfacing, buffered, dismissible) is the exact shape |
| Taggable / findable / shareable sessions | The **session-sharing** feature (copy-model sharing) already makes sessions addressable entities |
| Per-agent isolation | Per-user Fly sandbox + per-session workspace (`getSessionWorkspace`); Claude subagents each get their own context window |
| Background work that reports back | **LiveKit async tools** (v1.6.0+): a long tool hands control back immediately, keeps running, and surfaces its result "when idle" — native to our transport |
| Durable file/state across resume | Supabase `osborn-storage` + the new `/api/session-files` rehydration + favorites (pinned, survive churn) |

Genuinely NEW work is small: the **mic-lock router** (deterministic), a
**"dispatch to another session in background"** message + handler, and the
**notification queue** that waits for a natural turn boundary.

---

## 6. Phased plan

**P1 — tag & continue (MVP).**
- Sessions become addressable (name + tag) — extend the existing session list +
  named-agents UI.
- Add a voice/UI gesture "tell <project> to <task>" → new data-channel message
  `dispatch_background { targetSessionId, instruction }`.
- Agent runs it against that session's workspace as a **background task**
  (async tool), no mic, no disconnect.
- On lifecycle event → `background_update { sessionId, stage, summary }` →
  notification surfaced at the next pause (reuse the banner/toast pattern).
- **No mic-lock arbitration needed yet** (only one live agent).

**P2 — the deck (full).**
- Session registry of running sessions + per-session **mute/focus**.
- **Mic-lock** state machine in the router; TTS gated to the mic-holder.
- Catch-up **prompt injection** on unfocus→focus.
- Per-agent notifications + kill/cancel controls.
- The card-deck UI.

**Later (optional).**
- LLM orchestrator for smart auto-routing ("which project owns this bug?").
- Anthropic **Managed Agents API** if we want a fully hosted, thread-isolated
  multi-agent runtime (same vendor, no third-party framework).

**Decision tell for how far to go:** do we mostly need to *fire-and-forget* at
another project and keep going (→ P1 is enough), or *actively converse* with two
projects in one sitting (→ P2)? Build P1, measure, then decide.

---

## 7. Open questions

- Do "projects" live as separate Claude **sessions/working-dirs inside one
  sandbox** (simplest — in-sandbox switching, no cross-sandbox bus) or as separate
  sandboxes (needs cross-sandbox messaging)? **Recommend in-sandbox sessions for
  P1/P2.**
- Notification cadence in voice — how aggressive before it's annoying? (Default:
  only done/blocked/needs-input, queued to a pause.)
- Do background agents get to *speak* a one-liner in a quiet gap (LiveKit
  `ctx.with_filler()`), or strictly text/notification until focused?
- How much of a background agent's transcript do we load on focus (summary vs.
  tail vs. full)?

---

## 8. Recommendation

Stay on **LiveKit + Claude Agent SDK** (don't add CrewAI/AutoGen/LangGraph —
Python-first or graph-CRUD-awkward, and a second runtime). Build **P1 tag &
continue** first — it directly solves "notice a bug on Osborn while working on
Audos → tell it → keep going," reuses ~everything we have, and de-risks whether we
even need the full deck before paying for the mic-lock machinery.

> Note: the Claude Agent SDK subagents (`agents` param in `query()`) are the
> **recommended programmatic path for SDK apps** — not CLI-only. We already use
> this (`NAMED_AGENTS`). That was the main misconception blocking this idea.
