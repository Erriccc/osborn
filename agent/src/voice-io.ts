/**
 * Voice I/O Module - Layer 1 of Three-Layer Architecture
 * Handles STT (Speech-to-Text) and TTS (Text-to-Speech) creation
 *
 * Note: Gemini STT is Python-only, so we use Deepgram for STT
 * but Gemini TTS is available in Node.js
 */

import * as deepgram from '@livekit/agents-plugin-deepgram'
import * as google from '@livekit/agents-plugin-google'
import * as openai from '@livekit/agents-plugin-openai'
import * as silero from '@livekit/agents-plugin-silero'

export interface STTConfig {
  provider: 'deepgram' | 'groq-whisper' | 'openai-whisper'
  model?: string
  language?: string
}

export interface TTSConfig {
  provider: 'gemini' | 'openai' | 'elevenlabs' | 'deepgram'
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
    case 'deepgram':
      return new deepgram.STT({
        model: (config.model || 'nova-3') as any,
        language: config.language || 'en',
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
 * Using Gemini TTS as default (cheaper, good quality)
 */
export function createTTS(config: TTSConfig) {
  let tts: any

  switch (config.provider) {
    case 'gemini':
      // Gemini TTS via google plugin
      tts = new (google.beta as any).TTS({
        model: config.model || 'gemini-2.5-flash-preview-tts',
        voice: config.voice || 'Zephyr',
      })
      break

    case 'openai':
      tts = new openai.TTS({
        voice: (config.voice as any) || 'alloy',
        model: config.model || 'tts-1',
      })
      break

    case 'deepgram':
      tts = new deepgram.TTS({
        model: (config.model || 'aura-asteria-en') as any,
      })
      break

    default:
      throw new Error(`Unknown TTS provider: ${config.provider}`)
  }

  // Increase max listeners to prevent memory leak warnings
  // TTS instances can have many concurrent listeners during active conversations
  if (tts && typeof tts.setMaxListeners === 'function') {
    tts.setMaxListeners(50)
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
  return silero.VAD.load({
    // Minimum 0.5s speech before triggering - prevents noise/short sounds
    // Higher value = more complete utterances before processing
    minSpeechDuration: 0.5,

    // Wait 1.2s of silence before considering speech "done"
    // Allows natural pauses mid-sentence without triggering STT
    // (increased from 0.8s to reduce sentence splitting)
    minSilenceDuration: 1.2,

    // Add 0.2s padding to start of speech chunks for cleaner audio
    prefixPaddingDuration: 0.2,

    // Higher threshold = less sensitive to quiet sounds/noise
    // Default is 0.5, using 0.65 to reduce false positives
    activationThreshold: 0.65,
  })
}

/**
 * Default voice I/O configuration
 * Uses Deepgram STT (fast, accurate) + Gemini TTS (cheap, good)
 */
export const DEFAULT_VOICE_IO_CONFIG: VoiceIOConfig = {
  stt: {
    provider: 'deepgram',
    model: 'nova-3',
    language: 'en',
  },
  tts: {
    provider: 'gemini',
    voice: 'Zephyr',
  },
}
