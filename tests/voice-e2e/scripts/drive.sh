#!/usr/bin/env bash
# ATOMIC ENGINE DRIVER — one command = action + media, inseparable.
#
# The diagnostic (2026-08-05) proved raw curl makes media "sometimes": the
# response only carries a Fly-volume PATH, so relaying the clip/screenshot is
# 4 separate skippable steps. Under any pressure the agent skips them.
#
# drive.sh fires the action AND downloads the clip + screenshot to predictable
# local files AND prints exactly what to review and send — as ONE operation.
# It EXITS NONZERO if no media came back, so "action succeeded, media missing"
# is impossible to report.
#
#   drive.sh act  "click the Logs label"
#   drive.sh say  "what color is the sky?"
#   drive.sh tab  '{"op":"open","url":"https://x.com","viewport":"mobile"}'
#   drive.sh status | drive.sh eval "document.title" | drive.sh journey '{"op":"start","name":"x"}'
#
# Config (env): BSR_ENGINE (default https://osborn-voice-e2e.fly.dev:8781),
#   BSR_TOKEN (or ~/osborn-backups/voice-e2e-engine-token.txt), BSR_IP
#   (Fly shared v4, default 66.241.124.164 — Machines-API apps need --resolve),
#   BSR_OUT (default /tmp/bsr).
set -euo pipefail

ENGINE="${BSR_ENGINE:-https://osborn-voice-e2e.fly.dev:8781}"
TOKEN="${BSR_TOKEN:-$(cat ~/osborn-backups/voice-e2e-engine-token.txt 2>/dev/null || true)}"
HOSTPORT="${ENGINE#https://}"; HOSTPORT="${HOSTPORT#http://}"
HOST="${HOSTPORT%%:*}"; PORT="${HOSTPORT##*:}"; [ "$PORT" = "$HOST" ] && PORT=8781
IP="${BSR_IP:-66.241.124.164}"
OUT="${BSR_OUT:-/tmp/bsr}"; mkdir -p "$OUT"
CMD="${1:-}"; ARG="${2:-}"

# Force the Fly IP so DNS/edge quirks can't break it; drop --resolve for localhost.
RESOLVE=(--resolve "$HOST:$PORT:$IP")
[[ "$HOST" == "127.0.0.1" || "$HOST" == "localhost" ]] && RESOLVE=()
DRIVER="${BSR_DRIVER:-$(whoami 2>/dev/null || echo default)}"
# nounset-safe empty-array expansion (bash 3.2 on macOS errors on "${RESOLVE[@]}" when empty)
PROFILE="${BSR_PROFILE:-}"  # your own browser profile: sign in once, kept across restarts
cc() { curl -s ${RESOLVE[@]+"${RESOLVE[@]}"} -H "x-engine-token: $TOKEN" -H "x-driver-id: $DRIVER" ${PROFILE:+-H "x-profile: $PROFILE"} "$@"; }

