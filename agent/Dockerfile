# syntax = docker/dockerfile:1
#
# Osborn Agent — Fly.io Deployment
# Self-hosted voice AI research assistant with Claude Code CLI
#
# Build:  fly deploy
# Local:  docker build -t osborn-agent . && docker run -p 8741:8741 --env-file .env osborn-agent

ARG NODE_VERSION=20
FROM node:${NODE_VERSION}-slim AS base
WORKDIR /app
ENV NODE_ENV=production

# ── Build stage: native deps (node-pty, ripgrep) ──
FROM base AS build

RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y \
    build-essential \
    python-is-python3 \
    pkg-config \
    curl \
    git && \
    rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .

# ── Final stage: lean runtime ──
FROM base

# Runtime deps: python for node-pty, git for Claude Code, curl for health checks,
# ca-certificates for HTTPS (LiveKit, Deepgram, Anthropic API connections)
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y \
    python-is-python3 \
    ca-certificates \
    curl \
    git && \
    rm -rf /var/lib/apt/lists/*

# Claude Code CLI — installed globally so it's on PATH for the agent SDK
RUN npm install -g @anthropic-ai/claude-code

# Playwright Chromium browser for browser automation skill
RUN npx playwright install chromium --with-deps 2>/dev/null || true

# Copy built app from build stage
COPY --from=build /app /app

# Persistent workspace volume mount point (Fly.io mounts here)
RUN mkdir -p /workspace

# Config
ENV HOST=0.0.0.0
ENV PORT=8741
ENV OSBORN_CWD=/workspace

EXPOSE 8741

# Entrypoint script: sets up Claude credential symlinks, onboarding bypass, then starts agent
COPY <<'ENTRYPOINT' /entrypoint.sh
#!/bin/sh
set -e

# ── Claude credential persistence ──
# /workspace is the Fly.io persistent volume. Credentials survive deploys/restarts.
# Remove any stale symlink or directory, then create fresh symlink.
mkdir -p /workspace/.claude
rm -rf /root/.claude
ln -sf /workspace/.claude /root/.claude

# ── Claude onboarding suppression (learned from claudebox) ──
# Claude Code shows 5+ interactive prompts on first run. Pre-write config to skip all of them.
# Must write to ALL THREE config paths (different CLI versions check different files).
ONBOARDING_JSON='{"numStartups":10,"installMethod":"npm","autoUpdates":false,"hasCompletedOnboarding":true,"hasTrustDialogAccepted":true,"hasTrustDialogHooksAccepted":true,"hasCompletedProjectOnboarding":true,"hasAcknowledgedCostThreshold":true,"effortCalloutV2Dismissed":true,"theme":"dark","projects":{"/workspace":{"hasTrustDialogAccepted":true,"hasTrustDialogHooksAccepted":true,"hasCompletedProjectOnboarding":true}}}'

echo "$ONBOARDING_JSON" > /root/.claude.json
mkdir -p /workspace/.claude
echo "$ONBOARDING_JSON" > /workspace/.claude/.config.json
echo "$ONBOARDING_JSON" > /workspace/.claude/claude.json

# ── Session workspace persistence ──
# Session workspace (.osborn/sessions/) defaults to sessionBaseDir (/app).
# Symlink to volume so spec.md, library/ files survive deploys.
mkdir -p /workspace/.osborn
rm -rf /app/.osborn
ln -sf /workspace/.osborn /app/.osborn

# ── Restore CLAUDE_CODE_OAUTH_TOKEN from persisted volume ──
if [ -f /workspace/.claude/.oauth-token ]; then
  export CLAUDE_CODE_OAUTH_TOKEN="$(cat /workspace/.claude/.oauth-token)"
  echo "✅ Restored CLAUDE_CODE_OAUTH_TOKEN from volume"
fi

# ── Start Osborn agent ──
exec node --import tsx/esm src/index.ts
ENTRYPOINT
RUN chmod +x /entrypoint.sh

CMD ["/entrypoint.sh"]
