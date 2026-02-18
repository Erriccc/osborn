/**
 * Voice I/O Module
 * Handles STT (Speech-to-Text), TTS (Text-to-Speech), and Realtime model creation
 *
 * Supports two modes:
 * - Direct mode: STT (Deepgram) → Claude Agent SDK → TTS (Deepgram)
 * - Realtime mode: OpenAI/Gemini native speech-to-speech models
 */

import * as deepgram from '@livekit/agents-plugin-deepgram'
import * as google from '@livekit/agents-plugin-google'
import * as openai from '@livekit/agents-plugin-openai'
import * as silero from '@livekit/agents-plugin-silero'
import type { RealtimeConfig } from './config.js'

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
        voice: config.voice || 'apollo',
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
 * Uses Deepgram STT (fast, accurate) + Deepgram TTS (fast, good)
 */
export const DEFAULT_VOICE_IO_CONFIG: VoiceIOConfig = {
  stt: {
    provider: 'deepgram',
    model: 'nova-3',
    language: 'en',
  },
  tts: {
    provider: 'deepgram',
    voice: 'aura-asteria-en',
  },
}

// ============================================================
// REALTIME MODE - OpenAI/Gemini native speech-to-speech
// ============================================================

export interface RealtimeModelConfig {
  provider: 'openai' | 'gemini'
  // OpenAI options
  openaiVoice?: 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer'
  openaiModel?: string
  // Gemini options
  geminiVoice?: 'Puck' | 'Charon' | 'Kore' | 'Fenrir' | 'Aoede'
  geminiModel?: string
  // Shared options
  instructions?: string
}

/**
 * Create Realtime Model for native speech-to-speech
 * Supports OpenAI Realtime API and Gemini Live API
 *
 * Note: Instructions are passed to voice.Agent, not to the RealtimeModel
 */
export function createRealtimeModel(config: RealtimeModelConfig) {
  if (config.provider === 'gemini') {
    console.log('📱 Using Gemini Live API (realtime)')
    return new google.beta.realtime.RealtimeModel({
      model: config.geminiModel || 'gemini-2.5-flash-native-audio-preview-12-2025',
      voice: config.geminiVoice || 'Puck',
      // Gemini supports instructions at model level
      instructions: config.instructions,
      // Enable transcription so we get text of what the agent says
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    })
  } else {
    console.log('📱 Using OpenAI Realtime API')
    // OpenAI RealtimeModel - instructions go to voice.Agent instead
    return new openai.realtime.RealtimeModel({
      model: config.openaiModel || 'gpt-4o-realtime-preview',
      voice: config.openaiVoice || 'alloy',
    })
  }
}

/**
 * Create realtime model from config
 */
export function createRealtimeModelFromConfig(realtimeConfig: RealtimeConfig, instructions?: string) {
  return createRealtimeModel({
    provider: realtimeConfig.provider || 'openai',
    openaiVoice: realtimeConfig.openaiVoice,
    openaiModel: realtimeConfig.openaiModel,
    geminiVoice: realtimeConfig.geminiVoice,
    geminiModel: realtimeConfig.geminiModel,
    instructions,
  })
}
