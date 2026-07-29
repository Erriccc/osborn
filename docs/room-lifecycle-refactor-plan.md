All evidence is in hand. Here is the complete analysis.

---

# Root Cause: `Room.disconnect()` destroys the instance — rtc-node `Room` is single-use

## The smoking gun (rtc-node v0.13.29)

`/Users/newupgrade/Desktop/Developer/osborn/agent/node_modules/@livekit/rtc-node/dist/room.js`, `disconnect()` lines 566–585:

```js
async disconnect() {
    if (!this.isConnected) return;
    const res = FfiClient.instance.request({ message: { case: "disconnect", ... } });
    await FfiClient.instance.waitFor((ev) => {          // ← line 579: NO abort signal, NO timeout
      return ev.message.case == "disconnect" && ev.message.value.asyncId == res.asyncId;
    });
    this.cleanupOnDisconnect(DisconnectReason.CLIENT_INITIATED);
    FfiClient.instance.removeListener(FfiClientEvent.FfiEvent, this.onFfiEvent);  // ← line 583
    this.removeAllListeners();                          // ← line 584: WIPES EVERY room.on() HANDLER
}
```

**Line 584 is the entire bug.** `Room extends EventEmitter` (room.js:12, 35 — plain Node `events` module). `disconnect()` ends with `this.removeAllListeners()`, which removes every application listener ever registered with `room.on(...)`. Your handlers are registered exactly once, in `main()` at index.ts lines 3048, 3107, 3113, 3118, 3123, 3128, 3133, **3139 (Disconnected)**, **4084 (ParticipantConnected)**, 4086 (ParticipantDisconnected), **4143 (DataReceived)** — and never re-registered. After the first successful `room.disconnect()` (alone-timer at 1330, watchdog at 1411, or leaveRoomHook at 4971), the Room instance is a functioning FFI client attached to **zero listeners**. `connect()` (room.js:500–561) re-subscribes the *internal* FFI pump (`FfiClient.instance.on(FfiClientEvent.FfiEvent, this.onFfiEvent)`, line 509) but does nothing to restore app listeners — the SDK's contract, expressed in code, is one Room = one connection lifetime.

This explains the production pattern with no residue:
- **Fresh process → always works**: listeners were wired once and never wiped.
- **Any leave/rejoin cycle → deaf agent**: `processFfiEvent` receives `participantConnected` from FFI and calls `this.emit("participantConnected", participant)` (room.js:97–100) — into an empty listener list. `ParticipantConnected` "never fires" agent-side; so does `DataReceived` (data channel dead) and `Disconnected` (next-cycle wedge).

## Q2 — Why synthetic `room.emit()` did nothing

The 0.9.81 comment at index.ts:3208–3213 ("the event dispatch is internal, so direct invocation is the only reliable path") is **incorrect**. rtc-node's Room uses a completely ordinary Node `EventEmitter`; `room.emit(RoomEvent.ParticipantConnected, p)` dispatches to registered listeners exactly like any emitter. It "had zero effect" because by that point `disconnect()` had already run `removeAllListeners()` — `emit()` returned `false` (no listeners) every time. The v0.9.81 direct-invocation of `participantConnectedHandler` works only because it bypasses the (empty) listener list. That comment should be corrected in the refactor so nobody re-learns the wrong lesson.

## Why `remoteParticipants` stayed EMPTY (v0.9.78–0.9.80), then showed 1 later

Two rtc-node defects combine here:

1. **`disconnect()`'s `waitFor` has no timeout/signal** (room.js:579; `ffi_client.js:54–79` — without `options.signal` the listener waits forever). If the FFI layer never delivers the `disconnect` callback (zombie WS at the Rust layer — your v0.9.73–75 symptom (a)), the promise hangs, `cleanupOnDisconnect` never runs, `Disconnected` never fires → the exact "disconnect hung, livekitState stuck 'connected'" wedge.

