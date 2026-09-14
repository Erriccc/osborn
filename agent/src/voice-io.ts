/**
 * Voice I/O Module
 * Handles STT (Speech-to-Text) and TTS (Text-to-Speech) for pipeline mode.
 */

import * as deepgram from '@livekit/agents-plugin-deepgram'
import * as fishaudio from '@livekit/agents-plugin-fishaudio'
import * as openai from '@livekit/agents-plugin-openai'
import * as rime from '@livekit/agents-plugin-rime'
import * as silero from '@livekit/agents-plugin-silero'
import * as soniox from '@livekit/agents-plugin-soniox'

export interface STTConfig {
  provider: 'soniox' | 'deepgram' | 'deepgram-flux' | 'groq-whisper' | 'openai-whisper'
  model?: string
  language?: string
  /** Deepgram Flux: end-of-turn confidence threshold (0.0-1.0, default 0.7) */
  eotThreshold?: number
  /** Deepgram Flux: max ms to wait before forcing turn end (default 3000) */
  eotTimeoutMs?: number
}

export interface TTSConfig {
  provider: 'soniox' | 'openai' | 'deepgram' | 'groq-orpheus' | 'fishaudio' | 'rime'
  voice?: string
  model?: string
}

export interface VoiceIOConfig {
  stt: STTConfig
  tts: TTSConfig
}

/**
 * Create STT (Speech-to-Text) instance based on config
 * Note: Gemini STT is not available in Node.js, using Deepgram as default
 */
export function createSTT(config: STTConfig) {
  switch (config.provider) {
    case 'soniox':
      // Soniox stt-rt-v4 — semantic endpointing: ML model holds on incomplete thoughts,
      // commits on natural sentence ends. maxEndpointDelayMs 500–3000ms (minimum = fastest).
      // endpointLatencyAdjustmentLevel 0–3: higher = more aggressive latency reduction
      // while keeping semantic smarts. context.terms biases recognition toward code vocab.
      return new soniox.STT({
        model: (config.model || 'stt-rt-v4') as any,
        languageHints: config.language ? [config.language] : ['en'],
        maxEndpointDelayMs: 2500,         // 2.5s runway — long enough for thinking pauses ("um", mid-clause hesitations)
        endpointLatencyAdjustmentLevel: 2, // balanced — semantic model distinguishes pause vs end; 3 was cutting off long turns
        context: {
          terms: ['Claude', 'TypeScript', 'LiveKit', 'Deepgram', 'npm', 'Railway', 'Fly.io'],
        },
      })

    case 'deepgram':
      // Previous default. Silence-based endpointing (550ms configured = wait for 550ms quiet).
      // Fast and reliable, but commits on any pause — doesn't understand mid-thought hesitations.
      // Switch back: provider: 'deepgram', model: 'nova-3'
      return new deepgram.STT({
        model: (config.model || 'nova-3') as any,
        language: config.language || 'en',
        endpointing: 550,  // Wait 550ms of silence before committing final transcript (default 25ms causes mid-sentence fragments)
      })

    case 'deepgram-flux':
      // Deepgram Flux (V2 API) — semantic turn detection via ML model
      // Uses TurnInfo events: StartOfTurn, Update, EagerEndOfTurn, TurnResumed, EndOfTurn
      // TurnResumed prevents premature commits when user pauses mid-sentence
      // All processing is server-side (Deepgram), zero local CPU
      console.log(`🎙️ Using Deepgram Flux STT (semantic turn detection, eotThreshold=${config.eotThreshold ?? 0.85}, eotTimeoutMs=${config.eotTimeoutMs ?? 3000})`)
      return new deepgram.STTv2({
        model: config.model || 'flux-general-en',
        language: config.language || 'en',
        eotThreshold: config.eotThreshold ?? 0.85,  // 0.0-1.0 — lower = more aggressive turn detection (more false positives), higher = more lenient (more false negatives)
        eotTimeoutMs: config.eotTimeoutMs ?? 3000, // Max ms to wait before forcing end of turn — helps when user pauses for a long time mid-sentence (default 3000ms)
      })

    case 'groq-whisper':
      return openai.STT.withGroq({
        model: config.model || 'whisper-large-v3-turbo',
      })

    case 'openai-whisper':
      return new openai.STT({
        model: config.model || 'whisper-1',
      })

    default:
      throw new Error(`Unknown STT provider: ${config.provider}`)
  }
}

