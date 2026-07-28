# Skill: Osborn Production Ops

Operational context for diagnosing + fixing the Osborn production stack (Railway frontend + Fly Machines per-user agent sandboxes + Supabase + LiveKit Cloud + Recall.ai). Auto-loaded so future sessions don't re-discover this from scratch.

## When to use

Any request about: production debugging, environment variables, Fly machine state, Railway logs, LiveKit quota/auth issues, log uploads to Supabase, sprite-stuck-on-connecting, post-update verification, version updates. Trigger phrases include "check fly logs", "check railway logs", "frontend stuck", "agent not connecting", "production down", "update Osborn version", "debug X in prod".

## Stack topology

```
Railway (Next.js frontend, voice-native.com)
  │ reads from process.env (Railway dashboard env vars)
  ├── /api/sandbox        → manages Fly machines per user
  ├── /api/token          → mints LiveKit JWT
  ├── /api/instance       → Supabase-backed user→sandbox mapping
  ├── /api/upload         → Supabase Storage uploads
  └── data channel        → LiveKit room ↔ agent
       │
       ▼
Fly Machines (app per user: osborn-{userIdSlug})
  │ env injected by frontend/src/lib/machines.ts getPlatformEnvVars()
  │ which reads from Railway's process.env (LIVEKIT_*, DEEPGRAM_*, etc)
  └── osborn npm package: voice agent + Claude SDK
       │
       ▼
LiveKit Cloud (real-time voice transport)
Recall.ai (meeting bot, polling /api/v1/bot/{id})
Anthropic API (Claude via OAuth in container)
```

## Critical env var flow (THE source of every "old value won't go away" headache)

1. **Railway dashboard variables** are the source of truth for production
2. `frontend/src/lib/machines.ts` `getPlatformEnvVars(userId)` reads from `process.env` and builds the Fly machine env config (line ~284)
3. Forwarded keys (line ~291): `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `NEXT_PUBLIC_LIVEKIT_URL`, `DEEPGRAM_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `ANTHROPIC_API_KEY`, `RECALL_API_KEY`, `SMITHERY_API_KEY`, `GROQ_API_KEY`
4. Hardcoded: `OSBORN_API_PORT=8741`, `OSBORN_CWD=/workspace`, `HOME=/root`, `LIVEKIT_ROOM=osborn-{userIdSlug8}`
5. These get baked into `config.env` on every machine create/update via Fly Machines API

**If you change a Railway env var, existing machines DON'T pick it up until a fresh `createSandbox` or `updateOsbornImpl` runs (which PATCHes config). A simple `restart` does NOT re-pull env from the frontend.**

**Fly secrets vs config.env (the trap):** sprite-style apps have machine-managed env, NOT release-managed. `flyctl secrets set/unset` "stages" changes that only apply on full `flyctl deploy` — which doesn't work for these apps ("no machines available to deploy", "current release not found"). If old secrets are baked into a machine from a previous lifecycle, the only way to clear them is to PATCH the machine config with fresh env OR recreate the machine.

## LiveKit accounts (multiple, sometimes confused)

User has had THREE LiveKit projects historically:
- `mintchi-6k6xmqua` — account 1, original, has hit quota
- `mintchiassetmanagementllc-4yll70qe` — account 2, current target (separate account, not just project)
- `osborn-live-agent-kkjwjvfr` — account 3, baked into legacy `osborn-agent` Fly app (destroyed 2026-05-25 but its secrets had been replicated into the user sprite at creation)

The free tier may be account-wide, not per-project. Plan upgrade is the real fix once quota is hit.

## Diagnostic recipes

### Read the agent's runtime state without logging in
```
curl https://<sprite-app>.fly.dev/health
```
Returns `{status, version, workingDir, livekit:{status, error, errorCode, attemptCount, lastAttemptAt}}` as of v0.9.45+. `errorCode` ∈ `quota_exceeded | auth | network | unknown`. Always returns 200 even when LiveKit is failing — so the frontend keeps showing "Connecting..." instead of bouncing to dashboard. Look here first for any "stuck connecting" issue.

### Pull Fly logs
```bash
FLY_API_TOKEN='<token>' flyctl logs -a osborn-<userIdSlug> --no-tail | tail -50
```
Buffer keeps last ~100 lines or ~15 min, whichever is less. For older logs use the disconnect-time Supabase upload (see below).