case "$CMD" in
  act|say)
    field="instruction"; [ "$CMD" = "say" ] && field="text"
    body=$(python3 -c "import json,sys; print(json.dumps({'$field': sys.argv[1]}))" "$ARG")
    # #120 RE-ATTACH: a mid-journey engine restart drops the connection at Say,
    # so the POST returns an empty/gateway 502 with no task. For `say` only,
    # if the failure looks TRANSIENT (empty/gateway — NOT a structured engine
    # error like no_mic/speak_failed), wait for the engine to wake and retry
    # ONCE. The engine recovers the journey across the restart (journey-state.ts),
    # so the retry lands in the SAME journey. Bounded; opt out with BSR_SAY_REATTACH=0.
    attempts=1; { [ "$CMD" = "say" ] && [ "${BSR_SAY_REATTACH:-1}" != "0" ]; } && attempts=2
    resp=""; n=""
    for tryn in $(seq 1 "$attempts"); do
      resp=$(cc --max-time 120 -X POST -H 'Content-Type: application/json' "$ENGINE/$CMD" -d "$body" || true)
      n=$(printf '%s' "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('window',{}).get('n',''))" 2>/dev/null || true)
      [ -n "$n" ] && break
      { [ "$CMD" = "say" ] && [ "$tryn" -lt "$attempts" ]; } || break
      # Structured engine error (ok:false + code) → settled app failure, don't re-attach.
      struct=$(printf '%s' "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print('1' if d.get('ok') is False and d.get('code') else '')" 2>/dev/null || true)
      [ -n "$struct" ] && break
      echo "  ⟳ Say returned no task (transient — likely an engine restart at Say, #120); waiting for the engine to wake, then re-attaching to the recovered journey…" >&2
      for _w in 1 2 3 4 5 6 7 8 9 10 11 12; do
        sleep 5
        st=$(cc --max-time 15 "$ENGINE/status" 2>/dev/null || true)
        ready=$(printf '%s' "$st" | python3 -c "import sys,json; d=json.load(sys.stdin); print('1' if d.get('brain')=='ready' else '')" 2>/dev/null || true)
        [ -n "$ready" ] && break
      done
    done
    heard=$(printf '%s' "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('heard') or '')" 2>/dev/null || true)
    nag=$(printf '%s' "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('nag') or '')" 2>/dev/null || true)
    if [ -z "$n" ]; then echo "DRIVE FAILED — no task number in response:" >&2; echo "$resp" | head -c 400 >&2; exit 3; fi
    clip="$OUT/task-$n.mp4"; shot="$OUT/task-$n.jpg"
    # Media is not optional — retry the clip fetch (a single transient 1/10
    # miss in the 10-step test was just a flaky download, the clip existed).
    for attempt in 1 2 3; do
      cc --max-time 90 "$ENGINE/clip?n=$n" -o "$clip" 2>/dev/null || true
      file "$clip" 2>/dev/null | grep -q "MP4\|ISO Media" && break
      sleep 2
    done
    cc --max-time 30 "$ENGINE/artifact?n=$n" -o "$shot" 2>/dev/null || true
    file "$clip" 2>/dev/null | grep -q "MP4\|ISO Media" || { echo "DRIVE FAILED — no video for task $n after 3 tries (engine: $(head -c 160 "$clip" 2>/dev/null))" >&2; exit 4; }
    file "$shot" 2>/dev/null | grep -qi "jpeg\|jpg" || rm -f "$shot"
    echo "task $n [$CMD]: ok"
    [ -n "$heard" ] && echo "  heard: $heard"
    [ -n "$nag" ] && echo "  ⚠ NAG: $nag"
    cont=$(printf '%s' "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('contention') or '')" 2>/dev/null || true)
    [ -n "$cont" ] && echo "  $cont"
    echo "REVIEW+SEND these to the user (both exist — this command guarantees it):"
    echo "  VIDEO: $clip"
    [ -f "$shot" ] && echo "  FRAME: $shot"
    ;;
  status|tasks|runs|logs)  cc --max-time 20 "$ENGINE/$CMD" ;;
  clip|artifact)           cc --max-time 60 "$ENGINE/$CMD?n=$ARG" -o "$OUT/pull-$ARG.${CMD/clip/mp4}"; echo "$OUT/pull-$ARG" ;;
  journey|tab|eval|brain|recover|hear|shot|end)
    # POST endpoints taking a JSON body. NOTE: `${ARG:-{}}` is a bash TRAP —
    # it parses as (ARG or "{") then a literal "}", appending an extra brace
    # → `{"op":"list"}}` → invalid JSON → engine sees no op (the real cause of
    # the "op must be start|end|list" bug). Use an explicit default instead.
    BODY="$ARG"; [ -z "$BODY" ] && BODY='{}'
    cc --max-time 60 -X POST -H 'Content-Type: application/json' "$ENGINE/$CMD" --data "$BODY" ;;
  *)
    echo "usage: drive.sh {act|say|tab|eval|journey|status|tasks|logs|runs|hear|recover|end} <arg>" >&2
    echo "  act/say download clip+frame to \$BSR_OUT and print what to send — atomically." >&2
    exit 1 ;;
esac
