# Osborn Voice E2E Harness

Reproducible, agent-runnable end-to-end tests for the voice pipeline —
built from the 2026-07-27 deep-research findings
(`~/osborn-backups/voice-testing-research-2026-07-27.md`).

## How it works

Chromium is launched with fake-media flags so a **WAV file becomes the
microphone**. The spoken fixture flows through the REAL production path:

```
WAV → getUserMedia → LiveKit Cloud → agent (Deepgram STT → Claude → TTS) → UI
```

Nothing is mocked. Assertions ride on the chat UI (which mirrors every voice
event) plus timing budgets that catch cold-start and stall regressions.

## Run

```bash
cd tests/voice-e2e
npm install && npx playwright install chromium
npm run fixtures        # synthesizes spoken WAVs (macOS `say` / espeak-ng)
npm test                # against production
OSBORN_APP_URL=http://localhost:3000 npm test   # against local frontend
```

## Roadmap (from research: build Phase 1, buy Phase 2)

- **Milestone A (this scaffold):** UI-drive + fake mic + semantic round-trip
  assertion ("say pineapple" → reply contains pineapple) + lifecycle test.
- **Milestone B:** LiveKit subscriber bot joins the room, records the agent's
  TTS track, transcribes with Deepgram, asserts on the audio itself —
  first-frame latency, silence gaps, mid-sentence cutoffs (the June bug class).
  Reference implementations: Pipecat Evals (`within_ms` budgets), LiveKit
  Vitest text-mode framework for cheap turn-logic CI.
- **Milestone C:** barge-in scripts (speak during agent speech via a second
  fake-audio file with `send_after`-style timing), resume-session assertions,
  cold-start wake timing as a tracked metric.
- **Phase 2 (buy):** pilot Hamming (native LiveKit-to-LiveKit test callers,
  50+ metrics, barge-in + context-retention validation) or Cekura for scaled
  simulation and CI regression gating.

## CI

Add a workflow that runs `npm test` against a preview/prod URL post-deploy.
Keep fixtures committed (WAVs are small) so CI needs no TTS synthesis.