### Read the actual env the agent process sees (NOT machine config)
```bash
flyctl ssh console -a osborn-<userIdSlug> -C 'bash -lc "env | grep LIVEKIT"'
```
Or via /proc:
```bash
flyctl ssh console -a <app> -C 'bash -lc "for d in /proc/[0-9]*; do p=${d##*/}; c=$(tr \\0 \  </proc/$p/cmdline 2>/dev/null); echo \"$c\" | grep -q osborn && { tr \\0 \\n </proc/$p/environ | grep LIVEKIT; break; }; done"'
```

### Read machine config env (what Fly thinks the env SHOULD be at next start)
```bash
curl -fsS -H "Authorization: Bearer $FLY_API_TOKEN" "https://api.machines.dev/v1/apps/<app>/machines/<machine_id>" | jq '.config.env'
```

### List Fly secrets (may be empty even if machine has the values)
```bash
flyctl secrets list -a <app>
```

### Force fresh env injection (no other way to clear baked-in old secrets)
- **Image swap (preferred, used by `updateOsbornImpl`):** PATCH machine config with new image, wait for `state` to leave `'replacing'`/`'creating'`, then `startSandbox`. See `frontend/src/lib/machines.ts waitForReplacementComplete`.
- **Stop+start:** May or may not re-resolve env from config. Verify with the env read recipe above.
- **`flyctl secrets set`** on sprite-style apps: errors with "current release not found". Don't waste time.

### Stop + start a Fly machine
```
curl -X POST -H "Authorization: Bearer $FLY_API_TOKEN" https://api.machines.dev/v1/apps/<app>/machines/<id>/stop
curl -X POST -H "Authorization: Bearer $FLY_API_TOKEN" https://api.machines.dev/v1/apps/<app>/machines/<id>/start
```

### Read the persistent agent log on the volume
Per-disconnect logs upload to Supabase Storage `osborn-storage/logs/<spriteName>/<ts>_<sessionId>.log`. As of v0.9.46 + new Dockerfile (entrypoint tees to `/workspace/osborn.log`), uploads contain real content. Pre-v0.9.46 uploads were always 39-byte `Logs API error 404: 404 page not found` — known bug.

Live tail on a running machine:
```bash
flyctl ssh console -a <app> -C 'tail -n 200 /workspace/osborn.log'
```

### Check Supabase Storage for recent log uploads
```bash
curl -sS -X POST "https://frzbawsadhmmltokvexj.supabase.co/storage/v1/object/list/osborn-storage" \
  -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prefix":"logs/<spriteName>/","limit":20,"sortBy":{"column":"created_at","order":"desc"}}'
```
Download a specific log:
```bash
curl -sS "https://frzbawsadhmmltokvexj.supabase.co/storage/v1/object/public/osborn-storage/logs/<spriteName>/<filename>" -H "apikey: $SUPABASE_ANON_KEY"
```

### Test Recall.ai transcript fetch for a meeting bot
```bash
# Step 1: get the bot record
curl -sS -H "Authorization: Token $RECALL_API_KEY" \
  "https://us-west-2.recall.ai/api/v1/bot/$BOT_ID" > /tmp/bot.json
# Step 2: extract pre-signed S3 URL
URL=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("/tmp/bot.json")).recordings[0].media_shortcuts.transcript.data.download_url)')
# Step 3: download transcript JSON
curl -sS "$URL" -o /tmp/transcript.json
```
Region MUST be `us-west-2` — defaults won't work. The convenience endpoint `/bot/{id}/transcript` does NOT exist (returns 404). Documented chain is above.

## Quick architecture facts

