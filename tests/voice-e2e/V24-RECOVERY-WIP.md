# v24 "per-tab capture" — RECOVERY CHECKPOINT (⚠️ DOES NOT COMPILE)

**Branch:** `wip/v24-per-tab-capture` off `98eec8b`. **Do not merge to main as-is.**

This branch is a *forensic recovery* of an in-progress refactor that was destroyed when the
iCloud working copy at `~/Desktop/Developer/osborn` corrupted mid-session (Aug 8 2026, the
second APFS stuck-flush data-loss event). It is committed **only** so the recovered fragments
live on GitHub instead of a volatile chat transcript. It intentionally references symbols that
**do not exist** — see "What's still missing" — so `tsc`/`tsx` will fail. That is expected.

## Goal of v24
Let multiple concurrent "drivers" (parallel agents) each `/act`, `/say`, `/eval`, `/shot` on
**their own browser tab** at the same time, instead of all contending for one global
`withLock` + one global `active` tab + one global screencast. The only truly-shared resource
is the computer-use "brain" model (one inference at a time) → gated by `withBrainLock`;
everything else becomes per-tab.

## What IS recovered here (applied to session-engine.ts — 5 of 6 tail edits)
These came verbatim from the session transcript
(`9b38052c-…jsonl`) and anchored cleanly to `98eec8b`:
1. `noteVisit(page)` — takes an explicit `page` instead of reading global `active`.
2. `/act`, `/say`, `/hear`, `/shot` handlers — rewired to: `resolveDriverTab(driver)` →
   `guardOwnership(driver, page)` → `withTabLock(page, …)` → `live?.spotlight(page)`;
   brain call wrapped in `withBrainLock(() => brain(page, …))`; `reqClip/reqShot/stampTask`
   now take `page` first. `/hear` reads from the **room tab** `context.pages()[0]` (that's
   where the agent's audio is captured), not the driver's tab.
3. `/eval` — same per-tab treatment (`withTabLock` + `spotlight` + `page.evaluate` + `touchTab(page)`).
4. Global replace: `await live?.retarget(active).catch(()=>{})` → `live?.spotlight(active)` (non-blocking).
5. Shutdown `gracefulEnd`: `brain(context.pages()[0] ?? active, 'Click the Disconnect…')`.

## The 6th edit — COULD NOT be applied (its layer is lost)
The transcript's `watchPage` edit anchored on `void live?.track(p)`, which **does not exist in
`98eec8b`** — proof that an *earlier* session had already added a v24 infra layer to the Desktop
disk that was never committed and is not in any transcript. That earlier layer is **gone**.
The intended 6th edit was, right after the (missing) `void live?.track(p)` line in `watchPage`:
```ts
    p.on('close', () => { void live?.untrack(p) })  // stop its capture on close (any path)
```

## What's still MISSING (never in transcript / lost with the Desktop copy) — must be REBUILT
The applied edits call these undefined symbols. Completing v24 means implementing them:

- **`resolveDriverTab(driver): Page`** — the driver's own tab (base has `driverActive: Map<driver,Page>`
  and `focusDriverTab`; likely `driverActive.get(driver) ?? active`).
- **`withTabLock(page, fn)`** — per-`Page` mutex (replaces global `withLock`). A `Map<Page, Promise>`
  chain so two different tabs run concurrently but one tab serializes.
- **`withBrainLock(fn)`** — a single global promise chain serializing the shared brain model.
- **`guardOwnership(driver, page)`** — base is 1-arg `guardOwnership(driver)`; must be re-signed to
  take the explicit page.
- **`brain(page, instruction)`** — base is 1-arg `brain(i)` that uses global `active`; parametrize on page.
- **`reqClip(page, n, label, secs)`, `reqShot(page, n, label)`, `stampTask(page, n, …)`** — base
  signatures don't take a page; must pull from the *per-tab* ring buffer / screenshot that page.
- **`lib/live-stream.ts` per-tab capture API** — the big one, entirely unwritten in `98eec8b`
  (base has ONE global CDP screencast + one ring + `retarget`). Need `track(page)` / `untrack(page)`
  (per-tab CDP screencast + per-tab ring buffer) and `spotlight(page)` (non-blocking: pick which
  tab's frames feed the MJPEG stream + `latestFrame`), and `clip(page, …)` to cut from that tab's ring.

## ⚠️ Unresolved design blocker — DISPLAY (cloud) mode can't do per-tab
The cloud tester runs in **DISPLAY mode** (`OSBORN_DISPLAY`, `x11grab` of the whole Xvfb screen).
There is physically **one** framebuffer — you can only film the front tab. Per-tab isolated capture
works **only** in local CDP mode. So before completing v24, decide the cloud story, e.g.:
- keep concurrent *actions* per tab but accept a single shared "spotlight" video in cloud mode, or
- run one headful Chrome per driver, or
- fall back to per-tab CDP screencast even under Xvfb (lose the true-window fidelity).

## To finish (later, as a deliberate task)
1. Re-clone is unnecessary — work here. Resolve the DISPLAY-mode design above.
2. Implement the missing primitives + `live-stream.ts` per-tab API.
3. `tsx` boot locally (`OSBORN_ENTRY=none`), smoke-test single-driver clips, then **two drivers
   acting on separate tabs concurrently** (fire both `/act`s without awaiting; verify parallel
   execution, per-tab clips, no cross-tab frame bleed).
4. Only then bump the skill and merge.
