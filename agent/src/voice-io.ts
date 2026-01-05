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
        model: (config.model || 'nova-2') as any,
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
  switch (config.provider) {
    case 'gemini':
      // Gemini TTS via google plugin
      return new (google.beta as any).TTS({
        model: config.model || 'gemini-2.5-flash-preview-tts',
        voice: config.voice || 'Zephyr',
      })

    case 'openai':
      return new openai.TTS({
        voice: (config.voice as any) || 'alloy',
        model: config.model || 'tts-1',
      })

    case 'deepgram':
      return new deepgram.TTS({
        model: (config.model || 'aura-asteria-en') as any,
      })

    default:
      throw new Error(`Unknown TTS provider: ${config.provider}`)
  }
}

/**
 * Create VAD (Voice Activity Detection) for turn detection
 */
export async function createVAD() {
  return silero.VAD.load({
    minSpeechDuration: 0.1,
    minSilenceDuration: 0.3,
  })
}

/**
 * Default voice I/O configuration
 * Uses Deepgram STT (fast, accurate) + Gemini TTS (cheap, good)
 */
export const DEFAULT_VOICE_IO_CONFIG: VoiceIOConfig = {
  stt: {
    provider: 'deepgram',
    model: 'nova-2',
    language: 'en',
  },
  tts: {
    provider: 'gemini',
    voice: 'Zephyr',
  },
}
