# Osborn Changelog

## What Was Working

### Voice Providers
- **OpenAI Realtime**: Working (greeting, transcription, tool calls)
- **Gemini Live**: Was working before multi-agent refactor

### Known Issues (Current)

1. **Room code not passed correctly**
   - User runs: `npm run dev --room e4jm4f`
   - Should run: `npm run dev -- --room e4jm4f` (note the `--`)
   - Room shows as `undefined` in logs

2. **OpenAI permission speech conflicts**
   - Error: `conversation_already_has_active_response`
   - Cause: Trying to speak permission request while model is already speaking
   - Fix needed: Queue permission requests or wait for active response

3. **Gemini not responding**
   - Session connects but model doesn't speak
   - `generateReply` times out (known LiveKit bug #2165)
   - Instruction-based greeting not triggering

## Version History

### v0.1.2 (Current)
- Multi-agent pool (2 Claude handlers)
- Streaming feedback to voice LLM
- Smart silence mode ("let me know when done")
- Permission speaking (broken for OpenAI)
- Gemini greeting via instructions (not working)

### v0.1.1
- Tool logging to terminal
- All tools require permission by default
- npm package setup (`npx osborn`)

### v0.1.0
- Initial release
- OpenAI Realtime + Gemini Live support
- Claude Code + Codex backend options
- Room code system for hosted frontend
- Basic permission handling via UI buttons