2. **The hung disconnect resumes AFTER a reconnect and tears down the new session's plumbing.** `connect()` resets `this.hasCleanedUp = false` and installs a fresh `disconnectController` (room.js:528–529). So the sequence: watchdog forces `status='idle'` (index.ts:1406) while `room.disconnect()` is still pending → `/connect-room` → `connect()` succeeds (re-adds `onFfiEvent`, resets `hasCleanedUp`) → the *old* disconnect's `waitFor` finally resolves → it runs `cleanupOnDisconnect()` **again** (guard was reset!) — aborting the new `disconnectController`, marking state `CONN_DISCONNECTED` — then `FfiClient.instance.removeListener(FfiEvent, this.onFfiEvent)` (room.js:583) **unhooks the new connection's FFI event pump**. From that moment no FFI event reaches the Room at all: `remoteParticipants` stays empty (it's only populated by `processFfiEvent`, room.js:98–99) even though the browser is verifiably in the room. The later `/leave-room` observing `size===1` is consistent with a subsequent reconnect: `connect()` populates participants present *at join time* directly from the connect callback (room.js:535–541) without needing events.

3. Bonus stale-state hazards on reuse: `cleanupOnDisconnect` (room.js:624–645) clears stream controllers but **never clears `remoteParticipants`**, and `createRemoteParticipant` **throws** `"Participant already exists"` on a duplicate identity (room.js:719–722) — thrown inside `onFfiEvent`, which has no `catch` (room.js:58–73, only `finally { unlock() }`) → unhandled rejection and a silently dropped `participantConnected`. `byteStreamHandlers`/`textStreamHandlers` also survive disconnect (source of your "byte stream handler already set" crash workaround at index.ts:3222–3227).

## Q1 answered — what actually breaks on reuse

| # | Mechanism | Evidence |
|---|-----------|----------|
| 1 | All `room.on()` app listeners destroyed on disconnect | room.js:584 `removeAllListeners()` |
| 2 | Hung disconnect (no timeout) → wedge; late resolution strips the new connection's FFI listener | room.js:579 (no signal), 583, 528–529 (`hasCleanedUp` reset) |
| 3 | Stale `remoteParticipants` never cleared → duplicate-identity throws, uncaught | room.js:624–645, 719–722, 58–73 |
| 4 | Old `ffiHandle` never disposed on disconnect (FFI leak per cycle) | room.js:566–585 (no `this.ffiHandle.dispose()`) |
| 5 | Bonus: `RoomEvent.Connected` is **never emitted** by rtc-node — grep of dist finds zero `emit("connected")`; only `connectionStateChanged` (room.js:619). Your handler at index.ts:3048–3091 (SID log, SDK-version snapshot, `armAloneTimer()` on connect) is dead code even on first boot | room.js:614–620, 828–863 |

## Q3 — Audit of the four compensation layers

- **Alone-timer** (index.ts:1312–1333, armed at 4138): legitimately models "user gone → tear down." **Keep**, retargeted to destroy the room session. Note its arm-on-connect path (3090) never ran (dead `Connected` handler) — must be re-homed to post-connect code.
- **Zombie-watchdog** (1377–1421): exists because "events stop firing after reuse" — which is layer-1 damage (Disconnected handler itself gets wiped, so even real disconnects went unobserved). Under fresh-Room-per-session it loses its reason to exist. **Delete** (the idle-exit timer at 1350–1375 is orthogonal billing protection — keep).
- **Adopt-on-join sweep** in `connectRoomHook` (4941–4950): covers a *real, permanent* race — `participantConnected` FFI events only fire for joins after the agent; joiners-before-agent arrive via the connect callback (room.js:535–541) with no event. **Keep**, but move inside room-session creation so it runs exactly once per connect.
- **Adopt-poll** (1423–1447): pure compensation for wiped listeners. **Delete.**
- Also compensation-adjacent: the manual `livekitState.status='idle'` write in the watchdog (1406) and the "arm idle-exit in case Disconnected is swallowed" duplications (1416, 4970) — all exist because `Disconnected` could no longer be trusted. They collapse once the event stream is trustworthy.

## Q4 — Refactor plan: fresh Room per user session, temporary room names

