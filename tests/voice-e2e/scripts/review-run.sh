#!/bin/sh
# Deterministic media review — one command instead of remembered prose.
# Usage: scripts/review-run.sh <clip.mp4> [outdir]
# Extracts frames and prints the evidence contract. The agent must then READ
# the frames (view the images) and state what they show — a green assertion
# is a claim; a read frame is proof.
CLIP="$1"
OUT="${2:-/tmp/bsr-review-$(basename "$CLIP" .mp4)}"
if [ -z "$CLIP" ] || [ ! -f "$CLIP" ]; then
  echo "usage: review-run.sh <clip.mp4> [outdir] — clip not found: $CLIP" >&2
  exit 1
fi
mkdir -p "$OUT"
rm -f "$OUT"/f*.png
ffmpeg -y -loglevel error -i "$CLIP" -vf "fps=1/2" "$OUT/f%03d.png" || {
  # very short clips: grab at least one frame
  ffmpeg -y -loglevel error -i "$CLIP" -frames:v 1 "$OUT/f001.png"
}
N=$(ls "$OUT"/f*.png 2>/dev/null | wc -l | tr -d ' ')
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$CLIP" 2>/dev/null)
echo "clip: $CLIP (${DUR}s) → $N frame(s) in $OUT"
ls "$OUT"/f*.png
echo ""
echo "NOW READ THE FRAMES (view each image), then state in your response:"
echo "  \"Reviewed frames <which> — they show <what actually happened>\""
echo "Only after that line may you report the result. If frames contradict"
echo "the assertion, the run FAILED regardless of green statuses."
