# Self-Hosted Daytona Setup for Osborn

Osborn provisions per-user cloud sandboxes via a self-hosted [Daytona](https://daytona.io) instance running on a Hostinger VPS. Each user gets an isolated Linux environment running the Osborn agent + Claude Code CLI, fronted by Caddy with HTTPS via Let's Encrypt.

## Live Instance

| What | Where |
|---|---|
| **VPS** | Hostinger KVM 2 — `72.60.71.78` |
| **Domain** | `daytona.voice-native.com` (GoDaddy DNS) |
| **API** | `https://daytona.voice-native.com` |
| **Dashboard** | `https://daytona.voice-native.com/dashboard` |
| **Sandbox previews** | `https://{port}-{sandboxId}.daytona.voice-native.com` |
| **Cost** | $8.99/mo (VPS) + $1.92/mo (domain pro-rated) = **~$11/mo** |

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                  Hostinger VPS (72.60.71.78)                     │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │             Caddy (ports 80/443)                         │    │
│  │  Auto Let's Encrypt SSL via HTTP-01 challenge            │    │
│  │                                                          │    │
│  │  daytona.voice-native.com:                              │    │
│  │    /toolbox/* → :4000 (Daytona proxy)                   │    │
│  │    /dex/*     → :5556 (Dex auth)                        │    │
│  │    /*         → :3000 (API + Dashboard SPA)             │    │
│  │                                                          │    │
│  │  *.daytona.voice-native.com:  (on-demand TLS)           │    │
│  │    → :4000 (Sandbox previews via Daytona proxy)         │    │
│  └──────────────────────────────────────────────────────────┘    │
│                            │                                     │
│  ┌─────────────────────────┴────────────────────────────────┐    │
│  │           Daytona docker-compose stack                   │    │
│  │  • api (3000)        • registry (6000)                  │    │
│  │  • proxy (4000)      • dex/auth (5556)                  │    │
│  │  • runner            • db (postgres)                    │    │
│  │  • ssh-gateway       • redis                            │    │
│  │  • minio (9001)      • registry-ui (5100)               │    │
│  │  • pgadmin (5050)    • jaeger (16686)                   │    │
│  │  • otel-collector    • maildev (1080)                   │    │
│  └──────────────────────────────────────────────────────────┘    │
│                            │                                     │
│  ┌─────────────────────────┴────────────────────────────────┐    │
│  │         User sandbox containers                          │    │
│  │  Image: daytonaio/sandbox:0.5.0-slim                    │    │
│  │  User: daytona (sudo NOPASSWD)                          │    │
│  │  Pre-installed: nvm, node 22.14, npm                    │    │
│  │  Installed at provision: osborn, @anthropic-ai/claude-code│   │
│  │  Runs: osborn --room auto on port 8741                  │    │
│  └──────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────┘
                              │
                              │ HTTPS calls
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│             Osborn Frontend (Next.js, local or Railway)          │
│  /api/sandbox  ← user clicks "Cloud" → creates sandbox           │
│  /chat         ← connects to sandbox via LiveKit + HTTPS         │
└──────────────────────────────────────────────────────────────────┘
```

## Files & Locations

### On the VPS

| Path | Purpose |
|---|---|
| `/root/daytona/` | Daytona git repo (cloned from `daytonaio/daytona`) |
| `/root/daytona/docker/docker-compose.yaml` | Default compose file (don't edit — overridden) |
| `/root/daytona/docker/docker-compose.override.yaml` | **Our customizations** (gitignored) |
| `/root/daytona/docker/dex/config.yaml` | Dex auth config (we modified `issuer`) |
| `/root/daytona-config/dex-config.yaml` | Backup of our Dex config |
| `/etc/caddy/Caddyfile` | Caddy reverse proxy config |
| `/var/lib/caddy/` | Caddy data dir (Let's Encrypt certs stored here) |

### In the Osborn frontend

| Path | Purpose |
|---|---|
| `frontend/src/lib/daytona.ts` | Server-side Daytona SDK wrapper (uses raw HTTP, bypasses buggy SDK) |
| `frontend/src/app/api/sandbox/route.ts` | Next.js API: create/list/start/stop/delete sandboxes |
| `frontend/.env.local` | Has `DAYTONA_API_KEY`, `DAYTONA_API_URL`, `DAYTONA_REGION` |

## Customizations vs Default Daytona

### Files we modified

**`docker/docker-compose.override.yaml`** (NEW — overrides default):

```yaml
services:
  api:
    environment:
      - PROXY_DOMAIN=daytona.voice-native.com
      - PROXY_PROTOCOL=https
      - PROXY_TEMPLATE_URL=https://{{PORT}}-{{sandboxId}}.daytona.voice-native.com
      - DASHBOARD_URL=https://daytona.voice-native.com/dashboard
      - DASHBOARD_BASE_API_URL=https://daytona.voice-native.com
      - PUBLIC_OIDC_DOMAIN=https://daytona.voice-native.com/dex
  proxy:
    environment:
      - OIDC_PUBLIC_DOMAIN=https://daytona.voice-native.com/dex
```

**`docker/dex/config.yaml`** (modified inline — back it up before `git pull`):

```yaml
issuer: https://daytona.voice-native.com/dex   # was: http://localhost:5556/dex
staticClients:
  - id: daytona
    redirectURIs:
      - 'https://daytona.voice-native.com'
      - 'https://daytona.voice-native.com/api/oauth2-redirect.html'
      - 'https://daytona.voice-native.com/callback'
      - 'http://localhost:3000'                # kept for SSH tunnel fallback
      - 'http://localhost:3000/api/oauth2-redirect.html'
```

### NEW infrastructure (not in Daytona repo)

**`/etc/caddy/Caddyfile`** — Reverse proxy with auto-SSL:

```caddyfile
{
    on_demand_tls {
        ask http://localhost:3000/api/health
    }
}

daytona.voice-native.com {
    handle /toolbox/* { reverse_proxy localhost:4000 }
    handle /dex/* { reverse_proxy localhost:5556 }
    handle /dex { reverse_proxy localhost:5556 }
    handle { reverse_proxy localhost:3000 }
}

*.daytona.voice-native.com {
    tls { on_demand }
    reverse_proxy localhost:4000
}
```

**GoDaddy DNS** (voice-native.com):
- A `daytona` → `72.60.71.78`
- A `*.daytona` → `72.60.71.78`

## SDK Bugs / Discrepancies (Workarounds)

The `@daytonaio/sdk` v0.161.0 has compatibility issues with self-hosted Daytona. We bypassed it entirely with raw HTTP calls in `frontend/src/lib/daytona.ts`.

| Bug | Workaround |
|---|---|
| `daytona.list()` throws `Cannot read 'map' of undefined` | Use raw `GET /api/sandbox` |
| `daytona.create()` throws `Cannot read 'endsWith'` | Use raw `POST /api/sandbox` |
| `daytona.get()` throws same | Use raw `GET /api/sandbox/{id}` |
| Field name mismatch: SDK uses `envVars`, API uses **`env`** | Use `env` in raw payload |
| Field name mismatch: SDK uses `region`, API uses **`target`** | Use `target` in raw payload |
| Self-hosted requires explicit `target` (cloud auto-defaults) | Pass `target: "us"` from `DAYTONA_REGION` env |
| Toolbox URL differs: cloud is `:4000` port, self-hosted via Caddy is `/toolbox` path | Detect protocol; HTTPS uses path, HTTP uses port |
| `list()` returns `[]` self-hosted, `{items: []}` cloud | Handle both: `data.items \|\| data` |

## Sandbox Provisioning Pitfalls (Solved)

### 1. The sandbox runs as `daytona` user, not root

The `daytonaio/sandbox:0.5.0-slim` image runs as user `daytona`. Home is `/home/daytona`, NOT `/root`. Things to know:

- `cd /root/workspace` → permission denied
- `~` resolves to `/home/daytona`
- `whoami` returns `daytona`
- **`sudo` works passwordless** (NOPASSWD in sudoers)

### 2. `sudo` strips PATH — `npm` not found

The default PATH for `daytona` user includes `/usr/local/nvm/versions/node/v22.14.0/bin` (where node/npm live). But `sudo npm ...` runs as root with a sanitized PATH that doesn't include nvm. Result: `npm: command not found`.

**Fix**: Preserve PATH explicitly:
```bash
sudo env PATH=/usr/local/nvm/versions/node/v22.14.0/bin:$PATH npm install -g osborn
```

### 3. `envVars` field is silently ignored

When creating a sandbox via the API, the **field name is `env`**, not `envVars`. The wrong name returns success but the variables aren't injected into the sandbox shell.

```typescript
// WRONG — silently ignored
{ envVars: { LIVEKIT_URL: '...' } }

// CORRECT — env vars visible in shell sessions
{ env: { LIVEKIT_URL: '...' } }
```

### 4. Background processes need `setsid` + `disown`

Plain `nohup ... &` doesn't survive the toolbox `executeCommand` returning. The shell exits and SIGHUPs the background process.

**Fix**: Detach from controlling terminal AND parent shell:
```bash
setsid nohup osborn --room auto >/tmp/osborn.log 2>&1 </dev/null & disown
```

### 5. `OSBORN_CWD` must point to a directory that actually exists

The osborn agent reads `process.env.OSBORN_CWD` as its working directory and passes it to `child_process.spawn` (as `cwd`) when spawning the Claude Code subprocess. If the directory doesn't exist, spawn fails with ENOENT — but the Claude Agent SDK reports this as the misleading error:

```
ReferenceError: Claude Code executable not found at .../@anthropic-ai/claude-code/cli.js.
Is options.pathToClaudeCodeExecutable set?
```

This is a wrapped error from the SDK's `error` event handler on the spawned ChildProcess — it has nothing to do with the executable being missing or unset. The cli.js file IS there and IS executable.

**Original bug**: `OSBORN_CWD=/root/workspace` was injected into the sandbox env, but `/root/workspace` doesn't exist (and `/root` is `drwx------ root root`, so unreadable). Result: every Claude SDK call failed with the misleading executable error, surfaced in chat as "Sorry, I encountered an error."

**Fix**: `OSBORN_CWD` must match the directory we `mkdir -p` and `cd` into when launching osborn:

```typescript
// frontend/src/lib/daytona.ts — getPlatformEnvVars()
const envVars: Record<string, string> = {
  OSBORN_CWD: '/home/daytona/workspace',  // ← matches the launch dir
  // ...
}
```

```bash
# launch command — same dir as OSBORN_CWD
mkdir -p /home/daytona/workspace && \
  cd /home/daytona/workspace && \
  sudo -E setsid nohup env HOME=/home/daytona ... osborn ...
```

If you ever see the "Claude Code executable not found" error in a sandbox, the FIRST thing to check is `process.env.OSBORN_CWD` and whether that path exists and is readable by the user osborn is running as.

### 6. osborn runs as **root**, not as the `daytona` user

Earlier we tried running osborn as the `daytona` user — it hit `EACCES` errors when `child_process.spawn` tried to exec node. The fix: launch osborn as root via `sudo -E`:

```bash
cd /home/daytona/workspace && \
  sudo -E setsid nohup \
    env HOME=/home/daytona \
        OSBORN_CWD=/home/daytona/workspace \
        PATH=/usr/local/nvm/versions/node/v22.14.0/bin:$PATH \
    osborn >/tmp/osborn.log 2>&1 </dev/null & disown
```

- `sudo -E` preserves env vars from the sandbox `env` field (LIVEKIT_*, DEEPGRAM_*, OPENAI_*, etc.)
- `HOME=/home/daytona` is forced so OAuth credentials persist at `/home/daytona/.claude/.credentials.json` regardless of effective user — this means a stop/resume preserves the user's Claude auth across containers
- `PATH=...` because `sudo` strips PATH and root's default PATH doesn't include nvm's bin dir

### 7. Symlink `node`/`osborn`/`claude` into `/usr/local/bin`

After installing osborn + claude-code globally, symlink the binaries into `/usr/local/bin` so they're in every user's default PATH (including root's, which by default does NOT include nvm's bin dir):

```bash
sudo ln -sf /usr/local/nvm/versions/node/v22.14.0/bin/node   /usr/local/bin/node
sudo ln -sf /usr/local/nvm/versions/node/v22.14.0/bin/osborn /usr/local/bin/osborn
sudo ln -sf /usr/local/nvm/versions/node/v22.14.0/bin/claude /usr/local/bin/claude
```

This is convenience for interactive shells and any subprocess that does PATH-based binary lookup without inheriting nvm's PATH. It is NOT the fix for the spawn ENOENT error — that fix is the OSBORN_CWD correction in pitfall #5.

## Update Strategy (Pulling Daytona Updates)

Daytona ships frequent updates. To pull a new version safely:

```bash
ssh root@72.60.71.78
cd /root/daytona

# 1. Backup our customizations
cp docker/dex/config.yaml /root/daytona-config/dex-config.yaml.bak

# 2. Pull the update
git pull

# 3. Re-apply Dex config (if it was overwritten)
cp /root/daytona-config/dex-config.yaml docker/dex/config.yaml

# 4. The override file is gitignored — should still be there
ls docker/docker-compose.override.yaml

# 5. Restart everything
docker compose -f docker/docker-compose.yaml -f docker/docker-compose.override.yaml down
docker compose -f docker/docker-compose.yaml -f docker/docker-compose.override.yaml up -d

# 6. Verify
curl https://daytona.voice-native.com/api/health
```

If the SDK changes APIs in a breaking way, the raw HTTP calls in `frontend/src/lib/daytona.ts` may need updating — check for new field names in `node_modules/@daytonaio/api-client/src/models/`.

## Daytona Dashboard Access

### Get / rotate API keys

1. Browse to `https://daytona.voice-native.com/dashboard`
2. Login: `dev@daytona.io` / `password`
3. Sidebar → **API Keys** → Create or revoke keys
4. Update `DAYTONA_API_KEY` in `frontend/.env.local`
5. Restart frontend: `npm run dev` (or redeploy)

**Default credentials** (change for production):
- Email: `dev@daytona.io`
- Password: `password`

To change: edit `/root/daytona/docker/dex/config.yaml`:
```yaml
staticPasswords:
  - email: 'your-email@example.com'
    hash: '$2a$10$...'   # generated via: htpasswd -BinC 10 admin yourpassword
    username: 'admin'
    userID: '1234'
```

Then restart Dex: `docker restart daytona-dex-1`

## Troubleshooting

### Dashboard shows "Failed to fetch" / redirects to localhost

Dex's issuer URL is wrong. Check:
```bash
curl -s https://daytona.voice-native.com/dex/.well-known/openid-configuration | jq .issuer
# Should return: "https://daytona.voice-native.com/dex"
```

Fix: edit `/root/daytona/docker/dex/config.yaml`, set `issuer: https://daytona.voice-native.com/dex`, then `docker restart daytona-dex-1 daytona-api-1`.

### Sandbox creation fails: "endsWith is not a function"

You're using the broken `@daytonaio/sdk`. Our `frontend/src/lib/daytona.ts` uses raw fetch — make sure you haven't reverted it.

### Sandbox can't reach LiveKit / external services

The self-hosted Daytona has **no network restrictions** (unlike Daytona Cloud Tier 1/2). Test from inside a sandbox:
```bash
curl -s -o /dev/null -w "%{http_code}" https://your-livekit-url.livekit.cloud/settings/regions
# Should return 200
```

If blocked, check VPS firewall:
```bash
ufw status
iptables -L -n | head -20
```

### Caddy not provisioning cert for new sandbox subdomain

On-demand TLS is rate-limited by Let's Encrypt (50 certs/week per parent domain by default). Check Caddy logs:
```bash
journalctl -u caddy -n 100 | grep -i "tls\|certificate\|error"
```

If hitting limits, switch to wildcard cert via DNS-01 challenge with GoDaddy API.

### Browser shows `ERR_CERTIFICATE_TRANSPARENCY_REQUIRED`

Some Chromium browsers cache CT (Certificate Transparency) enforcement state for `*.daytona.voice-native.com` and reject Caddy's on-demand certs because the issuance isn't visible in public CT logs they trust at the time of the request.

Quick test: open the sandbox URL in a fresh incognito window — if it works there, it's a cached CT state, not a server-side issue. User can clear site data for the parent domain to recover.

Permanent fixes (in order of preference):
1. **Wildcard cert via DNS-01**: Replace on-demand TLS with a wildcard `*.daytona.voice-native.com` cert obtained via DNS-01 challenge (GoDaddy API). Single cert covers all sandboxes, properly CT-logged once.
2. **Cloudflare proxy in front of Caddy**: Move DNS to Cloudflare nameservers, set `*.daytona` as a proxied (orange-cloud) record. Cloudflare terminates TLS with their own properly CT-logged certs; Caddy doesn't need to issue per-subdomain certs at all.
3. **Switch issuer**: Caddy can use ZeroSSL or another CA whose issuance is reliably CT-logged for on-demand workflows.

### Sandbox returns "Sorry, I encountered an error" on every chat (Claude SDK spawn ENOENT)

Symptoms: voice connection works, greeting plays, but every user message comes back as "Sorry, I encountered an error." Agent log (`tail /tmp/osborn.log` inside the sandbox) shows:

```
ReferenceError: Claude Code executable not found at .../@anthropic-ai/claude-code/cli.js.
Is options.pathToClaudeCodeExecutable set?
```

This is **not** about the executable being missing or unset — it's the Claude Agent SDK's wrapped error for any `child_process.spawn` failure. The most common cause in our setup is `OSBORN_CWD` pointing at a directory that doesn't exist or isn't readable by the user osborn is running as. See pitfall #5 above for the full explanation.

Diagnose:
```bash
SANDBOX_ID=...
KEY=$(grep DAYTONA_API_KEY frontend/.env.local | cut -d= -f2)

# 1. Check what cwd osborn is using
curl -s -X POST "https://daytona.voice-native.com/toolbox/$SANDBOX_ID/process/execute" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"command":"head -10 /tmp/osborn.log"}'
# Look for: 📂 Working directory (cwd): /home/daytona/workspace

# 2. Verify that directory actually exists
curl -s -X POST "https://daytona.voice-native.com/toolbox/$SANDBOX_ID/process/execute" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"command":"ls -la /home/daytona/workspace"}'
```

If cwd is wrong: kill osborn, restart with `OSBORN_CWD=/home/daytona/workspace` overriding the broken sandbox env var, then fix `frontend/src/lib/daytona.ts:getPlatformEnvVars()` for future sandboxes.

### "Agent didn't bind port 8741"

Check the sandbox logs:
```bash
# Get sandbox ID from frontend logs, then:
SANDBOX_ID=...
KEY=$(grep DAYTONA_API_KEY frontend/.env.local | cut -d= -f2)

curl -s -X POST "https://daytona.voice-native.com/toolbox/$SANDBOX_ID/process/execute" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"command":"cat /tmp/osborn.log; which osborn"}'
```

Common causes:
- `osborn: command not found` → `sudo env PATH=...` install failed (see Pitfall #2 above)
- `Missing required environment variables` → `env` field not passed to create (see Pitfall #3)
- Process exits immediately → check the agent logs for actual error

### Daytona services not starting after VPS reboot

```bash
ssh root@72.60.71.78
cd /root/daytona
docker compose -f docker/docker-compose.yaml -f docker/docker-compose.override.yaml up -d
systemctl status caddy
```

To enable auto-start on boot:
```bash
# Caddy already has a systemd unit
systemctl enable caddy

# Daytona needs a systemd unit (not included by default)
cat > /etc/systemd/system/daytona.service << 'EOF'
[Unit]
Description=Daytona self-hosted
Requires=docker.service
After=docker.service network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/root/daytona
ExecStart=/usr/bin/docker compose -f docker/docker-compose.yaml -f docker/docker-compose.override.yaml up -d
ExecStop=/usr/bin/docker compose -f docker/docker-compose.yaml -f docker/docker-compose.override.yaml down

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable daytona
```

## Maintenance Commands

```bash
# View service status
ssh root@72.60.71.78 "docker ps --format 'table {{.Names}}\t{{.Status}}'"

# View logs
ssh root@72.60.71.78 "docker logs daytona-api-1 --tail 50"
ssh root@72.60.71.78 "docker logs daytona-runner-1 --tail 50"
ssh root@72.60.71.78 "journalctl -u caddy -n 50"

# Restart everything
ssh root@72.60.71.78 "cd /root/daytona && docker compose -f docker/docker-compose.yaml -f docker/docker-compose.override.yaml restart"

# Restart just one service
ssh root@72.60.71.78 "docker restart daytona-api-1"

# Clean up old/dead sandboxes (Daytona auto-archives after 7 days)
KEY=dtn_xxx
curl -s https://daytona.voice-native.com/api/sandbox -H "Authorization: Bearer $KEY" | jq '.[] | {id, state, lastEventAt}'

# Force stop a stuck sandbox
curl -X POST https://daytona.voice-native.com/api/sandbox/{id}/stop -H "Authorization: Bearer $KEY"

# Force delete
curl -X DELETE https://daytona.voice-native.com/api/sandbox/{id} -H "Authorization: Bearer $KEY"

# Check disk usage (sandboxes consume disk for the rootfs and persistent volumes)
ssh root@72.60.71.78 "df -h /; docker system df"

# Free up disk
ssh root@72.60.71.78 "docker system prune -af --volumes"
```

## Cost Breakdown

| Item | Cost |
|---|---|
| Hostinger KVM 2 VPS (2 vCPU, 8GB RAM, 100GB NVMe) | $8.99/mo |
| voice-native.com domain (GoDaddy, $22.99/yr) | $1.92/mo |
| Let's Encrypt SSL (Caddy, free) | $0 |
| Daytona self-hosted (open source, free) | $0 |
| **Total infrastructure** | **~$11/mo** |

Plus per-user variable costs:
- LiveKit Cloud (~$0.05/hr active session)
- Anthropic API (claude-sonnet-4-6, depends on usage)
- Deepgram STT (~$0.0043/min)
- OpenAI/Google for voice TTS

Sandbox compute is **free** — runs on the VPS we already pay for. At 100 concurrent active sandboxes you'll likely hit VPS resource limits and need to scale up to KVM 4 ($16/mo) or KVM 8 ($25/mo).

## Frontend Integration

In `frontend/.env.local`:

```env
DAYTONA_API_KEY=dtn_10f67672db8708f7f493c11e9d30a48c0b3accc883bed621e1a8714f517a18e1
DAYTONA_API_URL=https://daytona.voice-native.com
DAYTONA_PROXY_DOMAIN=daytona.voice-native.com
DAYTONA_REGION=us
```

The frontend code (`frontend/src/lib/daytona.ts`) reads these and uses raw HTTP calls. The SDK is **not** used due to compatibility bugs.

## Provisioning Flow (What Happens When User Clicks "Cloud")

1. **Frontend**: User clicks "Cloud" → `POST /api/sandbox { action: 'create' }`
2. **Next.js API route**: Checks Supabase auth, calls `createSandbox(userId)`
3. **`daytona.ts`**:
   - `POST https://daytona.voice-native.com/api/sandbox` with `image: 'node:22'`, `env: getPlatformEnvVars()`, `target: "us"`, `labels: {userId, app: 'osborn'}`, `autoStopInterval: 15`, `autoArchiveInterval: 10080`
   - Polls `GET /api/sandbox/{id}` until `state === "started"` (~10-25s)
   - **Install** (~60s): `sudo env PATH=/usr/local/nvm/versions/node/v22.14.0/bin:$PATH npm install -g osborn@latest @anthropic-ai/claude-code`
   - **Verify**: `which osborn && which claude` succeeds
   - **Symlink**: `sudo ln -sf /usr/local/nvm/.../bin/{node,osborn,claude} /usr/local/bin/` (so they're in every user's PATH)
   - **Start as root**: `mkdir -p /home/daytona/workspace && cd /home/daytona/workspace && sudo -E setsid nohup env HOME=/home/daytona PATH=/usr/local/nvm/versions/node/v22.14.0/bin:$PATH osborn >/tmp/osborn.log 2>&1 </dev/null & disown`
   - **Wait**: Polls `curl http://localhost:8741/health` until 200 (up to 60s)
   - Returns `{ id, status: 'running', previewUrl: 'https://8741-{id}.daytona.voice-native.com' }`
4. **`getPlatformEnvVars()` injects**: `OSBORN_CWD=/home/daytona/workspace`, `NODE_ENV=production`, `HOST=0.0.0.0`, plus forwarded platform infra keys (`OPENAI_API_KEY`, `GOOGLE_API_KEY`, `LIVEKIT_*`, `DEEPGRAM_API_KEY`, `SMITHERY_API_KEY`, `RECALL_API_KEY`). **NOT user auth** — Claude OAuth is per-user, runs inside the sandbox.
5. **Frontend**: Saves `sandboxId` + `sandbox_url` to Supabase `instances` table. User toggles `connectionMode` to `'cloud'` in dashboard settings → chat page reads `localStorage['osborn-connection-mode']` and uses the sandbox preview URL.
6. **User clicks New Conversation**: Chat page detects `connectionMode === 'cloud'`, calls `/api/sandbox` to find the running sandbox, fetches `https://8741-{id}.daytona.voice-native.com/room-code`, gets LiveKit token, connects.
7. **Caddy** auto-provisions a Let's Encrypt cert for the new subdomain on first request via on-demand TLS (~2s extra on first hit, cached after).
8. **Inside the sandbox**: osborn connects to LiveKit Cloud, runs `claude setup-token` pty on first user message → surfaces auth URL via `claude_auth_url` data channel → user pastes code in modal → token persists at `/home/daytona/.claude/.credentials.json`.
9. **Token persistence**: The `.credentials.json` file lives on the sandbox filesystem. It survives auto-stop, auto-resume, and auto-archive — only re-auth needed if the file is deleted or expires.
10. **Keepalive**: While the user is connected, frontend pings `POST /api/sandbox { action: 'keepalive' }` every 5min to reset Daytona's idle timer. Chat page also auto-disconnects after 20min of no user activity (mouse/keyboard/click) to preserve usage.
11. **Idle**: After 15 min of no Daytona API activity, sandbox auto-stops (filesystem persists, $0 compute).
12. **Resume**: User comes back → frontend calls `start` action → sandbox resumes in <90s → agent restarts via the same `cd /home/daytona/workspace && sudo -E setsid nohup ... osborn ...` command (npm packages + OAuth token still on disk).
13. **Auto-archive**: After 7 days stopped, sandbox auto-archives to MinIO object storage (persists indefinitely, very cheap).
