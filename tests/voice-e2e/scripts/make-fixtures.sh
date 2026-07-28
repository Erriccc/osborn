#!/bin/sh
# Generate spoken WAV fixtures for the fake-mic harness.
#
# Chromium's --use-file-for-fake-audio-capture wants WAV (PCM). On macOS we
# synthesize with `say` (AIFF) then convert with afconvert (both built in).
# On Linux CI, espeak-ng + sox produce the same thing.
#
# Each fixture starts with ~1s of silence so the connection settles before
# speech begins (Deepgram VAD needs the utterance, not the join click).
set -e
cd "$(dirname "$0")/../fixtures"

gen() {
  name=$1; text=$2; pad=${3:-5}
  if command -v say >/dev/null 2>&1; then
    say -o "_$name.aiff" "$text"
    afconvert -f WAVE -d LEI16@44100 -c 1 "_$name.aiff" "_$name.wav"
    rm -f "_$name.aiff"
  elif command -v espeak-ng >/dev/null 2>&1; then
    espeak-ng -w "_$name.wav" "$text"
  else
    echo "need macOS 'say' or espeak-ng" >&2; exit 1
  fi
  # REAL leading silence — the fake mic starts playing at getUserMedia-open,
  # several seconds before LiveKit publish + Deepgram are actually listening.
  # (Learned the hard way: without this pad, only the last word arrives.)
  python3 - "$name" "$pad" << 'PYEOF'
import wave, sys
name, pad = sys.argv[1], float(sys.argv[2])
src = wave.open(f"_{name}.wav", "rb")
params = src.getparams()
silence = b"\x00" * int(params.framerate * pad) * params.sampwidth * params.nchannels
out = wave.open(f"{name}.wav", "wb")
out.setparams(params)
out.writeframes(silence)
out.writeframes(src.readframes(src.getnframes()))
out.close(); src.close()
PYEOF
  rm -f "_$name.wav"
  echo "built $name.wav (${pad}s lead-in)"
}

gen hello-question   "Osborn, this is an automated voice test, code purple elephant. Please reply with the single word pineapple." 6
gen followup-recall  "What word did I just ask you to say?"
gen barge-in-long    "Tell me a very long story about the history of computers, with as much detail as possible."

echo "fixtures ready: $(ls *.wav | tr '\n' ' ')"
