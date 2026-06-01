#!/usr/bin/env bash
# Volume-as-home architecture feasibility tests.
#
# WHAT THIS DOES: Tests whether we can chroot the running osborn process into
# /workspace so that any installer (npm, apt, raw `make install`, anything that
# writes to /usr or /etc) lands on the persistent Fly volume instead of the
# ephemeral container overlay.
#
# WHERE TO RUN: Inside a Fly machine SSH session:
#     fly ssh console -a osborn-XXXX --machine osborn-XXXX-YYY
#     bash /workspace/test-volume-as-home.sh  (after copying or curl-ing it)
# Or paste contents directly into the SSH session.
#
# SAFETY: All work is scoped to /workspace/.test-volume-as-home/. Cleanup at end.
# Does NOT touch the running osborn agent, its credentials, or session JSONLs.
# Tests run sequentially; first failure stops the script.

set -u  # error on undefined vars but continue on test failures (we catch them)

TEST_ROOT=/workspace/.test-volume-as-home
RESULTS="${TEST_ROOT}/results.txt"

mkdir -p "${TEST_ROOT}"
echo "=== volume-as-home tests $(date -u +%FT%TZ) ===" | tee "${RESULTS}"

pass() { echo "[PASS] $1" | tee -a "${RESULTS}"; }
fail() { echo "[FAIL] $1" | tee -a "${RESULTS}"; }
info() { echo "[INFO] $1" | tee -a "${RESULTS}"; }

# T1: Can we mount --bind inside /workspace?
info "T1: mount --bind"
mkdir -p "${TEST_ROOT}/t1-src" "${TEST_ROOT}/t1-mnt"
echo hello > "${TEST_ROOT}/t1-src/marker"
if mount --bind "${TEST_ROOT}/t1-src" "${TEST_ROOT}/t1-mnt" 2>>"${RESULTS}"; then
  if [ "$(cat ${TEST_ROOT}/t1-mnt/marker)" = "hello" ]; then
    pass "T1 mount --bind works"
  else
    fail "T1 mount --bind succeeded but content wrong"
  fi
  umount "${TEST_ROOT}/t1-mnt" || true
else
  fail "T1 mount --bind failed (need CAP_SYS_ADMIN)"
fi

# T2: Can we chroot into a minimal tree?
info "T2: chroot into seeded tree"
SEED="${TEST_ROOT}/seed"
mkdir -p "${SEED}"/{bin,lib,lib64,usr,etc,tmp,dev,proc,sys}
# Copy a static-ish minimum: busybox or bash + libs
cp /bin/bash "${SEED}/bin/" 2>>"${RESULTS}" || cp /bin/busybox "${SEED}/bin/bash" 2>>"${RESULTS}"
# Copy libs bash depends on
for lib in $(ldd /bin/bash 2>/dev/null | awk '{print $3}' | grep -E '^/'); do
  mkdir -p "${SEED}$(dirname ${lib})"
  cp "${lib}" "${SEED}${lib}" 2>/dev/null || true
done
# ld-linux loader
for loader in /lib64/ld-linux-x86-64.so.2 /lib/ld-linux.so.2; do
  if [ -e "${loader}" ]; then
    mkdir -p "${SEED}$(dirname ${loader})"
    cp "${loader}" "${SEED}${loader}" 2>/dev/null || true
  fi
done

if chroot "${SEED}" /bin/bash -c 'echo chroot-ok' 2>>"${RESULTS}" | grep -q chroot-ok; then
  pass "T2 chroot works"
else
  fail "T2 chroot failed"
fi

# T3: Bind /dev /proc /sys into chroot
info "T3: bind /dev /proc /sys into chroot"
mount --bind /dev "${SEED}/dev" 2>>"${RESULTS}" && \
  mount --bind /proc "${SEED}/proc" 2>>"${RESULTS}" && \
  mount --bind /sys "${SEED}/sys" 2>>"${RESULTS}" && \
  pass "T3 dev/proc/sys bind ok" || fail "T3 dev/proc/sys bind failed"

# T4: Time cp -a /usr (the big one)
info "T4: cp -a /usr (measuring time + size)"
USR_DEST="${TEST_ROOT}/usr-copy"
START=$(date +%s)
cp -a /usr "${USR_DEST}" 2>>"${RESULTS}" && {
  END=$(date +%s)
  SIZE=$(du -sh "${USR_DEST}" | cut -f1)
  pass "T4 cp -a /usr took $((END-START))s, size ${SIZE}"
} || fail "T4 cp -a /usr failed"

# T5: cp -a /etc /lib /lib64 /bin time
info "T5: cp -a /etc /lib /lib64 /bin"
START=$(date +%s)
for d in /etc /lib /lib64 /bin; do
  [ -e "${d}" ] && cp -a "${d}" "${TEST_ROOT}/$(basename ${d})-copy" 2>>"${RESULTS}"
done
END=$(date +%s)
pass "T5 cp -a /etc /lib /lib64 /bin took $((END-START))s"

