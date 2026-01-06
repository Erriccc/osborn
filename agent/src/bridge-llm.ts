/**
 * Bridge LLM Module - Creates LLM instances for pipelined voice sessions
 *
 * In pipelined mode, we use a separate LLM (Gemini or GPT-4o) as the
 * "conversation manager" that handles voice I/O and routes to Claude Code.
 */

import * as google from '@livekit/agents-plugin-google'
import * as openai from '@livekit/agents-plugin-openai'

export interface BridgeLLMConfig {
  provider: 'gemini-pro' | 'gemini-flash' | 'gpt-4o' | 'gpt-4o-mini'
  model?: string
}

/**
 * Create Bridge LLM instance for pipelined voice sessions
 *
 * Options:
 * - gemini-pro: Gemini 2.5 Pro (smart, good reasoning)
 * - gemini-flash: Gemini 2.0 Flash (faster, cheaper)
 * - gpt-4o: GPT-4o (alternative if OpenAI preferred)
 * - gpt-4o-mini: GPT-4o Mini (faster, cheaper)
 */
export function createBridgeLLM(config: BridgeLLMConfig) {
  switch (config.provider) {
    case 'gemini-pro':
      return new google.LLM({
        model: config.model || 'gemini-2.5-pro',
      })

    case 'gemini-flash':
      return new google.LLM({
        model: config.model || 'gemini-2.0-flash',
      })

    case 'gpt-4o':
      return new openai.LLM({
        model: config.model || 'gpt-4o',
      })

    case 'gpt-4o-mini':
      return new openai.LLM({
        model: config.model || 'gpt-4o-mini',
      })

    default:
      throw new Error(`Unknown Bridge LLM provider: ${config.provider}`)
  }
}