/**
 * Create TTS (Text-to-Speech) instance based on config
 */
export function createTTS(config: TTSConfig) {
  let tts: any

  switch (config.provider) {
    case 'soniox':
      // Soniox tts-rt-v1 — real-time WebSocket streaming, clean abort on interruption.
      // Estimated ~$4–16/M chars ($0.70/hr of generated speech, preview pricing).
      // speed: 0.7–1.3x. voices: Maya (female), others at soniox.com/docs/tts/voices.
      // Previous TTS: OpenAI tts-1-hd (fable) — $30/M chars, ~500ms TTFB, HTTP chunked.
      // Switch back: provider: 'openai', model: 'tts-1-hd', voice: 'fable'
      tts = new soniox.TTS({
        model: (config.model || 'tts-rt-v1') as any,
        voice: config.voice || 'Maya',
        speed: 0.9,
      })
      break

    case 'openai':
      // tts-1-hd: $30/M chars, ~500ms TTFB, 6 voices: alloy echo fable onyx nova shimmer.
      // tts-1 (cheaper): $15/M chars, slightly lower quality, same voices.
      tts = new openai.TTS({
        voice: (config.voice as any) || 'alloy',
        model: config.model || 'tts-1',
      })
      break

    case 'deepgram':
      // Aura-2 voices: aura-2-asteria-en, aura-2-luna-en, aura-2-stella-en, aura-2-hera-en
      // aura-2-orion-en, aura-2-arcas-en, aura-2-perseus-en, aura-2-angus-en, aura-2-orpheus-en
      // ~$15/M chars, ~100ms TTFB.
      tts = new deepgram.TTS({
        model: (config.model || 'aura-2-asteria-en') as any,
      })
      break

    case 'groq-orpheus':
      // Groq Orpheus TTS via OpenAI-compatible API ($22/M chars)
      // Voices: autumn, diana, hannah, austin, daniel, troy
      tts = new openai.TTS({
        model: config.model || 'canopylabs/orpheus-v1-english',
        voice: (config.voice as any) || 'autumn',
        apiKey: process.env.GROQ_API_KEY,
        baseURL: 'https://api.groq.com/openai/v1',
      } as any)
      break

    case 'fishaudio':
      // Fish Audio s2-pro ($15/M chars) — blind test winner, half price of OpenAI tts-1-hd
      // voiceId: pick from Fish Audio voice library (leave undefined for system default)
      // Requires FISH_AUDIO_API_KEY env var
      tts = new fishaudio.TTS({
        model: (config.model || 's2-pro') as any,
        voiceId: config.voice,
        latencyMode: 'low',
      })
      break

    case 'rime':
      // Rime Mist v3 ($30/M chars, 37ms TTFB) — fastest commercial TTS, conversation-trained
      // useWebsocket: true → WebSocket streaming = clean abort on interruption (like Deepgram)
      // speaker: pick from Rime voice library, e.g. 'aurora', 'ember', 'cove'
      // Requires RIME_API_KEY env var
      tts = new rime.TTS({
        modelId: (config.model || 'mistv3') as any,
        speaker: config.voice || 'cove',
        useWebsocket: true,
      })
      break

    default:
      throw new Error(`Unknown TTS provider: ${config.provider}`)
  }

  // Increase max listeners to prevent memory leak warnings
  // TTS instances can have many concurrent listeners during active conversations
  if (tts && typeof tts.setMaxListeners === 'function') {
    tts.setMaxListeners(100)
  }

  return tts
}

/**
 * Create VAD (Voice Activity Detection) for turn detection
 *
 * Tuned to prevent:
 * - "Audio file is too short" errors from STT (OpenAI requires >= 0.1s)
 * - Split sentences when user pauses briefly mid-speech
 * - False triggers from ambient noise
 */
export async function createVAD() {
  // VAD now only handles interruption detection — turn detection moved to Deepgram STT (server-side).
  // Lighter settings = less local CPU from ONNX inference.
  return silero.VAD.load({
    minSpeechDuration: 0.4,       // 400ms — quick interruption detection
    minSilenceDuration: 1.2,      // 1200ms — responsive
    prefixPaddingDuration: 0.1,
    activationThreshold: 0.85,     // default — balanced for interruptions only
  })
}

