# Sprites / Fly.io Debugging Handoff

A briefing for an agent picking up the Sprites cloud-sandbox debugging work. Self-contained: read this and you can manipulate, probe, recover, and reproduce-then-fix without context from prior conversations.

If you only read one thing first: **`frontend/src/lib/sprites.ts`** is the primary entrypoint. Everything sprite-related goes through it. The diagnostic scripts in `.claude/sprite-backups/` are throwaway helpers for one-off ops; the durable behaviors live in `sprites.ts`.

---

## 1. Territory

```
                                 LiveKit Cloud
                                       │ (WebRTC audio + data channel)
   Browser ──HTTPS──┐                  │
   (chat page)      │                  │
                    │                  │
            Railway ─── /api/sandbox ──┼── Sprites HTTPS API
        (Next.js frontend)             │   (api.sprites.dev)
                                       │
                                       └── Sprite container (Fly.io)
                                              │
                                              ├── osborn agent (Node 22)
                                              │   ├── /health, /events (SSE)
                                              │   ├── /room-code, /sessions
                                              │   └── LiveKit WebSocket
                                              ├── /home/sprite/.claude/...
                                              │   (overlay filesystem)
                                              └── /home/sprite/workspace
                                                  (user's working dir)
```

Three independent services play roles:

- **Sprites (Fly.io)** — manages sprite containers. Provides HTTPS API at `api.sprites.dev` for create / list / start / stop / delete and a per-sprite `*-x745.sprites.app` proxy URL for app traffic.
- **Railway** — runs the Next.js frontend. Calls Sprites API on behalf of users via `/api/sandbox` server routes. **Symptom-amplifier**: Sprites' API gateway has occasionally rate-limited or routed Railway's egress IP differently from local IPs — this is a real, documented pattern in our incident history.
- **LiveKit Cloud** — runs the WebRTC media servers. Both browser and the agent inside the sprite connect to it. The agent inside the sprite is its own peer; if its WebSocket dies, LiveKit Cloud evicts it and the room becomes a one-participant room.

The sprite filesystem is **layered**:
- A **CRIU snapshot** captures both process state and the writable overlay at hibernation time.
- The **persistent disk** sits underneath. fs API reads/writes touch it.
- The **container's running view** is derived from CRIU base + in-memory writes since restore. **The persistent disk and the running container's view can diverge** (most painfully after a checkpoint restore that rolled the overlay back).

This layering is the source of half our incidents tonight. Internalize it.

---

## 2. Auth + endpoints

### API token

`SPRITES_API_TOKEN` lives in `frontend/.env.local`. All Sprites API calls authenticate with `Authorization: Bearer <token>`. The token is shared across all sprites in your org.

Standard helper used by every script in `.claude/sprite-backups/`:

```js
import { readFileSync } from 'fs'
const envFile = readFileSync('/Users/newupgrade/Desktop/Developer/osborn/frontend/.env.local', 'utf8')
const TOKEN = envFile.split('\n').find((l) => l.startsWith('SPRITES_API_TOKEN='))
  .slice('SPRITES_API_TOKEN='.length).replace(/^['"]|['"]$/g, '').trim()
const H  = { Authorization: `Bearer ${TOKEN}` }
const HJ = { ...H, 'Content-Type': 'application/json' }
```

### Sprites HTTPS API surface

Base: `https://api.sprites.dev/v1`. All paths below are relative.

