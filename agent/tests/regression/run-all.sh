#!/usr/bin/env bash
# Regression gate for the fast-brain / meeting-mode / steering-stop contracts
# (run BEFORE and AFTER any noise-gate change touching these paths).
#
# IMPORTANT: some src modules write to $HOME at import time (claude-llm.ts
# writes ~/.claude/settings.json at module load). Every suite that imports src
# modules therefore runs under a SANDBOXED $HOME (and the suites additionally
# self-sandbox via sandboxHome() as a second line of defense).
#
# Usage: bash agent/tests/regression/run-all.sh
set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT="$(cd "$DIR/../.." && pwd)"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/osborn-regress-home.XXXXXX")"

cd "$AGENT"
fail=0
run() {
  local name="$1"; shift
  echo
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "SUITE: $name"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  if ! "$@"; then
    fail=1
    echo "SUITE FAILED: $name"
  fi
}

# Source-anchored suites (read-only, no imports of src modules)
run "static-checks (ported)"   npx tsx "$DIR/static-checks.ts"
run "steering-stop"            npx tsx "$DIR/steering-stop.ts"
run "frontend-voiceroom"       npx tsx "$DIR/frontend-voiceroom.ts"

# Behavioral suites — sandboxed HOME (module-load writes to ~/.claude)
run "behavior-registry (ported)" env HOME="$SANDBOX" npx tsx "$DIR/behavior-registry.ts"
run "fastbrain-contract"         env HOME="$SANDBOX" npx tsx "$DIR/fastbrain-contract.ts"
run "meeting-mode"               env HOME="$SANDBOX" npx tsx "$DIR/meeting-mode.ts"
run "pipeline-direct-contract"   env HOME="$SANDBOX" npx tsx "$DIR/pipeline-direct-contract.ts"
run "noise-gate"                 env HOME="$SANDBOX" npx tsx "$DIR/noise-gate.ts"
run "dashboard-preview"          env HOME="$SANDBOX" npx tsx "$DIR/dashboard-preview.ts"
run "keep-warm"                  env HOME="$SANDBOX" npx tsx "$DIR/keep-warm.ts"
run "connect-overlap"            env HOME="$SANDBOX" npx tsx "$DIR/connect-overlap.ts"
run "session-manifest"           env HOME="$SANDBOX" npx tsx "$DIR/session-manifest.ts"
run "mem-recycle"                env HOME="$SANDBOX" npx tsx "$DIR/mem-recycle.ts"

# Type-level pins — tsx strips types without checking, so these MUST go through tsc
run "type-pins (tsc)"          npx tsc --noEmit -p "$DIR/tsconfig.json"

# Whole-project typecheck (the suites must never be the only thing that compiles)
run "project typecheck (tsc)"  npx tsc --noEmit

echo
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$fail" -eq 0 ]; then
  echo "ALL REGRESSION SUITES GREEN"
else
  echo "REGRESSION FAILURES — see suites above"
fi
rm -rf "$SANDBOX"
exit "$fail"