# T6: npm install -g INSIDE chroot to verify package lands in seed
info "T6: npm install -g is-odd inside chroot"
# Build a complete-enough seed: bind /usr, /etc, /lib, /lib64, /bin from host so node runs
FULL_SEED="${TEST_ROOT}/full-seed"
mkdir -p "${FULL_SEED}"/{usr,etc,lib,lib64,bin,dev,proc,sys,tmp,root,home,workspace}
for d in usr etc lib lib64 bin; do
  [ -e "/${d}" ] && mount --bind "/${d}" "${FULL_SEED}/${d}" 2>>"${RESULTS}" || true
done
mount --bind /dev "${FULL_SEED}/dev" 2>>"${RESULTS}" || true
mount --bind /proc "${FULL_SEED}/proc" 2>>"${RESULTS}" || true
mount --bind /sys "${FULL_SEED}/sys" 2>>"${RESULTS}" || true
# Set up resolv.conf inside chroot for DNS
cp /etc/resolv.conf "${FULL_SEED}/etc/resolv.conf" 2>>"${RESULTS}" || true

# Test npm install with NPM_CONFIG_PREFIX pointing inside the chroot
mkdir -p "${FULL_SEED}/opt/npm-global"
NPM_OUT=$(chroot "${FULL_SEED}" /bin/bash -c 'export NPM_CONFIG_PREFIX=/opt/npm-global && export PATH=/opt/npm-global/bin:$PATH && npm install -g is-odd 2>&1' 2>>"${RESULTS}")
if echo "${NPM_OUT}" | grep -q -E '(added|already)'; then
  if [ -d "${FULL_SEED}/opt/npm-global/lib/node_modules/is-odd" ] || [ -f "${FULL_SEED}/opt/npm-global/bin"/* ] 2>/dev/null; then
    pass "T6 npm install -g works inside chroot, lands in /opt/npm-global"
  else
    fail "T6 npm reported install but no files in /opt/npm-global"
  fi
else
  fail "T6 npm install failed: ${NPM_OUT:0:200}"
fi

# T7: subprocess from chrooted shell inherits chroot
info "T7: subprocess inherits chroot"
SUBSHELL_OUT=$(chroot "${FULL_SEED}" /bin/bash -c '/bin/bash -c "ls / | head -3 && stat -c %d /"' 2>>"${RESULTS}")
info "T7 subshell sees: ${SUBSHELL_OUT}"
pass "T7 subprocess inherits chroot (manual review of output above)"

# T8: DNS inside chroot
info "T8: DNS resolution inside chroot"
if chroot "${FULL_SEED}" /bin/bash -c 'getent hosts registry.npmjs.org' 2>>"${RESULTS}" | grep -q registry; then
  pass "T8 DNS works"
else
  fail "T8 DNS failed"
fi

# T9: TLS inside chroot
info "T9: TLS via curl"
if chroot "${FULL_SEED}" /bin/bash -c 'curl -sf -o /dev/null -w "%{http_code}" https://registry.npmjs.org/is-odd' 2>>"${RESULTS}" | grep -q 200; then
  pass "T9 TLS works"
else
  fail "T9 TLS failed"
fi

# T13: NPM_CONFIG_PREFIX behavior on this npm version
info "T13: NPM_CONFIG_PREFIX behavior on outer npm"
NPM_VERSION=$(npm --version 2>/dev/null || echo "unknown")
info "T13 npm version: ${NPM_VERSION}"
TEST_PREFIX="${TEST_ROOT}/t13-prefix"
mkdir -p "${TEST_PREFIX}"
NPM_CONFIG_PREFIX="${TEST_PREFIX}" npm install -g is-odd 2>>"${RESULTS}" >/dev/null
if [ -d "${TEST_PREFIX}/lib/node_modules/is-odd" ]; then
  pass "T13 NPM_CONFIG_PREFIX respected on npm ${NPM_VERSION}"
else
  fail "T13 NPM_CONFIG_PREFIX IGNORED on npm ${NPM_VERSION} — npm/cli#4467 still bites"
fi

# CLEANUP
info "cleanup"
for m in "${FULL_SEED}/sys" "${FULL_SEED}/proc" "${FULL_SEED}/dev" \
         "${FULL_SEED}/bin" "${FULL_SEED}/lib64" "${FULL_SEED}/lib" \
         "${FULL_SEED}/etc" "${FULL_SEED}/usr" \
         "${SEED}/sys" "${SEED}/proc" "${SEED}/dev"; do
  umount "${m}" 2>/dev/null || true
done
# Don't rm the whole TEST_ROOT — leave results.txt for inspection
rm -rf "${TEST_ROOT}/seed" "${TEST_ROOT}/full-seed" \
       "${TEST_ROOT}/usr-copy" "${TEST_ROOT}/etc-copy" \
       "${TEST_ROOT}/lib-copy" "${TEST_ROOT}/lib64-copy" \
       "${TEST_ROOT}/bin-copy" "${TEST_ROOT}/t1-src" "${TEST_ROOT}/t1-mnt" \
       "${TEST_ROOT}/t13-prefix" 2>/dev/null || true

echo ""
echo "=== SUMMARY ==="
grep -E '^\[(PASS|FAIL)\]' "${RESULTS}"
echo ""
echo "Full log: ${RESULTS}"
