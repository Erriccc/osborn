#!/bin/sh
# Fly tester-machine entrypoint: run the requested spec, persist artifacts to
# the volume, exit 0 so the machine stops (restart policy "never" — a failing
# TEST must not put the machine in a restart loop; the result lives in the
# artifacts + exit-code file).
echo "[fly-run] harness version: ${HARNESS_SHA:-unknown}"
# Anti-accumulation: the volume is small (~1GB). Keep only the last 10 spec-run
# artifact folders; engine runs prune themselves (OSBORN_KEEP_RUNS in-engine).
if [ -d /data/runs ]; then
  ls -1 /data/runs | sort | head -n -10 | while read -r d; do rm -rf "/data/runs/$d"; done
fi
# ENGINE MODE: OSBORN_ENGINE=1 runs the long-lived session engine instead of a
# one-shot spec. The machine stays up until /end (or fly machine stop). Set
# OSBORN_ENGINE_TOKEN (fly secrets) — the control port is publicly exposed.
if [ -n "$OSBORN_ENGINE" ]; then
  echo "[fly-run] session-engine mode (long-running; control :8781, stream :8080)"
  # FULL-WINDOW CAPTURE: start a virtual display so Chrome runs HEADFUL and
  # the stream shows the real browser (tab strip, URL bar, navigation).
  # Opt out with OSBORN_NO_DISPLAY=1 (falls back to headless CDP capture).
  if [ -z "$OSBORN_NO_DISPLAY" ]; then
    SIZE="${OSBORN_DISPLAY_SIZE:-1280x800}"
    Xvfb :99 -screen 0 "${SIZE}x24" -nolisten tcp > /dev/null 2>&1 &
    sleep 1
    export DISPLAY=:99
    export OSBORN_DISPLAY=:99
    # Window manager — REQUIRED for reliable window raise/focus on the
    # virtual display (bringToFront no-ops without one and the capture can
    # show a stale window).
    command -v openbox > /dev/null && openbox > /dev/null 2>&1 &
    echo "[fly-run] Xvfb + openbox up on :99 (${SIZE}) — full-window capture enabled"
  fi
  exec npx tsx scripts/session-engine.ts
fi
SPEC="${OSBORN_TEST_SPEC:-specs/stagehand-conversation.spec.ts}"
echo "[fly-run] running $SPEC"
npx playwright test "$SPEC"
code=$?
echo "[fly-run] exit code: $code"
if [ -d /data ]; then
  ts=$(date -u +%Y%m%d-%H%M%S)
  dest="/data/runs/$ts"
  mkdir -p "$dest"
  cp -r test-results "$dest/" 2>/dev/null
  cp -r playwright-report "$dest/" 2>/dev/null
  cp -r results "$dest/" 2>/dev/null
  echo "$code" > "$dest/exit-code"
  echo "[fly-run] artifacts stored in $dest"
  # rolling metrics file across all runs
  mkdir -p /data
  cat results/runs.jsonl >> /data/history.jsonl 2>/dev/null
fi
# Optional: stay alive briefly after the run so artifacts can be pulled via
# fly ssh sftp before the machine stops (OSBORN_HOLD_AFTER=seconds).
if [ -n "$OSBORN_HOLD_AFTER" ]; then
  echo "[fly-run] holding machine open for ${OSBORN_HOLD_AFTER}s for artifact retrieval"
  sleep "$OSBORN_HOLD_AFTER"
fi
exit 0
