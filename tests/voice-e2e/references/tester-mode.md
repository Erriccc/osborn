# Tester mode — a delegated tester that reports as it goes

Three ways to use the engine:

1. **Goal loop** — "here is what I want, figure it out". You hear back at the end.
2. **Direct driving** — you send one action, look, send the next. Precise, but
   slow, and it holds your whole attention.
3. **Tester mode (this file)** — a background agent owns a goal and a step
   budget, writes every step to a ledger the moment it happens, reads an inbox
   before every step, and keeps going. You stay free; nothing is lost if it
   gets stuck; the problems it trips over on the way are logged as findings
   in their own right.

Use tester mode to test a PR, a deploy, or a user journey whenever the run is
more than three or four actions.

## The three files (one folder per run)

- `ledger.md` — the tester APPENDS one entry after EVERY step, before the next.
- `inbox.md` — the supervisor writes instructions here. Each message starts
  with a line `## msg <n>`. The tester reads it before every step, as its own
  command (never chained to the next action), and handles only messages whose
  number is greater than the last one it acknowledged.
- `media/` — screenshots the tester pulled (`step-<n>.jpg`).

## Ledger entry format

```
## <n> <HH:MM:SS UTC> <TYPE>     TYPE: STEP | FINDING | STUCK | STEER-ACK | GOAL-CHECK
- did: what you asked the browser to do
- observed: ground truth — effect.changed, urlAfter, what /eval showed
- evidence: clipUrl and/or media/step-<n>.jpg
- (FINDING) severity P0–P3, one-line repro, does it block the goal
- (STUCK) what you need; the fallback you are taking; then KEEP GOING
- (STEER-ACK) "msg <n>": the instruction, and your plan to return to the goal
- next: the next step and how it serves the goal
```

Every 4 steps write a GOAL-CHECK: which goal items are done, which remain,
actions used out of the budget.

## Rules for the tester

- **One entry per step, written before the next step.** Never batch.
- **Verify, don't trust.** `ok:true` means the brain did not throw. Read
  `effect.changed`, `effect.noop` and `warning` on every `/act`; confirm with
  `/eval` (title, URL, visible text). `changed:false` means it did not happen.
- **Use `{"async":true}` on `/act` and `/say`**, then poll `resultUrl` until
  `"done":true`. Never blind-retry an action that timed out.
- **Check `/logs` when something looks off.** Console and network errors are
  findings.
- **A side discovery is a FINDING, not a detour.** Log it, then continue.
- **Stuck is an entry, not a stop.** Say what you need, take the best fallback,
  keep going. The supervisor may answer in the inbox.
- **`409 paused_by_supervisor`** — your tab was borrowed. Retry the same
  request every ~5s; when it succeeds, re-check the page before continuing.
- **Stay in your lane.** Your own `x-driver-id`, your own tab; never `/end`,
  `/brain`, or another driver's tab. Close your tab when done.
- **No credentials** unless the brief gives you a test account for the run.

## Brief template (give this to the tester agent)

```
You are a TESTER. Report incrementally into <dir>/ledger.md; read
<dir>/inbox.md before every step; screenshots in <dir>/media/.
Browser API: <control base URL>, header x-driver-id: <name>.
Read references/tester-mode.md for the ledger format and rules.
GOAL: <what must be true — e.g. "PR #N: a guest can do X, Y, Z">
Budget: <N> browser actions, about <M> minutes.
Final reply: status per goal item, findings with severity, STUCK moments.
```

## Supervisor side

- Read `ledger.md` any time; it is always current.
- Steer by appending `## msg <n>` plus the instruction to `inbox.md`.
- Borrow the tester's tab with `/tab {"op":"takeover","i":N}`, drive it, and
  return it with `{"op":"handback","i":N}`; the tester resumes by itself.
- Subscribe to `GET /events` for a push feed of tasks, navigations and
  takeovers instead of polling.
- Turn FINDING entries into issues with the ledger lines and clip links as
  evidence; fix them on the PR under test or a follow-up.
