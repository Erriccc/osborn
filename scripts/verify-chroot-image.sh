#!/usr/bin/env bash
# Sacrificial verification for the chroot architecture (Phase 1+2+3).
#
# Spins a temporary Fly Machine on a freshly-built image label, waits for
# health, then runs a battery of checks via `fly ssh console`. Reports
# pass/fail per check. Tears down the test machine when done (or on Ctrl-C).
#
# Usage:
#   IMAGE_LABEL=0.9.47-chroot-test bash scripts/verify-chroot-image.sh
#
# Prereq: image already built + pushed to registry.fly.io/osborn-sandbox/agent:${IMAGE_LABEL}

set -u

IMAGE_LABEL="${IMAGE_LABEL:-0.9.47-chroot-test}"
TEST_APP="${TEST_APP:-osborn-chroot-verify}"
IMAGE="registry.fly.io/osborn-sandbox/agent:${IMAGE_LABEL}"
REGION="${REGION:-iad}"

RESULTS=()
pass() { echo "[PASS] $1"; RESULTS+=("PASS|$1"); }
fail() { echo "[FAIL] $1"; RESULTS+=("FAIL|$1"); }
info() { echo "[INFO] $1"; }

cleanup() {
  info "Tearing down test machine + volume..."
  fly machines list -a "$TEST_APP" --json 2>/dev/null | \
    awk -F'"' '/"id":/ {print $4}' | \
    while read -r mid; do fly machines destroy "$mid" --force -a "$TEST_APP" 2>&1 | head -2; done
  fly volumes list -a "$TEST_APP" --json 2>/dev/null | \
    awk -F'"' '/"id":/ {print $4}' | \
    while read -r vid; do fly volumes destroy "$vid" --yes -a "$TEST_APP" 2>&1 | head -2; done
}
trap cleanup EXIT INT TERM

# Step 0: ensure test app exists
if ! fly status -a "$TEST_APP" >/dev/null 2>&1; then
  info "Creating test app $TEST_APP..."
  fly apps create "$TEST_APP" --org personal 2>&1 | head -5
  fly ips allocate-v4 --shared -a "$TEST_APP" 2>&1 | head -3 || true
fi

# Step 1: create fresh volume
info "Creating test volume..."
VOL_OUTPUT=$(fly volumes create workspace -a "$TEST_APP" -r "$REGION" -s 5 --yes 2>&1)
VOL_ID=$(echo "$VOL_OUTPUT" | awk -F'"' '/^ *"id":/ {print $4; exit}' | head -1)
[ -z "$VOL_ID" ] && VOL_ID=$(echo "$VOL_OUTPUT" | grep -oE 'vol_[a-z0-9]+' | head -1)
if [ -z "$VOL_ID" ]; then
  echo "Could not parse volume ID from: $VOL_OUTPUT"
  fail "T0 volume creation"
  exit 1
fi
pass "T0 volume $VOL_ID created"

# Step 2: spin machine
info "Spinning machine with image $IMAGE..."
MACHINE_JSON=$(fly machines run "$IMAGE" \
  -a "$TEST_APP" \
  -r "$REGION" \
  --volume "$VOL_ID:/workspace" \
  --port 8741:8741/tcp \
  --vm-size performance-1x \
  --vm-memory 2048 \
  --metadata fly_platform_version=v2 \
  --autostop=off \
  --json 2>&1)
MACHINE_ID=$(echo "$MACHINE_JSON" | awk -F'"' '/^ *"id":/ {print $4; exit}' | head -1)
if [ -z "$MACHINE_ID" ]; then
  echo "Could not parse machine ID. Full output:"
  echo "$MACHINE_JSON"
  fail "T1 machine creation"
  exit 1
fi
pass "T1 machine $MACHINE_ID started"

# Step 3: wait for machine state=started
info "Waiting for machine state=started..."
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  STATE=$(fly machines status "$MACHINE_ID" -a "$TEST_APP" --json 2>/dev/null | awk -F'"' '/"state":/ {print $4; exit}')
  if [ "$STATE" = "started" ]; then
    pass "T2 machine state=started after ${i}x retries"
    break
  fi
  echo "  ($i) state=$STATE..."
  sleep 5
done

