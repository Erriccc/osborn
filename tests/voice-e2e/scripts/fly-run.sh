#!/bin/sh
# Fly tester-machine entrypoint: run the requested spec, persist artifacts to
# the volume, exit 0 so the machine stops (restart policy "never" — a failing
# TEST must not put the machine in a restart loop; the result lives in the
# artifacts + exit-code file).
SPEC="${OSBORN_TEST_SPEC:-specs/stagehand-conversation.spec.ts}"
echo "[fly-run] harness version: ${HARNESS_SHA:-unknown}"
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
