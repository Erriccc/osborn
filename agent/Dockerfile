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

# Copy built app from build stage
COPY --from=build /app /app

# Persistent workspace volume mount point (Fly.io mounts here)
RUN mkdir -p /workspace

# Symlink ~/.claude → /workspace/.claude so sessions + credentials persist across deploys
# The volume at /workspace survives container restarts; ~/.claude is ephemeral without this
RUN mkdir -p /workspace/.claude && ln -sf /workspace/.claude /root/.claude

# Config
ENV HOST=0.0.0.0
ENV PORT=8741
ENV OSBORN_CWD=/workspace

EXPOSE 8741

# Entrypoint: ensure symlink exists (volume may not be mounted at build time),
# then start the agent
CMD sh -c "mkdir -p /workspace/.claude && ln -sf /workspace/.claude /root/.claude && node --import tsx/esm src/index.ts"
