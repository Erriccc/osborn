# Claude Code Voice Extension - Product Requirements Document

## Project Overview

**Goal**: Add voice input/output capabilities to the Claude Code Chat VS Code extension, enabling hands-free interaction with Claude Code CLI.

**Status**: ✅ **COMPLETE** - Native voice recording and TTS playback working!

**Credits**: Based on [claude-code-chat](https://github.com/andrepimenta/claude-code-chat) by Andre Pimenta, enhanced with voice capabilities

---

## Features

### Voice Input (Speech-to-Text)
- 🎤 **Native microphone recording** - No browser popup needed!
- 🔇 **Automatic silence detection** - Stops recording when you stop speaking
- 🌐 **Browser fallback** - Works in GitHub Codespaces and VS Code Web
- ⚡ **OpenAI Whisper** or local Whisper.cpp for transcription

### Voice Output (Text-to-Speech)
- 🔊 **Native audio playback** - Bypasses webview autoplay restrictions
- 🗣️ **Multiple voices** - alloy, echo, fable, onyx, nova, shimmer
- 🏠 **Local TTS option** - Kokoro TTS for offline use

### No External Dependencies!
- ❌ ~~Sox~~ - Not required
- ❌ ~~FFmpeg~~ - Not required
- ❌ ~~arecord~~ - Not required
- ✅ Everything bundled in npm package

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                     VS Code Extension Host (Node.js)                 │
│                                                                      │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐  │
│  │  VoiceRecorder  │  │  VoiceService   │  │  ClaudeChatProvider │  │
│  │  (Audify)       │  │  (STT/TTS API)  │  │  (Claude CLI)       │  │
│  │                 │  │                 │  │                     │  │
│  │ • RtAudio native│  │ • Whisper API   │  │ • Message handling  │  │
│  │ • Auto sample   │  │ • TTS API       │  │ • Session mgmt      │  │
│  │   rate detect   │  │ • Local support │  │ • Permissions       │  │
│  │ • Silence VAD   │  │                 │  │                     │  │
│  └────────┬────────┘  └────────┬────────┘  └──────────┬──────────┘  │
│           │                    │                      │              │
│           │    Audio Buffer    │    Transcript        │              │
│           └────────────────────┴──────────────────────┘              │
│                                                                      │
│  ┌─────────────────┐  ┌──────────────────────────────────────────┐  │
│  │  sound-play     │  │  VoicePopupServer (Fallback)             │  │
│  │  (TTS Playback) │  │  • Browser popup for Codespaces/Web      │  │
│  │                 │  │  • getUserMedia for mic access           │  │
│  │ • afplay (Mac)  │  │  • HTTP server on localhost:9876         │  │
│  │ • aplay (Linux) │  │                                          │  │
│  │ • PowerShell    │  │                                          │  │
│  └─────────────────┘  └──────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## File Structure

```
claude-code-voice/
├── src/
│   ├── extension.ts          # Main extension entry point
│   ├── script.ts             # Webview UI logic
│   ├── ui.ts                 # Webview HTML generation
│   ├── ui-styles.ts          # Webview CSS styles
│   ├── voice-recorder.ts     # Native mic recording (Audify/RtAudio)
│   ├── voice-service.ts      # STT/TTS API calls
│   └── voice-popup-server.ts # Browser popup fallback server
├── package.json              # Extension manifest & dependencies
├── tsconfig.json             # TypeScript configuration
└── VOICE_PRD.md             # This document
```

---

## Key Technologies

| Component | Technology | Purpose |
|-----------|------------|---------|
| **Mic Recording** | [Audify](https://github.com/AudifyAI/audify) (RtAudio) | Native audio capture, no external deps |
| **TTS Playback** | [sound-play](https://github.com/nicoreed/sound-play) | Native audio playback via system player |
| **Speech-to-Text** | OpenAI Whisper / Whisper.cpp | Audio transcription |
| **Text-to-Speech** | OpenAI TTS / Kokoro | Voice synthesis |
| **Fallback Recording** | Browser getUserMedia | For Codespaces/Web |

---

## Configuration Options

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `claudeCodeChat.voice.sttProvider` | enum | `"openai"` | `"openai"` or `"local-whisper"` |
| `claudeCodeChat.voice.ttsProvider` | enum | `"openai"` | `"openai"` or `"local-kokoro"` |
| `claudeCodeChat.voice.openaiApiKey` | string | `""` | OpenAI API key for STT/TTS |
| `claudeCodeChat.voice.localWhisperUrl` | string | `"http://127.0.0.1:2022/v1"` | Local Whisper endpoint |
| `claudeCodeChat.voice.localKokoroUrl` | string | `"http://127.0.0.1:8880/v1"` | Local Kokoro endpoint |
| `claudeCodeChat.voice.ttsVoice` | string | `"alloy"` | TTS voice selection |
| `claudeCodeChat.voice.autoPlayResponses` | boolean | `false` | Auto-play Claude's responses |

---

## Usage

### Quick Start

1. Install the extension
2. Set your OpenAI API key in settings: `claudeCodeChat.voice.openaiApiKey`
3. Enable auto-play: `claudeCodeChat.voice.autoPlayResponses: true`
4. Click the 🎤 microphone button and speak!

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+Shift+V` (Mac) / `Ctrl+Shift+V` (Win/Linux) | Start voice input |

---

## Message Flow

```
1. User clicks 🎤 button
   ↓
2. Native recording starts (Audify)
   ↓
3. User speaks → Silence detected → Recording stops
   ↓
4. Audio sent to Whisper API for transcription
   ↓
5. Transcript sent to Claude CLI
   ↓
6. Claude responds
   ↓
7. Response converted to speech (TTS)
   ↓
8. Audio played natively (sound-play)
```

---

## Platform Support

| Platform | Mic Recording | TTS Playback | Browser Fallback |
|----------|--------------|--------------|------------------|
| macOS | ✅ Native (CoreAudio) | ✅ afplay | ✅ |
| Windows | ✅ Native (WASAPI) | ✅ PowerShell | ✅ |
| Linux | ✅ Native (ALSA/PulseAudio) | ✅ aplay | ✅ |
| Codespaces | ✅ Persistent Browser Mode | ✅ Browser | ✅ |
| VS Code Web | ✅ Persistent Browser Mode | ✅ Browser | ✅ |

---

## Persistent Browser Voice Mode (v1.1.0+)

For environments where native audio isn't available (Codespaces, VS Code Web), we offer a **Persistent Browser Voice Mode** that keeps a browser tab open for continuous voice interaction.

### How It Works

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         VS Code Extension                                │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  VoiceBridgeServer (WebSocket)                                   │    │
│  │  • Generates 6-digit session code                                │    │
│  │  • Manages WebSocket connections                                 │    │
│  │  • Routes audio/transcripts between browser and Claude          │    │
│  │  • Session expires after 30 min inactivity                      │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                              ↕ WebSocket                                 │
└─────────────────────────────────────────────────────────────────────────┘
                               ↕ WSS (secure)
┌─────────────────────────────────────────────────────────────────────────┐
│                         Browser Tab (stays open)                         │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  Voice Interface                                                 │    │
│  │  • Enter session code to connect                                │    │
│  │  • Mic recording via getUserMedia                               │    │
│  │  • Audio playback for TTS responses                             │    │
│  │  • Real-time transcript display                                 │    │
│  │  • Push-to-talk or voice-activated                              │    │
│  └─────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
```

### User Flow

1. **In VS Code**: Click the "Browser Voice Mode" button in the webview
2. **Extension**: Generates a 6-digit session code (e.g., `A3F9K2`)
3. **Extension**: Opens browser to voice page OR displays QR code
4. **In Browser**: Enter the session code to connect
5. **Connected**: Browser shows "Connected to VS Code"
6. **Voice Chat**: Click mic to talk → see transcript → hear response
7. **Continuous**: Tab stays open for ongoing conversation

### Security

- **Session Code**: 6-char alphanumeric, valid for 5 minutes before first connection
- **Session Token**: After connection, uses secure token for authentication
- **WSS**: All WebSocket traffic is encrypted (wss:// in production)
- **Auto-Expire**: Sessions expire after 30 minutes of inactivity
- **Codespaces**: Leverages GitHub's built-in port forwarding security

### WebSocket Message Types

```typescript
// Browser → Extension
{ type: 'connect', sessionCode: 'A3F9K2' }
{ type: 'audio', audio: 'base64...', mimeType: 'audio/webm' }
{ type: 'stopRecording' }
{ type: 'ping' }

// Extension → Browser
{ type: 'connected', sessionId: 'xxx' }
{ type: 'transcript', text: 'Hello Claude...' }
{ type: 'response', text: 'Claude says...' }
{ type: 'ttsAudio', audio: 'base64...', mimeType: 'audio/mp3' }
{ type: 'error', message: '...' }
{ type: 'pong' }
```

### Configuration

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `claudeCodeChat.voice.browserMode` | boolean | `false` | Prefer browser voice mode |
| `claudeCodeChat.voice.sessionTimeout` | number | `1800` | Session timeout in seconds |

---

## Development

### Prerequisites
- Node.js 18+
- VS Code 1.94.0+
- Claude Code CLI installed and authenticated

### Build & Test
```bash
npm install
npm run compile
# Press F5 in VS Code to launch Extension Development Host
```

### Debug Logging
Check the Debug Console (`Cmd+Shift+Y`) for detailed logs:
- `Audify loaded successfully` - Native audio available
- `Using input device: X sample rate: 48000` - Recording started
- `Silence detected, auto-stopping...` - VAD triggered
- `Audio playback completed!` - TTS finished

---

## References

- [Audify](https://github.com/AudifyAI/audify) - Native audio I/O for Node.js
- [sound-play](https://github.com/nicoreed/sound-play) - Cross-platform audio playback
- [OpenAI Whisper API](https://platform.openai.com/docs/api-reference/audio)
- [OpenAI TTS API](https://platform.openai.com/docs/api-reference/audio/createSpeech)
- [Whisper.cpp](https://github.com/ggerganov/whisper.cpp) - Local Whisper server
- [Kokoro TTS](https://github.com/remsky/Kokoro-FastAPI) - Local TTS server
