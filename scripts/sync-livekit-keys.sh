#!/usr/bin/env bash
# sync-livekit-keys.sh — push LIVEKIT keys from .env to all targets
#
# Usage:
#   ./scripts/sync-livekit-keys.sh           # dry run — shows what would change
#   ./scripts/sync-livekit-keys.sh --apply   # actually applies
#
# Targets:
#   1. Fly machine 784ed236f1e108 (osborn-d4f24f46-v2) — main cloud agent
#   2. Railway frontend — source of truth for all user sandbox machines
#
# The .env file (Desktop/Developer/osborn/.env) is the canonical source.
# Railway is the source of truth for sandbox machine provisioning (machines.ts
# reads process.env at spawn time), so keeping Railway in sync = all new
# sandboxes automatically get the right keys.

set -euo pipefail

ENV_FILE="$(dirname "$0")/../../../Desktop/Developer/osborn/.env"
FLY_APP="osborn-d4f24f46-v2"
FLY_MACHINE="784ed236f1e108"
DRY_RUN=true

[[ "${1:-}" == "--apply" ]] && DRY_RUN=false

# ── Parse .env ──────────────────────────────────────────────────────────────
parse_env() {
  local key="$1"
  grep -E "^${key}=" "$ENV_FILE" | head -1 | sed 's/^[^=]*=//;s/^"//;s/"$//'
}

LIVEKIT_API_KEY=$(parse_env LIVEKIT_API_KEY)
LIVEKIT_API_SECRET=$(parse_env LIVEKIT_API_SECRET)
LIVEKIT_URL=$(parse_env LIVEKIT_URL)
NEXT_PUBLIC_LIVEKIT_URL=$(parse_env NEXT_PUBLIC_LIVEKIT_URL)

if [[ -z "$LIVEKIT_API_KEY" || -z "$LIVEKIT_API_SECRET" || -z "$LIVEKIT_URL" ]]; then
  echo "❌ Could not parse LIVEKIT keys from $ENV_FILE"
  exit 1
fi

echo ""
echo "📋 Keys from .env (source of truth):"
echo "   LIVEKIT_API_KEY          = ${LIVEKIT_API_KEY}"
echo "   LIVEKIT_API_SECRET       = ${LIVEKIT_API_SECRET:0:12}..."
echo "   LIVEKIT_URL              = ${LIVEKIT_URL}"
echo "   NEXT_PUBLIC_LIVEKIT_URL  = ${NEXT_PUBLIC_LIVEKIT_URL}"
echo ""

# ── Target 1: Fly machine ────────────────────────────────────────────────────
echo "🚀 Target 1: Fly machine ${FLY_MACHINE} (${FLY_APP})"

# Read current machine env for comparison
CURRENT=$(flyctl machines list -a "$FLY_APP" --json 2>/dev/null | \
  python3 -c "
import json,sys
data=json.load(sys.stdin)
for m in data:
    if m.get('id') == '${FLY_MACHINE}':
        env=m.get('config',{}).get('env',{})
        for k in ['LIVEKIT_API_KEY','LIVEKIT_API_SECRET','LIVEKIT_URL','NEXT_PUBLIC_LIVEKIT_URL']:
            print(f\"{k}={env.get(k,'')}\")
" 2>/dev/null)

echo "   Current machine env:"
echo "$CURRENT" | sed 's/^/     /'

NEEDS_UPDATE=false
[[ "$(echo "$CURRENT" | grep "^LIVEKIT_API_KEY=" | cut -d= -f2)" != "$LIVEKIT_API_KEY" ]] && NEEDS_UPDATE=true
[[ "$(echo "$CURRENT" | grep "^LIVEKIT_URL=" | cut -d= -f2)" != "$LIVEKIT_URL" ]] && NEEDS_UPDATE=true

if [[ "$NEEDS_UPDATE" == "false" ]]; then
  echo "   ✅ Machine already in sync"
else
  echo "   ⚠️  Machine needs update"
  if [[ "$DRY_RUN" == "false" ]]; then
    flyctl machines update "$FLY_MACHINE" -a "$FLY_APP" \
      --env "LIVEKIT_API_KEY=${LIVEKIT_API_KEY}" \
      --env "LIVEKIT_API_SECRET=${LIVEKIT_API_SECRET}" \
      --env "LIVEKIT_URL=${LIVEKIT_URL}" \
      --env "NEXT_PUBLIC_LIVEKIT_URL=${NEXT_PUBLIC_LIVEKIT_URL}" \
      -y
    echo "   ✅ Machine updated — restart needed to take effect:"
    echo "      flyctl machine restart ${FLY_MACHINE} -a ${FLY_APP}"
  else
    echo "   → Would run: flyctl machines update ${FLY_MACHINE} -a ${FLY_APP} --env LIVEKIT_API_KEY=... (run with --apply)"
  fi
fi

echo ""

# ── Target 2: Railway ────────────────────────────────────────────────────────
echo "🚂 Target 2: Railway frontend (source of truth for sandbox machines)"

if command -v railway &>/dev/null && railway whoami &>/dev/null 2>&1; then
  echo "   Logged in to Railway"
  if [[ "$DRY_RUN" == "false" ]]; then
    cd "$(dirname "$0")/../frontend" 2>/dev/null || cd "$(dirname "$0")/../../frontend"
    railway variables set \
      "LIVEKIT_API_KEY=${LIVEKIT_API_KEY}" \
      "LIVEKIT_API_SECRET=${LIVEKIT_API_SECRET}" \
      "LIVEKIT_URL=${LIVEKIT_URL}" \
      "NEXT_PUBLIC_LIVEKIT_URL=${NEXT_PUBLIC_LIVEKIT_URL}"
    echo "   ✅ Railway updated"
  else
    echo "   → Would run: railway variables set LIVEKIT_API_KEY=... (run with --apply)"
  fi
else
  echo "   ⚠️  Not logged in to Railway — run 'railway login' first, then re-run with --apply"
  echo "   → Manual: Railway dashboard → osborn-frontend → Variables → update these 4:"
  echo "      LIVEKIT_API_KEY          = ${LIVEKIT_API_KEY}"
  echo "      LIVEKIT_API_SECRET       = ${LIVEKIT_API_SECRET}"
  echo "      LIVEKIT_URL              = ${LIVEKIT_URL}"
  echo "      NEXT_PUBLIC_LIVEKIT_URL  = ${NEXT_PUBLIC_LIVEKIT_URL}"
fi

echo ""
if [[ "$DRY_RUN" == "true" ]]; then
  echo "ℹ️  Dry run — no changes made. Run with --apply to push."
else
  echo "✅ Sync complete."
fi
