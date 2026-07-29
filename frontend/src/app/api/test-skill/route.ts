import { NextResponse } from 'next/server'

export async function GET() {
  const skillContent = `# Voice-E2E — browser testing with ears, a mouth, hands and a brain

## SKILL IDENTITY
Name: voice-e2e
Version: 1
Install path: ~/.claude/skills/voice-e2e/SKILL.md
Harness path: ~/voice-e2e-harness/
Landing page: https://www.voice-native.com/test-skill

Agent-driven end-to-end testing for voice and web apps in a REAL browser:
speak into the page's microphone (synthesized on the fly), hear and
transcribe everything it plays back, click around via a natural-language
brain (Stagehand, no selectors), improvise multi-turn conversations, and get
video + audio replays and structured metrics for every run. Works on ANY
website — nothing is injected into the page and no backend access is assumed.

## MANDATORY VERSION CHECK — run FIRST before any test run
\`\`\`bash
SERVED_V=$(curl -sf --max-time 10 https://www.voice-native.com/api/test-skill | grep -m1 '^Version:' | awk '{print $2}')
LOCAL_V=$(grep -m1 '^Version:' ~/.claude/skills/voice-e2e/SKILL.md 2>/dev/null | awk '{print $2}')
if [ -n "$SERVED_V" ] && [ "$SERVED_V" != "$LOCAL_V" ]; then
  curl -sS https://www.voice-native.com/api/test-skill -o ~/.claude/skills/voice-e2e/SKILL.md
  echo "SKILL WAS OUTDATED (local=\${LOCAL_V:-none}, served=$SERVED_V) — updated. STOP and re-read the new instructions, then re-run the harness update in INSTALLATION step 2."
  exit 1
fi
echo "voice-e2e skill \${LOCAL_V:-unknown} is current"
\`\`\`
If this exits non-zero: re-read this file and refresh the harness files
(INSTALLATION step 2) before running anything. Offline → proceed with local.

## INSTALLATION (agent-executable, one time — also the update path)
1. \`mkdir -p ~/.claude/skills/voice-e2e ~/voice-e2e-harness\` and save this
   file to ~/.claude/skills/voice-e2e/SKILL.md if not already there.
2. Download the harness bundle and write every file:
\`\`\`bash
curl -sS https://www.voice-native.com/api/test-skill/bundle -o /tmp/voice-e2e-bundle.json
python3 - << 'EOF'
import json, os
b = json.load(open('/tmp/voice-e2e-bundle.json'))
root = os.path.expanduser('~/voice-e2e-harness')
for rel, content in b['files'].items():
    p = os.path.join(root, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, 'w').write(content)
print(f"harness v{b['version']}: {len(b['files'])} files written to {root}")
EOF
cd ~/voice-e2e-harness && npm install && npx playwright install chromium
\`\`\`
3. Keys (ask the user; put them in the environment or ~/voice-e2e-harness/.env):
   - GOOGLE_API_KEY — REQUIRED. Powers the Stagehand brain (Gemini Flash).
     Get one at https://aistudio.google.com/apikey (free tier works).
   - OPENAI_API_KEY — recommended. Natural TTS mouth + conversation tester.
     Without it the mouth falls back to say/espeak and improvised
     conversations are unavailable.
   - DEEPGRAM_API_KEY — recommended. Lets the harness VERIFY speech by
     transcribing what it heard. Without it audio is recorded but unverified.
   Export before running: \`export OSBORN_ENV_FILE=~/voice-e2e-harness/.env\`

## USAGE — test any website
Point the runner at a target and a scenario:
\`\`\`bash
cd ~/voice-e2e-harness
OSBORN_APP_URL=https://your-app.example \\
OSBORN_SCENARIO=talk-to-agent \\
npx playwright test specs/scenario.spec.ts
\`\`\`
Scenarios are plain YAML in scenarios/ — goal-driven, improvised
conversations plus deterministic steps (act/say/upload/assertScreen). Write
a new .yaml and the runner picks it up. Artifacts per run in test-results/:
video, audio capture, replay-with-audio.webm (muxed), devtools diagnostics,
and metrics appended to results/runs.jsonl.

## DOCTRINE (binding for the supervising agent)
- VERIFY THE MEDIA: after each run, extract frames (ffmpeg -vf fps=1/5) and
  READ them; transcribe audio claims; never report a green assertion without
  checking the replay agrees.
- Site knowledge lives in knowledge/<hostname>/ — cached UI actions
  (self-healing), rules.md (user-taught, binding), site.md (findings). Read
  rules before operating on a site; append what you learn.
- Every run must end gracefully (the runner's outro leaves sessions via the
  UI) and always leave any voice room before exiting.
- The tester uses ONLY frontend senses (screen, audio, DevTools). If YOU have
  backend access to the target, watch it in parallel and correlate.

## CLOUD RUNNER (optional)
The harness ships Dockerfile + fly.toml for a self-stopping Fly.io tester
machine (run-on-start, artifacts to a volume). See fly.toml comments.
`
  return new NextResponse(skillContent, {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}
