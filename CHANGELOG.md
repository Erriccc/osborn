# Osborn Changelog

## What Was Working

### Voice Providers
- **OpenAI Realtime**: Working (greeting, transcription, tool calls)
- **Gemini Live**: Was working before multi-agent refactor

### Known Issues (Current)

1. **Room code not passed correctly** ✅ FIXED in v0.1.3
   - Use: `npm run room <code>` or `npm run dev -- --room <code>`

2. **OpenAI permission speech conflicts** ✅ FIXED in v0.1.3
   - Was: `conversation_already_has_active_response` errors
   - Fix: Track actual agent state, only speak when `listening`

3. **Gemini not responding** ✅ FIXED in v0.1.3
   - Reverted to exact model name from working commit: `gemini-2.5-flash-native-audio-preview-12-2025`
   - Removed experimental options (proactivity, enableAffectiveDialog) that broke it

## Version History

### v0.1.3 (Current)
- **Fixed**: Speech queue now tracks actual agent state (`listening`, `speaking`, etc.)
- **Fixed**: Permissions/status only spoken when agent is truly idle
- **Fixed**: Room code parsing with `npm run room <code>` script
- **Fixed**: Gemini model restored to working config (`gemini-2.5-flash-native-audio-preview-12-2025`)
- Better logging for speech queue debugging

**Frontend UX Improvements:**
- Auto-detect agent connection (no more manual "Agent Connected?" button)
- Persist provider/agent selection in localStorage
- File attachment support (images, code files)
- Improved audio visualization with state badges
- Better waiting screen with live connection status
- Agent sends heartbeat when ready

### v0.1.2
- Multi-agent pool (2 Claude handlers)
- Streaming feedback to voice LLM
- Smart silence mode ("let me know when done")
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