| Path | Method | Purpose |
|---|---|---|
| `/sprites` | GET | List all sprites in org |
| `/sprites` | POST | Create new sprite. Body: `{ name, source: { type: 'language', language: 'node' } }` |
| `/sprites/<name>` | GET | Sprite metadata. Status: `cold` / `warm` / `running`. Look at `last_running_at`, `last_warming_at` for timing |
| `/sprites/<name>` | PUT | Update url settings, e.g. `{ url: { auth: 'public' } }` |
| `/sprites/<name>` | DELETE | **Destructive, no soft-delete**. Returns 204. Overlay + persistent disk + ALL checkpoints are unrecoverable after this |
| `/sprites/<name>/services` | GET | List services on a sprite |
| `/sprites/<name>/services/<svc>` | GET | Service config (returns `args` containing the bootstrap script) |
| `/sprites/<name>/services/<svc>` | PUT | Register a service. Body: `{ cmd, args, needs, http_port }`. **NDJSON streaming response** — read until `complete`/`error` event. Idempotent: PUT with same cmd returns 200 + `"already running with that command, use POST .../restart"` |
| `/sprites/<name>/services/<svc>` | DELETE | Tear down the service definition. Returns 204 |
| `/sprites/<name>/services/<svc>/stop` | POST | Body: `{ timeout: <secs> }`. Sends TERM. Body is also NDJSON streaming |
| `/sprites/<name>/services/<svc>/start` | POST | Start a stopped service |
| `/sprites/<name>/services/<svc>/restart` | POST | stop + start. Cleaner than calling each separately, per Sprites docs |
| `/sprites/<name>/services/<svc>/logs?lines=N&duration=S` | GET | Service stdout/stderr. NDJSON, each line is `{ type: 'stdout' \| 'stderr', data, timestamp }` |
| `/sprites/<name>/logs?limit=N` | GET | **Sprite platform** logs (DNS, channel events, requests). JSON array. Use this to see what Sprites itself is doing during weird states |
| `/sprites/<name>/checkpoints` | GET | List checkpoints. Each has `{ id, create_time, is_auto }`. `id: 'Current'` is the live overlay state |
| `/sprites/<name>/checkpoints/<id>/restore` | POST | **Destructive**: replaces overlay with snapshot. Wipes everything since. Streams NDJSON until complete |
| `/sprites/<name>/checkpoint` | POST | Create a checkpoint. Note: **singular**, not plural. Body: `{ id: <name> }` but **the platform ignores the id and assigns its own (e.g. `v21`)**. Streams NDJSON |
| `/sprites/<name>/fs/list?path=<p>` | GET | List dir on persistent disk. Returns `{ entries: [{ name, type: 'file'\|'directory', size? }] }` |
| `/sprites/<name>/fs/read?path=<p>[&end=N]` | GET | Read file from persistent disk. Returns raw bytes. `end` truncates to first N bytes |
| `/sprites/<name>/fs/write?path=<p>` | PUT | **PUT only — POST returns 405.** Body: raw bytes. Returns `{ path, size, mode }`. Writes to persistent disk |
| `/sprites/<name>/exec` | POST | **DOCUMENTED BROKEN for our account** — see §4. Body: `{ cmd, args, env, timeout }`. Binary-frame response: `[stream_id u8][payload]`. `0x01`=stdout, `0x02`=stderr, `0x03`=exit (payload[0]=code) |

### Sprite proxy URL surface (per-sprite app endpoints)

Every sprite has a public URL at `https://<name>-x745.sprites.app/`. This routes to whichever service has `http_port` configured (port 8080 by default). For osborn sprites, this hits the agent's HTTP server.