**Design**: agent boots room-less. `POST /connect-room` synchronously (awaited) creates a unique room name, builds a **new** `Room`, wires all handlers, mints a fresh JWT, connects, sweeps pre-existing participants, and **returns `{ roomName }` in the response** — the frontend mints its token from that value, eliminating the `/room-code` fetch race entirely. User exit (leave/alone-timer/last disconnect) destroys the room session; the Room object is discarded, never reused. A hung `disconnect()` becomes harmless: race it against a 10s timeout and abandon the instance.

Migration order (one session):

1. **Extract `wireRoomHandlers(room: Room)`** — pure move of every `room.on(...)` block: 3048–3091 (fold its body into post-connect code instead — the event never fires), 3107–3137 (observability), 3139–3206 (Disconnected), 4084 (ParticipantConnected → `participantConnectedHandler`), 4086–4141 (ParticipantDisconnected), 4143+ (DataReceived). Fix the wrong comment at 3208–3213.
2. **Make the room reference mutable**: replace `const room = new Room()` (1295) with `let activeRoom: Room | null`. Update every captured `room.` reference outside handlers: armAloneTimer (1324, 1327, 1330), idle-exit (1359, 1365), leaveRoomHook (4964, 4971), connectRoomHook (4947), `localParticipant` assignment (3086/4896), and any `sendToFrontend`/publish sites that touch `room.localParticipant`.
3. **Extract `mintAgentToken(roomName)`** from 1274–1288 (fresh JWT per room session).
4. **`createRoomSession(roomName)`**: `new Room()` → `setMaxListeners(50)` → `wireRoomHandlers` → `mintAgentToken` → `connect()` with a *bounded* retry (3 attempts; the caller is now awaiting) → post-connect block (SID log via `getSid()`, version snapshot, `localParticipant`, `armAloneTimer()` — the re-homed dead-handler body) → adopt-sweep of `room.remoteParticipants` → `livekitState.status='connected'`.
5. **`destroyRoomSession(reason)`**: idempotency guard → `Promise.race([room.disconnect(), 10s timeout])` → on timeout just log and drop the instance (nothing reuses it; optionally `(room as any).ffiHandle?.dispose()`) → `activeRoom = null`, `status='idle'`, `armIdleExitTimer(reason)`.
6. **Rework `/connect-room`** (endpoint 366–373 + hook 4933–4951): generate `osborn-${roomCode}-${Date.now().toString(36)}` (stable prefix preserved for log forensics), **await** creation, respond `{ ok, roomName }`. Idempotency: active session with a user present → return its roomName; active but empty → destroy + fresh.
7. **Rework Disconnected handler** (3139–3206): intentional → bookkeeping only (Room already dead); involuntary mid-session → `createRoomSession(sameRoomName)` — a **new** instance rejoining the same LiveKit room, never `connect()` on the old one (today's ghost-agent auto-rejoin at 3203 produces a deaf agent every time it "succeeds").
8. **Retarget leave paths**: leaveRoomHook (4956–4972) and alone-timer body (1325–1332) call `destroyRoomSession`.
9. **Delete**: adopt-poll (1423–1447), zombie-watchdog (1377–1421), boot-time eager `connectWithRetry()` (5008–5013 — boot idle, arm idle-exit), `connectWithRetry` itself (4884–4928, superseded), room-code persistence machinery (1232–1263) once frontend migrates; keep `/room-code` (354–358) returning the last-created name during rollout.
10. **Frontend**: `ChatSessionProvider.tsx:294–342` — call connect-room *first*, mint token from the returned `roomName`; `/api/sandbox/route.ts` `connect-room` action (296–310) forwards `roomName` through; `room-code` action (243+) becomes legacy fallback.

**Verdict**: one SDK line — `room.js:584 this.removeAllListeners()` — explains symptoms (b) and (c) outright; the signal-less `waitFor` at room.js:579 plus the `hasCleanedUp` reset at room.js:528–529 explain (a) and the empty-`remoteParticipants` paradox. Every compensation layer except the alone-timer and the adopt-on-join sweep is treating symptoms of Room reuse; the fresh-Room-per-session architecture removes the disease.