import { defineConfig, devices } from '@playwright/test'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Voice E2E config.
 *
 * The three Chromium flags are the heart of the harness:
 *  - use-fake-ui-for-media-stream    → auto-grants the mic permission prompt
 *  - use-fake-device-for-media-stream → replaces the real mic with a virtual one
 *  - use-file-for-fake-audio-capture  → the virtual mic "speaks" this WAV once
 *
 * Together they push a real spoken utterance through the REAL pipeline:
 * browser getUserMedia → LiveKit Cloud → agent STT (Deepgram) → Claude → TTS.
 * Nothing is mocked — this exercises the same path a human user hits.
 *
 * Env:
 *  OSBORN_APP_URL   — frontend to test (default: production voice-native.com)
 *  OSBORN_TEST_WAV  — utterance fixture (default: fixtures/hello-question.wav)
 */
const WAV = process.env.OSBORN_TEST_WAV || join(__dirname, 'fixtures', 'hello-question.wav')

export default defineConfig({
  testDir: './specs',
  timeout: 180_000, // voice flows include machine cold-start (up to ~30s) + LLM turns
  expect: { timeout: 30_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    baseURL: process.env.OSBORN_APP_URL || 'https://www.voice-native.com',
    trace: 'on',   // always keep the step-by-step replay (screenshots + DOM + network)
    video: 'on',   // always keep the silent screen recording; audio lives in our webm capture
    ...devices['Desktop Chrome'],
    // Local Mac: installed Google Chrome (Playwright dropped Chromium downloads
    // for macOS 13). Container/CI: bundled Chromium. NOTE: this `channel` also
    // applies to chromium.launch() calls inside tests — the runner merges it.
    ...(process.env.OSBORN_TEST_CONTAINER ? {} : { channel: 'chrome' }),
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        // %noloop: play the fixture ONCE — without it Chromium loops the WAV
        // forever and the repeated phrase pollutes captures + transcripts
        `--use-file-for-fake-audio-capture=${WAV}%noloop`,
        '--autoplay-policy=no-user-gesture-required',
        // ears: allow getDisplayMedia({preferCurrentTab}) without a picker prompt
        '--auto-accept-this-tab-capture',
      ],
    },
    permissions: ['microphone'],
  },
})
