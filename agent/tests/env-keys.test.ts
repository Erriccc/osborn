// The required-key manifest must follow the real voice defaults (#159): Soniox is the default STT
// and TTS (config.ts DEFAULT_CONFIG), Deepgram only an alternative. Checks the agent manifest, the
// frontend's machine-injection spec and the setup wizard's agent/.env agree.
// Run: npx tsx agent/tests/env-keys.test.ts
import assert from 'node:assert/strict'
import { AGENT_ENV_KEYS, missingRequiredEnv } from '../src/env-keys.js'
import { getDirectConfig } from '../src/config.js'
import { PLATFORM_ENV_SPEC } from '../../frontend/src/lib/platform-env.js'
import { defaultEnvConfig, generateAgentEnv } from '../../frontend/src/lib/setup.js'

let passed = 0
const t = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ok  ${name}`) }
const req = (list: { key: string, required: boolean }[], key: string) => list.find((k) => k.key === key)?.required

t('default STT and TTS are Soniox (what this test assumes)', () => {
  const prev = [process.env.OSBORN_STT_PROVIDER, process.env.OSBORN_TTS_PROVIDER]
  delete process.env.OSBORN_STT_PROVIDER; delete process.env.OSBORN_TTS_PROVIDER
  try {
    const d = getDirectConfig({} as any)
    assert.equal(d.stt.provider, 'soniox')
    assert.equal(d.tts.provider, 'soniox')
  } finally {
    if (prev[0] !== undefined) process.env.OSBORN_STT_PROVIDER = prev[0]
    if (prev[1] !== undefined) process.env.OSBORN_TTS_PROVIDER = prev[1]
  }
})

t('SONIOX_API_KEY is required and DEEPGRAM_API_KEY is not, in both manifests', () => {
  for (const list of [AGENT_ENV_KEYS, PLATFORM_ENV_SPEC]) {
    assert.equal(req(list, 'SONIOX_API_KEY'), true)
    assert.equal(req(list, 'DEEPGRAM_API_KEY'), false)
  }
})

const base = { LIVEKIT_URL: 'x', LIVEKIT_API_KEY: 'x', LIVEKIT_API_SECRET: 'x', OPENAI_API_KEY: 'x', OSBORN_API_PORT: '1' }

t('missing-key warning names Soniox by default, never Deepgram', () => {
  assert.deepEqual(missingRequiredEnv(base), ['SONIOX_API_KEY'])
  assert.deepEqual(missingRequiredEnv(base, { stt: 'soniox', tts: 'soniox' }), ['SONIOX_API_KEY'])
  assert.deepEqual(missingRequiredEnv({ ...base, SONIOX_API_KEY: 'x' }, { stt: 'soniox', tts: 'soniox' }), [])
})

t('missing-key warning follows an overridden provider', () => {
  assert.deepEqual(missingRequiredEnv(base, { stt: 'deepgram', tts: 'openai' }), ['DEEPGRAM_API_KEY'])
  assert.deepEqual(missingRequiredEnv(base, { stt: 'deepgram-flux', tts: 'soniox' }).sort(), ['DEEPGRAM_API_KEY', 'SONIOX_API_KEY'])
  assert.deepEqual(missingRequiredEnv(base, { stt: 'openai-whisper', tts: 'openai' }), [])
})

t('setup wizard writes SONIOX_API_KEY into agent/.env, not DEEPGRAM_API_KEY', () => {
  const env = generateAgentEnv({ ...defaultEnvConfig, sonioxApiKey: 'sx-test' })
  assert.match(env, /^SONIOX_API_KEY=sx-test$/m)
  assert.doesNotMatch(env, /DEEPGRAM_API_KEY/)
})

console.log(`\n${passed} passed`)
