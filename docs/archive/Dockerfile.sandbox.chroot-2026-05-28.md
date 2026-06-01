# Archive: chroot-based Dockerfile.sandbox

This is the chroot architecture we built and verified on 2026-05-28 then
retired in favor of Option D after A/B testing showed equivalent runtime
behavior with ~100 fewer LOC. See CHANGELOG.md (this date) for the decision
rationale, and docs/volume-as-home.md for the final architecture.

```dockerfile
# Osborn Sandbox — Fly.io Machines (per-user)
# Installs osborn as npm package (not from source) for lightweight per-user machines.
# Build: docker build -f Dockerfile.sandbox -t registry.fly.io/osborn-sandbox/agent:latest .
# Push:  fly auth docker && docker push registry.fly.io/osborn-sandbox/agent:latest
#
# ARCHITECTURE — simplified chroot ("volume-as-home")
# ====================================================
# As of 0.9.47 the entrypoint chroots into /workspace/root-chroot before exec'ing
# osborn. Net effect: the persistent Fly volume holds HOME and user-mutable state,
# but osborn ITSELF comes from the image (bind-mounted /usr/local). This means:
#   - Image-swap updates osborn INSTANTLY — new image's /usr/local appears in
#     the chroot via bind-mount, no extraction or runtime install needed.
#   - HOME (/root inside chroot) persists everything that respects $HOME: Claude
#     OAuth, gh tokens, git config, ssh keys, npm cache, etc.
#   - /etc on volume — user mods to /etc persist across image rebuilds.
#   - /home on volume — additional user dirs persist.
#   - /workspace is the user's project dir (cwd of osborn). Persisted as before.
#
# Layout inside the chroot (host paths in parens):
#   /usr /lib /lib64 /bin /sbin /opt  ← bind-mounted from IMAGE
#                                       (image-swap brings new osborn here)
#   /etc                              ← copied from image on first boot, mutable
#   /root                             ← HOME, on volume — OAuth, gh, ssh, git
#   /home                             ← user dirs, on volume
#   /workspace                        ← bind-mount of host /workspace
#   /dev /proc /sys                   ← bind-mounted from host
#
# What this does NOT preserve across image rebuilds:
#   - Custom packages installed to /usr/local (e.g. `npm install -g foo`).
#     Reason: /usr/local is bind-mounted from image, not the volume. Image-swap
#     replaces it. User npm globals should target HOME-based prefixes instead.
#     (If we ever need user system-installs, set NPM_CONFIG_PREFIX to a volume
#     path like /root/.npm-global in user's bashrc.)
#
# This is the SIMPLIFIED chroot architecture chosen after sacrificial verification
# on 2026-05-28. Earlier designs put /opt/npm-global on the volume with osborn
# pre-installed there; this turned out to make every update slow (80s tarball
# re-extraction or 3min npm install) because /opt/npm-global is ~2GB. Bind-
# mounting /usr/local from the image makes osborn upgrade free.

FROM node:22-slim

# Runtime deps for osborn + claude-code. Stays in the image; image-swap brings
# security updates.
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y \
    ca-certificates \
    curl \
    git \
    make \
    g++ \
    python-is-python3 && \
    rm -rf /var/lib/apt/lists/*

# Pin osborn version so Docker layer cache invalidates with each release.
# image-build-check.ts passes --build-arg OSBORN_VERSION=X.Y.Z.
ARG OSBORN_VERSION=latest
RUN npm install -g "osborn@${OSBORN_VERSION}" @anthropic-ai/claude-code

# Persistent volume mount point + legacy /root/.claude dir (legacy fallback path)
RUN mkdir -p /workspace /root/.claude

# Markers for orchestration:
#   /etc/osborn-manifest-aware  — older marker (still here for back-compat probes)
#   /etc/osborn-chroot-aware    — chroot architecture marker
RUN touch /etc/osborn-manifest-aware /etc/osborn-chroot-aware

ENV OSBORN_API_PORT=8741
ENV NODE_ENV=production
# OSBORN_IMAGE_VERSION is informational only with the simplified architecture
# (osborn version === whatever's at /usr/local/lib/node_modules/osborn).
# Kept for observability via /health.
ENV OSBORN_IMAGE_VERSION=${OSBORN_VERSION}

# OSBORN_CWD / HOME are NOT set here — entrypoint sets them inside the chroot
# (HOME=/root, OSBORN_CWD=/workspace, both chroot-relative).

WORKDIR /workspace

EXPOSE 8741

# Entrypoint: chroot setup + credential persistence + onboarding + start
COPY <<'ENTRYPOINT' /entrypoint.sh
#!/bin/bash
set -e

# === Persistent log capture ===
LOGFILE=/workspace/osborn.log
mkdir -p /workspace
if [ -f "$LOGFILE" ] && [ "$(stat -c%s "$LOGFILE" 2>/dev/null || echo 0)" -gt 104857600 ]; then
  echo "[sandbox] Rotating /workspace/osborn.log (>100MB, keeping last 50MB)"
  tail -c 52428800 "$LOGFILE" > "$LOGFILE.tmp" && mv "$LOGFILE.tmp" "$LOGFILE"
fi
echo "[sandbox] === boot at $(date -Iseconds) ===" >> "$LOGFILE"
exec > >(tee -a "$LOGFILE") 2>&1

# Onboarding-suppression JSON for Claude Code.
ONBOARDING_JSON='{"numStartups":10,"installMethod":"npm","autoUpdates":false,"hasCompletedOnboarding":true,"hasTrustDialogAccepted":true,"hasTrustDialogHooksAccepted":true,"hasCompletedProjectOnboarding":true,"hasAcknowledgedCostThreshold":true,"effortCalloutV2Dismissed":true,"theme":"dark","projects":{"/workspace":{"hasTrustDialogAccepted":true,"hasTrustDialogHooksAccepted":true,"hasCompletedProjectOnboarding":true}}}'

# ============================================================
# === volume-as-home chroot setup (simplified) ===
# ============================================================
# Bind-mount system dirs from the IMAGE (/usr /lib /lib64 /bin /sbin /opt).
# These come fresh from each new image — image-swap upgrades osborn instantly.
# Persist /etc /root /home /var on the VOLUME — user-mutable state.
# Falls through to legacy non-chroot boot if any setup step fails.
CHROOT_ROOT=/workspace/root-chroot
CHROOT_MARKER=/workspace/.chroot-seeded

setup_chroot_mounts() {
  set -e
  # Skeleton dirs (idempotent). /opt is bound from image; no /opt/npm-global on volume.
  mkdir -p "${CHROOT_ROOT}"/{usr,lib,lib64,bin,sbin,opt,etc,root,home,tmp,dev,proc,sys,workspace,var,run}

  # Bind system dirs from image (read-mostly; image-swap brings updates)
  for d in usr lib lib64 bin sbin opt; do
    if [ -d "/${d}" ] && ! mountpoint -q "${CHROOT_ROOT}/${d}"; then
      mount --bind "/${d}" "${CHROOT_ROOT}/${d}"
    fi
  done

  # Bind /dev /proc /sys (required for any child processes)
  for d in dev proc sys; do
    if ! mountpoint -q "${CHROOT_ROOT}/${d}"; then
      mount --bind "/${d}" "${CHROOT_ROOT}/${d}"
    fi
  done

  # Bind /workspace (the volume) into chroot at the same path so OSBORN_CWD
  # and Claude Code's session slug ("-workspace") stay stable.
  if ! mountpoint -q "${CHROOT_ROOT}/workspace"; then
    mount --bind /workspace "${CHROOT_ROOT}/workspace"
  fi

  # DNS — copy resolv.conf into chroot's /etc each boot (Fly populates it
  # per-machine; it's NOT the same one we copied at first-boot seed time)
  cp -L /etc/resolv.conf "${CHROOT_ROOT}/etc/resolv.conf" 2>/dev/null || true

  return 0
}

run_chrooted() {
  # First-boot seed: copy /etc and a few essentials from image. ~5s, small.
  if [ ! -f "${CHROOT_MARKER}" ]; then
    echo "[chroot] first boot — seeding /etc to volume"
    cp -a /etc/. "${CHROOT_ROOT}/etc/" 2>/dev/null || true
    touch "${CHROOT_MARKER}"
  fi

  # One-time migration from legacy layout. Pre-chroot machines stored
  # /workspace/.claude/ and /workspace/.claude.json directly on the volume
  # root. New location is ${CHROOT_ROOT}/root/.claude/ (chroot HOME).
  # Atomic `mv` — either fully happens or doesn't (same filesystem).
  mkdir -p "${CHROOT_ROOT}/root"
  if [ -d /workspace/.claude ] && [ ! -d "${CHROOT_ROOT}/root/.claude" ]; then
    echo "[chroot] migrating legacy /workspace/.claude → chroot /root/.claude"
    mv /workspace/.claude "${CHROOT_ROOT}/root/.claude"
  fi
  if [ -f /workspace/.claude.json ] && [ ! -f "${CHROOT_ROOT}/root/.claude.json" ]; then
    mv /workspace/.claude.json "${CHROOT_ROOT}/root/.claude.json"
  fi

  # Apply onboarding config (idempotent)
  mkdir -p "${CHROOT_ROOT}/root/.claude"
  echo "$ONBOARDING_JSON" > "${CHROOT_ROOT}/root/.claude.json"
  echo "$ONBOARDING_JSON" > "${CHROOT_ROOT}/root/.claude/.config.json"
  echo "$ONBOARDING_JSON" > "${CHROOT_ROOT}/root/.claude/claude.json"

  # Restore OAuth token if persisted on volume (legacy .oauth-token format)
  if [ -f "${CHROOT_ROOT}/root/.claude/.oauth-token" ]; then
    export CLAUDE_CODE_OAUTH_TOKEN="$(cat "${CHROOT_ROOT}/root/.claude/.oauth-token")"
    echo "[chroot] restored CLAUDE_CODE_OAUTH_TOKEN from volume"
  fi

  # Seed default skills shipped with the npm package into chroot's
  # /root/.claude/skills/. Reads from IMAGE's install location since /usr is
  # bind-mounted. Two preservation invariants:
  #   (1) USER-ADDED skills (no equivalent in the npm package) are preserved
  #       across image upgrades — never deleted.
  #   (2) IMAGE-DEFAULT skills get REFRESHED when the image version changes.
  #       Without this, a golden-snapshot user provisioned at osborn v0.9.46
  #       would keep v0.9.46 skill content forever even after image-swap to
  #       v0.9.47 (the skip-if-exists guard at line ~186 of the v0.9.47
  #       Dockerfile would never re-overwrite). Verified in B6 audit
  #       2026-05-28 — fix logged in docs/volume-as-home.md.
  #
  # Mechanism: a `.seed-version` marker stores the image version that last
  # seeded the skills. On boot, if the marker is missing or differs from
  # OSBORN_IMAGE_VERSION, we refresh every IMAGE-DEFAULT skill (those listed
  # in /usr/local/lib/node_modules/osborn/.claude/skills/) while leaving
  # user-only skills untouched.
  HOME_SKILLS_DIR="${CHROOT_ROOT}/root/.claude/skills"
  PKG_SKILLS_DIR="/usr/local/lib/node_modules/osborn/.claude/skills"
  SEED_VERSION_FILE="${HOME_SKILLS_DIR}/.seed-version"
  mkdir -p "$HOME_SKILLS_DIR"
  CURRENT_SEED_VERSION=$(cat "$SEED_VERSION_FILE" 2>/dev/null | tr -d '[:space:]' || echo "")
  IMAGE_SEED_VERSION="${OSBORN_IMAGE_VERSION:-latest}"
  if [ -d "$PKG_SKILLS_DIR" ]; then
    REFRESHED=0
    SEEDED=0
    for d in "$PKG_SKILLS_DIR"/*/; do
      [ -d "$d" ] || continue
      NAME=$(basename "$d")
      if [ ! -d "$HOME_SKILLS_DIR/$NAME" ]; then
        # New skill — seed it
        cp -r "$d" "$HOME_SKILLS_DIR/$NAME"
        echo "[chroot] seeded default skill: $NAME"
        SEEDED=$((SEEDED+1))
      elif [ "$CURRENT_SEED_VERSION" != "$IMAGE_SEED_VERSION" ]; then
        # Image version drift — refresh this image-default skill while
        # preserving user mods (rsync-style would be ideal but cp -r is
        # what we have; the refresh wins since image-default skills are
        # owned by the package).
        rm -rf "$HOME_SKILLS_DIR/$NAME"
        cp -r "$d" "$HOME_SKILLS_DIR/$NAME"
        echo "[chroot] refreshed default skill (image $CURRENT_SEED_VERSION → $IMAGE_SEED_VERSION): $NAME"
        REFRESHED=$((REFRESHED+1))
      fi
    done
    if [ "$CURRENT_SEED_VERSION" != "$IMAGE_SEED_VERSION" ]; then
      echo "$IMAGE_SEED_VERSION" > "$SEED_VERSION_FILE"
      [ "$REFRESHED" -gt 0 ] && echo "[chroot] skills marker: $CURRENT_SEED_VERSION → $IMAGE_SEED_VERSION (refreshed $REFRESHED, seeded $SEEDED)"
    fi
  fi

  # Container-view session inventory (for slug-divergence diagnostics)
  if [ -d "${CHROOT_ROOT}/root/.claude/projects" ]; then
    echo "[chroot] Session inventory (chroot view):"
    for slug_dir in "${CHROOT_ROOT}/root/.claude/projects"/*/; do
      [ -d "$slug_dir" ] || continue
      count=$(find "$slug_dir" -maxdepth 1 -name '*.jsonl' 2>/dev/null | wc -l | tr -d ' ')
      echo "[chroot]   $(basename "$slug_dir"): ${count} jsonl files"
    done
  fi

  # Cleanup signal handler: on SIGTERM, umount our binds before exiting so
  # Fly's shutdown doesn't EBUSY on /workspace. Best-effort — chroot exec
  # below replaces this shell, so the trap only fires if exec fails.
  cleanup_mounts() {
    for d in workspace sys proc dev opt sbin bin lib64 lib usr; do
      umount -l "${CHROOT_ROOT}/${d}" 2>/dev/null || true
    done
  }
  trap cleanup_mounts EXIT INT TERM

  echo "[chroot] entering ${CHROOT_ROOT} and exec'ing osborn (from image /usr/local/bin)"
  exec chroot "${CHROOT_ROOT}" env \
    HOME=/root \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    OSBORN_CWD=/workspace \
    OSBORN_API_PORT=8741 \
    NODE_ENV=production \
    OSBORN_IMAGE_VERSION="${OSBORN_IMAGE_VERSION:-}" \
    LIVEKIT_URL="${LIVEKIT_URL:-}" \
    LIVEKIT_API_KEY="${LIVEKIT_API_KEY:-}" \
    LIVEKIT_API_SECRET="${LIVEKIT_API_SECRET:-}" \
    LIVEKIT_ROOM="${LIVEKIT_ROOM:-}" \
    NEXT_PUBLIC_LIVEKIT_URL="${NEXT_PUBLIC_LIVEKIT_URL:-}" \
    DEEPGRAM_API_KEY="${DEEPGRAM_API_KEY:-}" \
    OPENAI_API_KEY="${OPENAI_API_KEY:-}" \
    GOOGLE_API_KEY="${GOOGLE_API_KEY:-}" \
    ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
    RECALL_API_KEY="${RECALL_API_KEY:-}" \
    SMITHERY_API_KEY="${SMITHERY_API_KEY:-}" \
    GROQ_API_KEY="${GROQ_API_KEY:-}" \
    CLAUDE_CODE_OAUTH_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN:-}" \
    /usr/local/bin/osborn
}

# Try chroot setup; on any failure, fall through to legacy boot.
if setup_chroot_mounts 2>&1; then
  run_chrooted
fi

# ============================================================
# === Legacy non-chroot boot path (fallback only) ===
# ============================================================
echo "[sandbox] WARNING: chroot setup failed, falling back to legacy non-chroot boot"

# Claude credential persistence via symlink (legacy)
mkdir -p /workspace/.claude
rm -rf /root/.claude
ln -sf /workspace/.claude /root/.claude

# Onboarding config writes (legacy locations)
echo "$ONBOARDING_JSON" > /root/.claude.json
echo "$ONBOARDING_JSON" > /workspace/.claude.json
mkdir -p /workspace/.claude
echo "$ONBOARDING_JSON" > /workspace/.claude/.config.json
echo "$ONBOARDING_JSON" > /workspace/.claude/claude.json

if [ -f /workspace/.claude/.oauth-token ]; then
  export CLAUDE_CODE_OAUTH_TOKEN="$(cat /workspace/.claude/.oauth-token)"
  echo "[sandbox] (legacy) Restored CLAUDE_CODE_OAUTH_TOKEN from volume"
fi

HOME_SKILLS_DIR=/root/.claude/skills
PKG_SKILLS_DIR=/usr/local/lib/node_modules/osborn/.claude/skills
mkdir -p "$HOME_SKILLS_DIR"
if [ -d "$PKG_SKILLS_DIR" ]; then
  for d in "$PKG_SKILLS_DIR"/*/; do
    [ -d "$d" ] || continue
    NAME=$(basename "$d")
    [ -d "$HOME_SKILLS_DIR/$NAME" ] && continue
    cp -r "$d" "$HOME_SKILLS_DIR/$NAME"
    echo "[sandbox] (legacy) seeded default skill: $NAME"
  done
fi

export HOME=/root
export OSBORN_CWD=/workspace
exec osborn
ENTRYPOINT

RUN chmod +x /entrypoint.sh

CMD ["/entrypoint.sh"]

```