| Path | Purpose |
|---|---|
| `/health` | `{ status: 'ok', workingDir }`. Hitting this **wakes the sprite from warm/cold** (Sprites' edge proxy thaws it) |
| `/sessions[?limit=N]` | Lists Claude session JSONLs visible to the agent (uses `listAllClaudeSessions()` over `~/.claude/projects/**`). Returns `{ sessions: [...], total }` |
| `/room-code` | Returns `{ roomCode }` — the LiveKit room the agent created on boot |
| `/events` | **Long-lived SSE keepalive**. Opening this prevents the sprite from hibernating. Frontend opens it on chat page mount |
| `/restart` | Graceful agent process restart (process manager auto-restarts) |
| `/meeting-output` | HTML page Recall.ai bot loads as its video tile (post-0.8.35 fix) |
| `/webhook/recall` | Recall.ai real-time transcript webhook |

### Agent's local HTTP server

The agent inside the sprite binds to `OSBORN_API_PORT` (default 8741 for local dev, 8080 for cloud — Sprites only exposes 8080 through its proxy). The proxy translates so the public URL hits whatever port is configured as `http_port` in the service definition.

---

## 3. Code map

### Primary file: `frontend/src/lib/sprites.ts`

The complete sprite lifecycle in one file. ~1600 lines. Key exports:

- **`createSandbox(userId)`** — POST /sprites + PUT /services/osborn + waitForHealth + checkpoint. Uses `generateUniqueSpriteName(userId)` for the name.
- **`generateUniqueSpriteName(userId)`** — `osborn-<slug>-<base36 timestamp>`. Each call generates a fresh name. Was added because Sprites' API gateway can develop "stuck routing" entries per name.
- **`spriteNameFromUserId(userId)`** — legacy deterministic name. Still used as `findUserSandbox` fallback when Supabase has no record.
- **`findUserSandbox(userId, knownSandboxId?)`** — GET /sprites/<name>. **Always pass the explicit Supabase ID** — that's the source of truth post-`generateUniqueSpriteName`. Falls back to deterministic name only for legacy users.
- **`startSandbox(sandboxId, userId)`** — wakes a warm/cold sprite. Three-step:
  1. If status=running and `/health` is 200 → done.
  2. **`bootstrapHasMarker` check** — defensive `serviceCheckSucceeded` flag. We **never** restore on uncertainty (transient API failure ≠ "service is missing"). Restore only fires when we positively know there's no marker bootstrap.
  3. **Warm-wake LiveKit kick**: when sprite is `warm`/`cold` AND has marker bootstrap, `restartService(sandboxId)`. Restores fresh agent process with fresh LiveKit WebSocket. Overlay preserved (no re-auth, no lost JSONLs).
- **`updateOsborn(sandboxId, userId, targetVersion?)`** — STOP + DELETE + PUT cycle to update the agent. Resolves `latest` from npm registry if `targetVersion` not passed. Per-sprite `Map`-based in-flight lock so concurrent calls de-dup.
- **`registerService(spriteName, serviceName, httpPort, envVars, targetVersion?)`** — PUT /services/<name>. Has 10× retry loop with 5s backoff for transient 503s during sprite warm-up window.
- **`buildOsbornBootstrap(envVars, httpPort, targetVersion)`** — generates the bash bootstrap script. Marker logic: writes `/home/sprite/.osborn-installed-version` after install, skips install when marker matches WANT. Boot-time inventory log emits per-project JSONL counts to stdout (visible via `/services/<name>/logs`).
- **`restoreCheckpoint(spriteName, checkpointId)`** — POST /checkpoints/<id>/restore. **Destructive**: wipes overlay. Pre-restore safety snapshot (`pre-restore-vN-<ts>`) is auto-created by Sprites — accumulates in checkpoint list, filtered out as restore candidates.
- **`readSpriteFile(spriteName, path)`** — convenience wrapper over GET /fs/read with timeout + 404 = null.
- **`listSpriteDir(spriteName, path)`** — wrapper over GET /fs/list. Returns null on error.
- **`checkSessionLayerConsistency(spriteName, containerSessionCount)`** — compares fs-API-visible JSONL count against agent's `/sessions` count. Surfaces the persistent-disk-vs-overlay divergence as a dashboard banner. Read-only — never triggers recovery.
- **`readInstalledOsbornVersion(spriteName)`** — reads marker file first, falls back to package.json across nvm versions.
- **`resolveOsbornLatest()`** — fetches `https://registry.npmjs.org/osborn/latest`. No sprite involvement; fast.
- **`waitForHealth(previewUrl, attempts)`** — polls /health every 2s.
- **`waitForServiceReady(spriteName)`** — polls until sprite proxy accepts service registration requests (post-create race).
- **`checkOsbornHealth(previewUrl)`** — single /health probe with short timeout.

### Server route: `frontend/src/app/api/sandbox/route.ts`

Next.js API route. Auth via Supabase. All callers read `instance.sandbox_id` from Supabase via the local `getKnownSandboxId()` helper before calling `findUserSandbox(user.id, await getKnownSandboxId())`.

Actions (POST body `{ action: '...' }`):
- `create` — `createSandbox(user.id)`. Persists `sandbox_id`, `sandbox_url` to Supabase `instances` table.
- `start` — `startSandbox(sb.id, user.id)`. Returns `{ previewUrl }`.
- `stop` — `stopSandbox(sb.id)`.
- `keepalive` — periodic ping from chat page.
- `restart-service` — `restartService(sb.id)`. Used by dashboard's Restart button.
- `update-osborn` — `updateOsborn(sb.id, user.id)`. Used by Update Osborn button.
- `room-code` — proxies sprite's `/room-code` after ensuring it's awake.
- `check-version` — `[resolveOsbornLatest, readInstalledOsbornVersion]` parallel.
- `consistency-check` — `checkSessionLayerConsistency(sb.id, containerCount)`.
- `persist-auth` — write OAuth token to host-persistent layer.
- `fetch-log` / `save-log` — pull osborn log + upload to Supabase Storage on disconnect.

GET / DELETE handlers also exist. DELETE is destructive — protected by 2-click confirm in UI.

### Agent: `agent/src/index.ts`

The osborn process running inside the sprite. Wires up the local HTTP server (`startApiServer`), LiveKit room, voice modes, and OAuth flow. Read this when debugging anything that happens after the sprite boots successfully.

---

## 4. Critical gotchas (read these first)

### `/exec` is no-op for our account
Confirmed empirically tonight: `POST /sprites/<name>/exec` returns exit=0 with **no stdout** and **no actual side-effects** even when sprite is `running` and `/health` responds in ms. Verified by writing a sentinel file then checking via `fs/read` → 404. Documented in `sprites.ts:1265` ("Sprites exec API silently no-ops"). **Don't use exec for anything you need to actually run** — use service registration instead.

### `fs/write` ≠ container view
Writes via `PUT /fs/write` land on the persistent disk. The **running container does NOT see them at the same path** because its overlay state is in memory. `fs/read` to the same path will succeed and return the bytes you wrote — but the agent's `readdirSync` won't include the file. To make fs/write writes visible to the container, **stop and resume the sprite** (or restart its service) so it re-reads the overlay from disk on next boot. We confirmed this end-to-end tonight by restoring two JSONLs to a stopped sprite via fs/write, then the user resumed and `/sessions` returned all three.

### `fs/write` is PUT only
`POST /fs/write` returns 405. Use `PUT /fs/write?path=<encoded>` with raw bytes body and `Content-Type: application/octet-stream`. Returns `{ path, size, mode }`.

### Gateway "stuck routing" per sprite name
Sprites' upstream API gateway has been observed to keep returning 503 on `PUT /services/<name>/services/osborn` for a particular sprite name from a particular source IP, even after delete + recreate under the same name. Identical PUTs from different IPs work fine on the same sprite. **The fix is `generateUniqueSpriteName`** — never reuse a name once it's been "burned." Sprite-side `/logs` shows zero incoming service-registration requests during the 503 window (proves it's upstream of the sprite).

### CRIU + LiveKit ghost agent
When a sprite hibernates, the agent's TCP/WebSocket sockets are snapshotted in their local state, but LiveKit Cloud has its own server-side connection state and times out independently. On wake, only HTTP requests cause the sprite to thaw — and even then, only the HTTP server thaws responsive; the agent's event loop stays effectively paused unless something drives it. Result: agent's in-memory state still says "Connected to room", but LiveKit has already evicted it. User joins the room → agent never sees them.

The fix is **service restart on warm-wake-with-marker** (current behavior in `startSandbox`). Long-term: agent-side LiveKit reconnect watchdog (not implemented).

### PUT idempotency
`PUT /services/osborn` with the same cmd as the running service returns 200 with body `"Service already running with that command, use POST .../restart if you want to restart it"`. Safe to retry. **To change the cmd you must STOP + DELETE + PUT**. This is how `updateOsborn` works.

### No soft-delete
DELETE is permanent. Verified by probing 6 different undelete endpoint shapes (`/undelete`, `/restore`, `/recover`, `/revive`, `/recreate`, plus filter params `?include_deleted=true`, `?status=deleted`, `?archived=true`) — all 404. Once a sprite is gone, overlay + persistent disk + all checkpoints are unrecoverable. UI uses 2-click confirm. **Never DELETE a sprite during debugging without explicit user approval.**

### Pre-restore checkpoints
Calling `POST /checkpoints/<id>/restore` causes Sprites to auto-create a `pre-restore-v<N>-<unix-ts>` snapshot of the current overlay BEFORE applying the restore. These accumulate forever and clutter the checkpoint list. `startSandbox` filters them out (`cp.id.startsWith('pre-restore-')`) because they often capture mid-corruption states. They're occasionally useful for manual recovery: each one is a snapshot of the sprite right before a destructive restore — sometimes the only snapshot of intact data.

### Process.cwd() in cloud is `/home/sprite/workspace`
NOT the package install dir. Files shipped with the npm package (e.g. `meeting-output.html`) must resolve via ESM `__dirname` (`fileURLToPath(import.meta.url) → dirname`), never `process.cwd()`. The `/meeting-output` handler in `agent/src/index.ts` tries 3 candidates: `dist/`, `../src/` (dev), `../` (tsx-from-src). Build script copies static files to `dist/`.

### Recall.ai fields
`recording_config.transcript` is a dict (omit if `transcription_options` is set — it's redundant). `output_media.camera.kind` (NOT `type`). Acceptable values: `'webpage'` or `'default'`. Recall returns 400 with explicit error messages for either; bot is never created. `RECALL_REGION` env (default `us-west-2`) selects the regional API endpoint — token belongs to one specific region; calls to the wrong region return 401 with a region-mismatch detail.

---

## 5. Diagnostic scripts (`.claude/sprite-backups/`)

All scripts are standalone Node ESM, run via:

```bash
/Users/newupgrade/.nvm/versions/node/v20.11.0/bin/node /Users/newupgrade/Desktop/Developer/osborn/.claude/sprite-backups/<script>.mjs
```

They read `SPRITES_API_TOKEN` from `frontend/.env.local`. Most are pinned to a specific sprite name at the top — change the `SPRITE` constant before re-running for a different sprite.

### Inventory + diagnostics (read-only, safe)

| Script | What it does | When to use |
|---|---|---|
| `read-sprite-docs.mjs` | Dumps `/.sprite/llm.txt`, `/.sprite/llm-dev.txt`, `/.sprite/docs/` listing | Onboarding, refresher on Sprites' built-in docs |
| `read-sprite-services-doc.mjs` | Dumps `/.sprite/docs/services.md`, `/.sprite/docs/agent-context.md` | Re-read service lifecycle semantics |
| `diagnose-sessions.mjs` | Probes `/sessions`, `fs/list` for projects dir, peeks at JSONL first lines | Investigating "agent doesn't see my session" reports |
| `probe-jsonl.mjs` | Streams full JSONLs from sprite, counts by type, simulates `getSessionPreview` | Verifying whether an old JSONL would pass our `messageCount >= 2` filter |
| `probe-fs-layers.mjs` | Probes `/`, `/.sprite`, `/persistent`, `/data`. Tests fs/write → fs/list. Tries to read 9045dc3b session via fs API | Investigating fs-API vs container-view divergence |
| `probe-checkpoints-mount.mjs` | Tries to `ls` `/.sprite/checkpoints/` and read marker files from each | Recovering data from old checkpoint without doing a full restore |
| `list-checkpoints.mjs` | Lists all checkpoints with `create_time` + `is_auto` | Picking a recovery target |
| `inspect-checkpoints.mjs` | Per-checkpoint metadata fetch | Comparing candidate restore targets |
| `proof-of-life.mjs` | Quick sprite + service health summary | Sanity check after any destructive operation |

### Active probes / state changes (use carefully)

| Script | What it does | When to use |
|---|---|---|
| `recovery-step1-safety-checkpoint.mjs` | Creates a NAMED checkpoint (`POST /checkpoint`). Sprites assigns its own ID (e.g. `v21`); the script's proposed name is ignored | **Always run before any destructive op** so we have a rollback point |
| `recovery-step2-restore.mjs` | `POST /checkpoints/<id>/restore`. **Destructive**: wipes overlay, restores snapshot. Streams NDJSON | Only after step 1 + explicit user approval |
| `recovery-step3-verify.mjs` | After restore: lists workspace, JSONLs, marker file, service def, /health, /sessions, checkpoint list | Confirms recovery worked + finds anything off |
| `restore-via-fs-write.mjs` | PUTs local files to fs API path on a stopped/warm sprite. After user resumes the sprite, files are visible to the container | **Restoring user data into a fresh sprite that wasn't checkpointed** |
| `save-recoverable-jsonls.mjs` | Downloads JSONLs from a sprite's persistent disk via fs/read to local `recovered-jsonls/` | Before any destructive recovery — keep an out-of-band backup |
| `push-current-bootstrap.mjs` | STOP + DELETE + PUT the osborn service with a fresh bootstrap baked at PUT time. Stops user's session. **Pinned to `WANT='0.8.33'` at top** — update before running | Force-deploy a bootstrap change without going through frontend / Railway |
| `restore-original.mjs` | STOP + DELETE + PUT with the older non-marker bootstrap from `osborn-1b9d70e5-2a4-service-20260501T191945Z.json` | Emergency rollback |
| `throwaway-update-test.mjs` | Creates a fresh sprite, runs three update strategies (STOP+PUT, restart-only, STOP+DELETE+PUT), reports which one ran the new bootstrap and how many pre-restore checkpoints each created. **Self-cleaning — deletes the throwaway sprite at end** | Deciding which update mechanic to use; reproducing the gateway-stuck-routing pattern |
| `restore-via-oneshot-service.mjs` | Registers a SECONDARY service (name `jsonl-restore`) with cmd-inline base64 of files, runs it once, deletes it. **Failed for us at 7.22MB total — Sprites returns 502 above some body-size limit**. Useful if you split files into <2MB each | Smaller-than-the-limit file injections that need to write to the running container's overlay |
| `restore-jsonls-to-new-sprite.mjs` | Tried two approaches: (a) upload to bashupload.com / 0x0.st / catbox.moe + curl from inside, (b) chunked exec base64 stream. **(a) failed** (host TLS/rate-limit issues). **(b) failed** (exec is no-op). Kept as historical reference for what NOT to do | Reference only |

### Environment

The user's `~/.nvm/versions/node/v10.24.1/bin/node` is the system default. **Always use Node 20** for scripts: `/Users/newupgrade/.nvm/versions/node/v20.11.0/bin/node`. Otherwise you get `SyntaxError: Unexpected token ?` on optional chaining.

### Local backups

`.claude/sprite-backups/recovered-jsonls/` holds the historical session JSONLs we recovered tonight from the deleted `osborn-1b9d70e5-2a4`:
- `11b08960-9eaa-40bb-8858-cafb2f18e257.jsonl` — 4.27 MB, 974 messages
- `6fe0fef7-4ad7-443f-9f01-543ec970d6a3.jsonl` — 1.32 MB, 227 messages
- `listing.json` — original directory listing from the source sprite

These were ALREADY restored to the current sprite via `restore-via-fs-write.mjs`. Don't re-run unless a new sprite is created from scratch.

`.claude/sprite-backups/osborn-1b9d70e5-2a4-service-20260501T191945Z.json` — backup of the OLD service definition (pre-marker bootstrap). Used by `restore-original.mjs`.

---

## 6. Common ops (recipes)

### Probe a sprite's current state

```js
const sp = await (await fetch(BASE, { headers: H })).json()
console.log(sp.status, sp.last_running_at, sp.last_warming_at)

const svc = await fetch(BASE+'/services/osborn', { headers: H })
const svcData = await svc.json()
console.log(svcData.state?.status)            // running/stopped/exited
console.log(svcData.args?.[1]?.length)        // bootstrap script size

const h = await fetch(`https://${SPRITE}-x745.sprites.app/health`, {
  signal: AbortSignal.timeout(5000),
})
console.log(h.status, await h.text())
```

### See what the agent is doing right now

```bash
node -e "
const T = require('fs').readFileSync('frontend/.env.local','utf8').split('\n').find(l=>l.startsWith('SPRITES_API_TOKEN=')).slice(18).replace(/['\"]/g,'').trim()
fetch('https://api.sprites.dev/v1/sprites/<name>/services/osborn/logs?lines=200', {headers:{Authorization:'Bearer '+T}})
  .then(r=>r.text()).then(t=>t.split('\n').forEach(l=>{try{const e=JSON.parse(l);if(e.type==='stdout'||e.type==='stderr')process.stdout.write(e.data)}catch{}}))
"
```

Look for `User joined`, `claude_auth_*`, `Connected to room`, error stack traces, `lk-rtc` LiveKit logs.

### See what Sprites itself logged

```js
const r = await fetch(BASE+'/logs?limit=500', { headers: H })
const logs = await r.json()  // array
logs.sort((a,b) => (a.time??'').localeCompare(b.time??''))
for (const e of logs) {
  if (e.level === 'ERROR' || e.level === 'WARN' || e.attrs?.url) {
    console.log(e.time?.slice(11,23), e.level, e.attrs?.method ?? '', e.attrs?.url ?? '', e.msg)
  }
}
```

This is how we found the "DNS server failed to start" / "Channel error" pattern that proved a sprite was born broken (vs Railway-IP rate limit).

### Recover JSONL data from a sprite that's misbehaving

1. **Always start with**: `node save-recoverable-jsonls.mjs` (after editing `SPRITE` const). This pulls files via fs/read to local. Even if everything else fails, you have the data.
2. List checkpoints. Look for `v<N>` (named) or `pre-restore-v<N>-<ts>` (auto-saved before each restore). Use `inspect-checkpoints.mjs` to see timestamps.
3. **Save current state first**: `node recovery-step1-safety-checkpoint.mjs`.
4. **Restore the candidate**: edit `recovery-step2-restore.mjs` to point at the chosen checkpoint, run it.
5. **Verify**: `node recovery-step3-verify.mjs`.

### Inject files into a sprite the agent will see

```bash
# Stop the sprite from the dashboard (or call /services/osborn/stop)
# Then:
node /Users/newupgrade/Desktop/Developer/osborn/.claude/sprite-backups/restore-via-fs-write.mjs
# (edit SPRITE const + FILES const at the top first)
# User resumes from dashboard. Container reads overlay on boot, sees the files.
```

### Force-deploy a bootstrap change without waiting for Railway

```bash
# Edit push-current-bootstrap.mjs:
#   1. SPRITE constant at top
#   2. WANT version (currently '0.8.33' — bump to whatever's latest)
node /Users/newupgrade/Desktop/Developer/osborn/.claude/sprite-backups/push-current-bootstrap.mjs
```

This stops the user's chat session — they re-OAuth on next connect (unless OAuth was persisted to host layer).

### Reproduce a Sprites bug on a throwaway sprite

```bash
node /Users/newupgrade/Desktop/Developer/osborn/.claude/sprite-backups/throwaway-update-test.mjs
```

Self-cleaning. Useful for testing whether a bug is sprite-specific or platform-wide.

### Wake a hibernated sprite

```bash
curl https://<name>-x745.sprites.app/health
```

Or open `https://<name>-x745.sprites.app/events` (SSE keepalive). HTTP traffic at the proxy is what triggers Sprites' edge to thaw the CRIU snapshot.

### Update osborn to the latest npm version

Click "Update Osborn" in the dashboard, OR call:

```js
await fetch('/api/sandbox', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'update-osborn' })
})
```

This goes through `updateOsborn()` in sprites.ts which: resolves npm latest → STOP + DELETE + PUT new bootstrap → wait for /health → take post-upgrade checkpoint.

---

## 7. Open issues / things to watch

- **Agent-side LiveKit reconnect watchdog** is not implemented. The frontend's "service restart on warm-wake-with-marker" papers over the dead-WebSocket symptom from outside, but a proper fix would be the agent detecting LiveKit `Disconnected` events and reconnecting in-place. Would land in `agent/src/index.ts` right after the LiveKit room connect succeeds — set up an event listener + bounded retry loop.
- **`/exec` API is fully broken for our account** — see §4. Sprites' docs claim it should work; in practice every `POST /exec` returns `0x03 0x00` (exit frame, exit=0) with no stdout and no side-effects (verified via `fs/read` 404 on the target file). Don't bother retrying with different request shapes — use service-registration for anything that needs to actually run.
- **Pre-restore checkpoints accumulate forever**. No cleanup endpoint exists. Eventually the checkpoint list could grow large enough to slow down `listCheckpoints`. Worth adding a cleanup pass that filters out `pre-restore-*` older than N days, if Sprites adds a delete endpoint.
- **Sprites' "last 5 checkpoints mounted at /.sprite/checkpoints/"** — the docs claim this; in our testing the directory was empty. If you find it actually populated, you can read checkpoint contents without doing a full restore. Worth re-testing periodically.
- **Railway → Sprites occasional 503 storms**. On-and-off behavior tonight where Railway's egress couldn't reach Sprites API for ~30 min while local IPs worked fine. Cause unknown — could be IP-based rate limit, could be Railway's egress proxy issue, could be Sprites' geo-routing assigning Railway to a misbehaving region. If you see a 503 storm in Railway logs while local probes succeed, try the manual `push-current-bootstrap.mjs` workaround and wait it out.
- **Bootstrap PUT body size limit** — `restore-via-oneshot-service.mjs` failed at 7.22MB script size with 502. Limit unknown but somewhere between 5119 chars (largest known successful bootstrap) and 7.22MB (known failure). If you need to inline >5MB, split across multiple secondary services or use fs/write + restart instead.

---

## 8. Memory pointers

The auto-memory system has accumulated context across sessions. Most relevant entries:

- **`memory/cloud_sandboxes_sprites_v1.md`** — Sprites architecture overview, original API surface notes, fly.io constraints. Read this first.
- **`memory/cloud_sandboxes_v8.md`** — Daytona predecessor learnings. Useful for the historical "why did we pick Sprites" context. Some bugs documented there (toolbox proxy race, supervisor wrapper hang) don't apply to Sprites but the patterns of debugging cloud platforms are the same.
- **`memory/persistent_session_cleanup_v8.md`** — `killCurrentLLM()` pattern. Why simply nulling the JS reference doesn't kill the Claude subprocess. Critical when investigating "phantom agent activity" reports.
- **`MEMORY.md`** — index. Has bug numbers (#11, #14, #15, #16) tied to specific incidents.

When extending this debugging surface, keep new findings in `docs/critical-patterns.md` (durable, indexed by CLAUDE.md) AND in the auto-memory `memory/*.md` (cross-session). One-off scripts go in `.claude/sprite-backups/`. Avoid putting durable knowledge in chat logs that get summarized away.

---

## 9. Where the recent work lives

Post-`v0.8.30` (May 1–2, 2026) changes — read `CHANGELOG.md`'s `v0.8.30 → v0.8.38` entry for the full forensic per-fix breakdown. Top of mind:

- `frontend/src/lib/sprites.ts` — `generateUniqueSpriteName`, `findUserSandbox(userId, knownSandboxId?)`, `serviceCheckSucceeded` defensive flag, `spriteWasWarm && bootstrapHasMarker` warm-wake-restart branch.
- `frontend/src/app/api/sandbox/route.ts` — `getKnownSandboxId()` helper, `consistency-check` action, all `findUserSandbox` callers updated.
- `frontend/src/app/dashboard/page.tsx` — 2-click delete confirm, Restart visibility on warm/cold, layer-mismatch banner.
- `frontend/src/components/ChatSessionProvider.tsx` — SSE keepalive **still gated on `connected`** (Layer A revert — we kept the targeted Layer B fix in sprites.ts only).
- `agent/src/index.ts` — `__dirname`-resolved `/meeting-output` handler (3 candidate paths), bootstrap inventory log, `killCurrentLLM` cleanup.
- `agent/src/recall-client.ts` — `transcript` dict (was `: true`), `camera.kind` (was `type`), `RECALL_REGION` env-driven base URL.
- `agent/package.json` — build script copies `meeting-output.html` to `dist/`.

Versions deployed at handoff time:
- npm `osborn` package: `0.8.35` (latest)
- frontend: `0.8.37` deployed to Railway, `0.8.38` work in progress (may already be pushed by the time you read this)
- Active sprite: `osborn-1b9d70e5-2a4-bj2zgt` (with timestamp suffix from `generateUniqueSpriteName`)

---

## 10. First moves when you pick this up

1. Read this file end to end. Don't skim §4.
2. Run `proof-of-life.mjs` (after editing the `SPRITE` constant) — confirms your env is set up and the active sprite is reachable.
3. Glance at the most recent CHANGELOG entry (`v0.8.30 → v0.8.38`) for the latest incident timeline.
4. If you're investigating a specific symptom, find the matching gotcha in §4 first — odds are very high it's one of those.
5. Before any destructive op (DELETE sprite, restoreCheckpoint, STOP+DELETE+PUT): always `save-recoverable-jsonls.mjs` first AND `recovery-step1-safety-checkpoint.mjs`. Two independent backups. The sprite-deletion incident from May 1 was unrecoverable; we got lucky tonight that the user's data was on persistent disk.
6. Ask the human before doing anything destructive. Even if it "looks safe."
