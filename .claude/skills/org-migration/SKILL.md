---
name: org-migration
description: Runbook for migrating the whole osborn Fly fleet from one Fly org to another — apps, volumes, per-user ~/.claude data (sessions + DBs + indexes), the voice-e2e engine, and the Supabase + Railway + sync pointers — headless, with a wipe-proof zero-downtime cutover. Use when moving to a new Fly organization, especially when the source org is billing-frozen (starts blocked) or you only have API tokens (no interactive login / no WireGuard). Admin/ops only — needs both orgs' Fly tokens, the Supabase service-role key, and Railway access, so this is intentionally NOT bundled into user sandboxes.
---

# Osborn Fly cross-org migration (runbook)

Move the entire fleet from a SOURCE Fly org to a DEST Fly org. Proven 2026-11-23
(audos → kelechi: 13 sprites + 2 pools + engine, zero active-user data loss).

**This is an operator runbook, not a shipped capability.** It lives in the repo's
dev-time `.claude/skills` (NOT `agent/.claude/skills`, which seeds into every user
sandbox via `frontend/Dockerfile.sandbox`). The concrete, working scripts from the
reference run live outside the repo in `~/Developer/osborn-fleet-backup/kelechi-*.py`
(and `.sh`) — read those for exact commands; the commands below are the minimal spine.

## Inputs
- **SOURCE org Fly token** (may be billing-frozen — reads / `exec` / autostart still work)
- **DEST org Fly token** (`fly apps create <name>` with NO `--org`; drive volumes/machines
  via the Machines REST API — the macaroon 401s on legacy GraphQL `whoami`/`volumes destroy`)
- **Supabase** `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (bypasses RLS)
- **Railway** `railway` CLI logged in + linked to the frontend service

## Hard-won facts (read first)
- **Billing-frozen source still starts via fly-proxy autostart** — hit
  `https://<app>.fly.dev/sessions/manifest` and it boots (explicit `fly machine start`
  403s). The Machines REST **`exec`** endpoint works on any running machine in both orgs.
- **`fly ssh`/WireGuard do NOT work from a headless token-only session** (6pn UDP). Use
  the Machines REST API + the agent's HTTPS endpoints only.
- **Source agent self-stops after 15 min idle** (`OSBORN_IDLE_EXIT`, un-settable on a
  frozen org). So any single transfer must finish inside 15 min → download to a FILE first
  (raw ~14 MB/s), extract after.
- **The agent never writes Supabase `instances`** (only the frontend does) → booting dest
  machines pre-cutover is safe.
- Dest-app naming: strip a trailing `-n`, append `-k`. **Pool apps get a FRESH
  `osborn-pool-<12hex>` name** (a `-k` suffix breaks `machine-pool.ts` `POOL_APP_NAME_RE`).

## Phases
1. **Image** — build+push the sandbox image to the dest org (`fly deploy --build-only
   --push --remote-only --image-label <ver> --build-arg OSBORN_VERSION=<ver> --app
   <dest-sandbox-app> --config frontend/fly-sandbox.toml`), then retag `:latest` to it
   (GET `/v2/<app>/manifests/<ver>` → PUT raw bytes to `/manifests/latest`, Content-Type =
   the manifest's own OCI mediaType).
2. **Infra replicas** — per sprite+pool app: `fly apps create <dest>` (no `--org`) + shared
   IPv4/IPv6 + volume(s) sized to source + machine(s) with the **source config copied
   verbatim**, swapping image→dest image, mount→new volume, `FLY_API_TOKEN`→dest token,
   stripping `HOME`/`OSBORN_CWD`/`DEV_*`. Iterate EVERY machine for multi-machine apps.
3. **Data (machine-to-machine — the winning method)** — the DEST execs it over Fly's
   backbone: read the source token (machine config env or `exec: printenv
   OSBORN_SYNC_TOKEN`), then
   `curl https://<src>.fly.dev/sessions/export -o /workspace/_exp.tgz && tar xzf … -C
   /workspace/.claude`. **Only `~/.claude` matters** — real `/workspace` is ~9.6 G but
   ~90% is junk that self-heals (`swapfile` ~8 G, `.npm-global` ~1.5 G, `.cache`). The two
   tiny files `/sessions/export` misses (`~/.osborn/secrets.json`, `~/.claude.json`) are
   belt-and-suspenders — phase 2 already copies secrets via the machine config env. Verify
   source vs dest counts. Dormant machines with no reachable token → skip, they self-heal.
   Run with bounded parallelism (~4–5). (NOT laptop-relay: single POST times out on 2 GB,
   chunked finalize loses `/tmp` chunks on autostop.)
4. **Engine** — rebuild `osborn-voice-e2e` into the dest org (Playwright image), create the
   replica + its secrets (from `.env` + Railway `OSBORN_ENGINE_TOKEN`/`GOOGLE_API_KEY`).
5. **Pointer audit** — the only live org pointers are Supabase
   `instances.{sandbox_id,server_url,sandbox_url}` + `machine_pool.app_name`; Railway
   `FLY_API_TOKEN` / `FLY_SANDBOX_APP` / `FLY_SANDBOX_IMAGE` / `FLY_HARNESS_APP` /
   `BROWSER_ENGINE_HOST`; local `voice-native-sync` `CLOUD_URL`. (`bug_reports.sandbox_id`
   is a machine id, `shared_sessions.snapshot_url` is Supabase storage — not org pointers.)
6. **CUTOVER (gated)** — ⚠️ a token/DB-org mismatch WIPES rows (`GET /api/sandbox` 404 →
   clears `instances.sandbox_id`, `frontend/src/app/api/sandbox/route.ts`). Safe order:
   back up the rows → stage all Railway vars (`railway variables --set … --skip-deploys`) +
   flip the local sync `CLOUD_URL` → trigger a REAL deploy (a *changed* marker var WITHOUT
   `--skip-deploys`, from the linked dir — a no-op same-value set does NOT deploy) and watch
   `railway logs` until the dest app names appear → flip the DB **keyed by `user_id`**
   (wipe-proof + idempotent, repairs any cleared row; set `instance_type='cloud'`),
   re-applying on a short loop until rows STAY correct → verify rows + pool + site 200.
7. **Delete old org (separate, gated)** — only after a safety window with the dest proven;
   the source apps are the rollback until then (re-apply the row backup + re-stage Railway
   to the source token + redeploy).

## Reference implementation
The exact 2026-11-23 scripts (build-image, replicate-infra, m2m-data, replicate-engine,
cutover) are in `~/Developer/osborn-fleet-backup/kelechi-*.py` (+ `.sh`) — they read the
two org tokens from the `.env` source/dest sections. Generalizing them to env-var inputs
and an admin UI/background runner is tracked in the productization issue.