# Step 4: wait for /health
info "Polling /health for up to 90s..."
HEALTH_OK=""
for i in $(seq 1 18); do
  if curl -sf -m 5 "https://${TEST_APP}.fly.dev/health" -o /tmp/health-out 2>/dev/null; then
    HEALTH_OK="yes"
    pass "T3 /health responding after ~$((i*5))s"
    cat /tmp/health-out | head -10
    break
  fi
  echo "  ($i/18) /health not responding yet..."
  sleep 5
done
if [ -z "$HEALTH_OK" ]; then
  fail "T3 /health never responded"
fi

# Step 5: SSH-based checks
SSH() {
  fly ssh console -a "$TEST_APP" -C "$1" 2>&1 | grep -v "^Connecting to "
}

info "T4: verify chroot marker file exists"
if SSH "test -f /etc/osborn-chroot-aware && echo CHROOT_AWARE"; then
  pass "T4 image is chroot-aware"
else
  fail "T4 image is NOT chroot-aware (missing /etc/osborn-chroot-aware)"
fi

info "T5: verify seed tarball baked into image"
SEED_INFO=$(SSH "ls -la /opt/osborn-seed.tar.gz 2>&1 | head -1")
if echo "$SEED_INFO" | grep -q "osborn-seed.tar.gz"; then
  pass "T5 seed tarball present: $SEED_INFO"
else
  fail "T5 seed tarball missing — Phase 3 bake step skipped"
fi

info "T6: verify chroot bind-mounts attached"
MOUNTS=$(SSH "mountpoint -q /workspace/root-chroot/usr && echo USR_BOUND; mountpoint -q /workspace/root-chroot/workspace && echo WORKSPACE_BOUND")
if echo "$MOUNTS" | grep -q USR_BOUND && echo "$MOUNTS" | grep -q WORKSPACE_BOUND; then
  pass "T6 chroot bind-mounts attached"
else
  fail "T6 chroot bind-mounts NOT attached. Got: $MOUNTS"
fi

info "T7: verify osborn binary on volume"
OSBORN_LOC=$(SSH "ls -la /workspace/root-chroot/opt/npm-global/bin/osborn 2>&1 | head -1")
if echo "$OSBORN_LOC" | grep -q "osborn"; then
  pass "T7 osborn binary on volume: $OSBORN_LOC"
else
  fail "T7 osborn binary NOT on volume. Got: $OSBORN_LOC"
fi

info "T8: verify osborn --version inside chroot"
VERSION=$(SSH "chroot /workspace/root-chroot env PATH=/opt/npm-global/bin:/usr/bin:/bin /opt/npm-global/bin/osborn --version 2>&1 | tail -1")
if echo "$VERSION" | grep -qE '[0-9]+\.[0-9]+\.[0-9]+'; then
  pass "T8 osborn reports version: $VERSION"
else
  fail "T8 osborn --version failed. Got: $VERSION"
fi

info "T9: verify chroot marker on volume"
MARKER=$(SSH "ls -la /workspace/.chroot-seeded 2>&1")
if echo "$MARKER" | grep -q ".chroot-seeded"; then
  pass "T9 first-boot marker present"
else
  fail "T9 first-boot marker missing"
fi

info "T10: verify in-place update path (re-install same version)"
RESULT=$(SSH "chroot /workspace/root-chroot env NPM_CONFIG_PREFIX=/opt/npm-global PATH=/opt/npm-global/bin:/usr/bin:/bin npm install -g osborn@${OSBORN_VERSION:-0.9.46} 2>&1 | tail -5")
if echo "$RESULT" | grep -qE '(added|already|updated|changed)'; then
  pass "T10 in-place npm install runs in chroot: $(echo "$RESULT" | head -1)"
else
  fail "T10 in-place npm install failed: $RESULT"
fi

echo ""
echo "=== SUMMARY ==="
for r in "${RESULTS[@]}"; do echo "$r" | tr '|' ' '; done
echo ""
PASS_COUNT=$(printf '%s\n' "${RESULTS[@]}" | grep -c PASS)
FAIL_COUNT=$(printf '%s\n' "${RESULTS[@]}" | grep -c FAIL)
echo "${PASS_COUNT} passed, ${FAIL_COUNT} failed"