- Compaction events: `agent/src/index.ts buildOnCompactionEvent()` bridges `PreCompact`/`PostCompact` hooks (and SDK iterator's `subtype:'compact_boundary'` + `subtype:'status'` messages) to the frontend via `claude_output` data channel events. All three modes (direct/realtime/pipeline) wire this — pipeline mode silently dropped it before v0.9.44.
- Meeting bot (since v0.9.44): pure REST polling. `MeetingTranscriptPoller` every 30s. No LiveKit republish, no `output_media`. Skill at `agent/.claude/skills/meetings/SKILL.md` teaches the agent to maintain `meeting-todos.md` silently.
- `room.connect` (v0.9.45): bounded-backoff retry, never `process.exit(1)`. `/health` surfaces error.
- Frontend "Connecting..." screen blocks on `agent_ready` data channel event — if agent can't connect to LiveKit, this screen hangs indefinitely. Future improvement: poll `/health` and surface `livekit.errorCode`.

## Common anti-patterns (verified the hard way)

- ❌ Trying `flyctl secrets set` on sprite-style Fly apps — fails because no release
- ❌ Trusting `flyctl secrets list` empty output to mean machine env is clear
- ❌ Assuming machine `restart` re-resolves env — it doesn't, only stop+start or PATCH config does
- ❌ Reading Fly Machines `/v1/apps/{app}/machines/{id}/logs` REST endpoint — doesn't exist (404). Use `/exec` with `tail /workspace/osborn.log` instead
- ❌ Calling `process.exit(1)` on connect failure — turns transient errors into restart loops, Fly kills machine after 3
- ❌ Looking for `meeting-output.html` or `/meeting-output` route — deleted in v0.9.44, polling architecture replaced it
- ❌ Stopping machines that look "started" but show 1-line uptime > weeks — verify they're not legacy ghosts before destroying (osborn-agent was — destroyed 2026-05-25 because it had no real role + held a third LiveKit project's keys)
- ❌ Updating env vars only on local `.env.local` and expecting production to follow — Railway has SEPARATE env vars in its dashboard

## Effective patterns (saved time repeatedly)

- ✅ Always check `/health` first — has version + LiveKit subsystem state, no auth needed
- ✅ Use Fly Machines REST API directly when flyctl fails (sprite apps don't follow flyctl's release model)
- ✅ Stop+start beats restart for env refresh, image swap beats stop+start
- ✅ Read the actual `/proc/<pid>/environ` of the live process to confirm what env it sees (independent of config layers)
- ✅ For Recall: always us-west-2 endpoint, always walk recordings[0].media_shortcuts.transcript.data.download_url
- ✅ When confused about which credentials are active, list 3 sources side-by-side: machine config.env, Fly secrets list, runtime /proc env. They can diverge.

## Recurring failure modes

| Symptom | Most likely cause | Fix |
|---|---|---|
| Stuck on "Connecting..." | Agent can't reach LiveKit | Check `/health` `livekit.errorCode` |
| `429 connection minutes exceeded` | LiveKit free tier hit (account-wide?) | Upgrade plan, switch account (not just project) |
| `401 invalid token` after env update | Old Fly secrets overriding new config.env | PATCH machine config with image swap |
| Supabase log uploads all 39 bytes | Pre-v0.9.46 Dockerfile, hits non-existent Fly /logs REST | Rebuild sandbox image (Dockerfile tees to /workspace/osborn.log) |
| Compaction never appears in UI | Pipeline mode dropping events (pre-v0.9.44) | Confirm version >= 0.9.44 |
| Recall transcript empty | Bot record fetched but `recordings[0]` not ready | Wait — Recall takes ~30s after `recording_done` to materialize |
| Machine restart-loops to "max restart count" | Pre-v0.9.45 agent crashing on LiveKit failure | Confirm version >= 0.9.45 (has retry resilience) |

## Reference paths

- Frontend env injection: `frontend/src/lib/machines.ts:284 getPlatformEnvVars()`
- Sandbox API routes: `frontend/src/app/api/sandbox/route.ts`
- LiveKit retry loop: `agent/src/index.ts main() → connectWithRetry()`
- Compaction bridge: `agent/src/index.ts:1676 buildOnCompactionEvent()`
- Meeting poller: `agent/src/meeting-transcript-poller.ts`
- Recall client: `agent/src/recall-client.ts joinMeeting + getTranscript`
- Dockerfile (canonical): `agent/Dockerfile.sandbox` (synced to `frontend/Dockerfile.sandbox` via prebuild)
- Disconnect log upload: `frontend/src/components/ChatSessionProvider.tsx disconnect()`

## Current version mark

As of writing: agent on `0.9.46`. Versions `0.9.43 → 0.9.46` are detailed in CHANGELOG.md "v0.9.43 → v0.9.46 (May 22–27, 2026)" — meeting polling rewrite, LiveKit retry resilience, compaction bridge fix, sandbox log capture, Fly update flow fix, osborn-agent destruction.
