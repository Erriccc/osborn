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
  provider: 'deepgram' | 'deepgram-flux' | 'groq-whisper' | 'openai-whisper'
  model?: string
  language?: string
  /** Deepgram Flux: end-of-turn confidence threshold (0.0-1.0, default 0.7) */
  eotThreshold?: number
  /** Deepgram Flux: max ms to wait before forcing turn end (default 3000) */
  eotTimeoutMs?: number
}

export interface TTSConfig {
  provider: 'gemini' | 'openai' | 'elevenlabs' | 'deepgram' | 'groq-orpheus'
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

/**
 * Default voice I/O configuration (used by realtime mode fallback)
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
    voice: 'aura-2-asteria-en',
  },
}

/**
 * Direct mode voice config — centralized here for easy provider swapping.
 * To switch providers: comment out the active line, uncomment the alternative.
 */
export const DIRECT_MODE_STT: STTConfig = {
  // provider: 'groq-whisper', model: 'whisper-large-v3-turbo',          // Batch — needs VAD
  // provider: 'openai-whisper', model: 'whisper-1',                     // Batch — needs VAD
  // provider: 'deepgram', model: 'nova-3', language: 'en',             // Streaming, silence-based endpointing
  provider: 'deepgram-flux', model: 'flux-general-en', language: 'en',  // Streaming, ML-based turn detection (requires Deepgram V2 access)
}

export const DIRECT_MODE_TTS: TTSConfig = {
  // provider: 'deepgram', model: 'aura-2-asteria-en',  // WebSocket-based: handles TTS abort cleanly (no unrecoverable crash on interruption)
  // provider: 'gemini', model: 'gemini-2.5-flash-preview-tts', voice: 'apollo',
  // provider: 'openai', model: 'tts-1', voice: 'fable',  // HTTP streaming: throws APIUserAbortError on interrupt → unrecoverable session crash
  provider: 'openai', model: 'tts-1-hd', voice: 'fable',  // 0.9.70: test tts-1-hd — tts-1 had chronic per-sentence HTTP hangs (40s SDK watchdog → APIUserAbortError mid-message)
  // provider: 'groq-orpheus', model: 'canopylabs/orpheus-v1-english', voice: 'autumn',  // $22/M chars — voices: autumn, diana, hannah, austin, daniel, troy
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
  geminiVoice?: 'Charon' | 'Puck' | 'Kore' | 'Fenrir' | 'Aoede'
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
    // Using 'latest' alias — 12-2025 had a known 1008 crash bug during interruptions + tool calls
    return new google.beta.realtime.RealtimeModel({
      model: config.geminiModel || 'gemini-2.5-flash-native-audio-latest',
      voice: config.geminiVoice || 'Charon',
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
