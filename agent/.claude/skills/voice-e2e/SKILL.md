# Voice-E2E — browser testing with ears, a mouth, hands and a brain

## SKILL IDENTITY
Name: voice-e2e
Version: 1 (packaged seed — the served copy at the URL below is source of truth)
Served from: https://www.voice-native.com/api/test-skill
Landing page: https://www.voice-native.com/test-skill

Agent-driven end-to-end testing for voice and web apps in a REAL browser:
speak into the page's mic (synthesized on the fly), hear and transcribe what
it plays back, click via a natural-language brain, improvise conversations,
and get video + audio replays per run. Works on any website.

## UPDATE CHECK (notify-first, run before major test/research runs)
This packaged copy ships with every machine and may lag the served version.
Check, then NOTIFY the user before updating — never silently force:

```bash
SERVED_V=$(curl -sf --max-time 10 https://www.voice-native.com/api/test-skill | grep -m1 '^Version:' | awk '{print $2}')
LOCAL_V=$(grep -m1 '^Version:' ~/.claude/skills/voice-e2e/SKILL.md 2>/dev/null | awk '{print $2}')
[ -n "$SERVED_V" ] && [ "$SERVED_V" != "$LOCAL_V" ] && echo "UPDATE AVAILABLE: voice-e2e v${LOCAL_V:-none} -> v$SERVED_V — tell the user what's new and ask before updating (curl -sS https://www.voice-native.com/api/test-skill -o ~/.claude/skills/voice-e2e/SKILL.md), then refresh the harness bundle per the served INSTALLATION."
```

If the user approves (or has pre-approved auto-updates), update the skill
file AND re-run the served INSTALLATION step 2 (harness bundle refresh) so
the accompanying files stay in lockstep with the skill.

## FIRST USE
Fetch the served copy and follow its INSTALLATION section — it materializes
the harness (~/voice-e2e-harness/), installs dependencies, and asks the user
for a GOOGLE_API_KEY (required, Gemini brain) plus optional OPENAI/DEEPGRAM
keys for the voice mouth and audible verification.
