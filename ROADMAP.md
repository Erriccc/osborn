# Roadmap

A high-level view of where Voice Native is going. This is directional, not a
commitment to dates — the fastest way to influence it is to
[open an issue](https://github.com/Erriccc/osborn/issues) or a PR.

## Recently shipped

- **Voice modes** — pipeline (Deepgram Flux → Claude + parallel Gemini observer),
  direct, and realtime (OpenAI/Gemini speech-to-speech).
- **Multi-agent orchestration** — researcher / reasoner / writer sub-agents.
- **Meeting bot** — a Recall.ai bot joins Zoom/Meet as a silent observer that
  speaks when addressed.
- **Per-user cloud agents** — isolated sandboxes so anyone can talk to it live
  without local setup.
- **In-app reports → GitHub Issues** — user reports mirror here, privacy-stripped
  and de-duplicated ([#44](https://github.com/Erriccc/osborn/issues/44)).
- **Mobile builds on CI** — Expo app + Capacitor shell build unsigned on hosted
  macOS runners, with Maestro UI smoke flows
  ([#45](https://github.com/Erriccc/osborn/issues/45)).

## Now

- **Repo front door & docs site** — README, quickstart, contributor on-ramps,
  GitHub Pages ([#46](https://github.com/Erriccc/osborn/issues/46)).
- **Multi-speaker meetings** — addressing + mute when two or more humans are in the
  room (behind a feature flag today; hardening toward on-by-default).
- **Reconnect & performance** — survive network blips mid-session without dropping
  the agent; faster cold connects.

## Next

- **Signed mobile (TestFlight)** — flip the unsigned CI pipeline to signed builds
  once the Apple Developer account lands; real-device voice/WebRTC validation.
- **Apple Watch surfaces** — glanceable yes/no while driving (push bridge), then a
  native watch voice client.
- **Compaction integrity** — durable record of what each session compaction wrote,
  surfaced in the UI.
- **Cost & scale** — externalize per-user workspace state so cloud agents can scale
  to zero between sessions.

## Later / exploring

- **Rooms** — multiple concurrent voice sessions/projects side by side.
- **Browser automation** — a Muse-like in-agent browser for web tasks.
- **Deeper MCP ecosystem** — more first-class tool servers.

Have an idea that isn't here? [Tell us.](https://github.com/Erriccc/osborn/issues/new)
