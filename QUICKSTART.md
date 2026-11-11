# Quickstart

Two ways to get going with **Voice Native (Osborn)** — the AI coding agent you
talk to. Pick the path that fits.

> Just want to feel it? The fastest path is **zero setup**:
> [**talk to it live → voice-native.com**](https://www.voice-native.com) — sign in
> and start talking. No install.

---

## Path A — zero setup (hosted frontend + local agent)

Run the agent on your machine (so it works in *your* project) and talk to it
through the hosted web app. No frontend build required.

```bash
npx osborn
# → prints a room code, e.g. "abc123"
```

Then open [**voice-native.com**](https://www.voice-native.com), enter the room
code, and click **Join**. You're talking to an agent running in your current
folder.

---

## Path B — run the whole stack locally (~5 minutes)

### 1. Prerequisites

- **Node 22** (the repo pins it in `.nvmrc` — `nvm use` picks it up).
- A **[LiveKit Cloud](https://cloud.livekit.io/)** project (free tier is fine) —
  this carries the real-time voice.
- An **[Anthropic API key](https://console.anthropic.com/)** (the coding agent) —
  or use the built-in Claude OAuth flow instead.
- At least one fast-brain / voice key: **[Google AI Studio](https://aistudio.google.com/apikey)**
  (recommended — Gemini Flash is the fast-brain primary and is free during preview)
  and/or **[OpenAI](https://platform.openai.com/)**.
- Optional: a **[Deepgram](https://console.deepgram.com/)** key for speech-to-text
  in the default pipeline/direct voice modes.

### 2. Clone and configure

```bash
git clone https://github.com/Erriccc/osborn.git
cd osborn

# Agent env — fill in your keys
cp agent/.env.example agent/.env

# Frontend env — just needs your LiveKit URL + keys
cp frontend/.env.example frontend/.env.local
```

Open `agent/.env` and set at minimum `LIVEKIT_URL`, `LIVEKIT_API_KEY`,
`LIVEKIT_API_SECRET`, `ANTHROPIC_API_KEY`, and `GOOGLE_API_KEY` (or
`OPENAI_API_KEY`). Open `frontend/.env.local` and set the matching
`LIVEKIT_URL` / `NEXT_PUBLIC_LIVEKIT_URL` and LiveKit API key + secret.

> Prefer a guided setup? The web app ships an in-dashboard **Setup Wizard** that
> generates both env files for you — start the frontend (step 4) and follow it.

### 3. Install

```bash
cd agent && npm install
cd ../frontend && npm install
```

### 4. Run (two terminals)

```bash
# Terminal 1 — the voice agent
cd agent && npm run dev

# Terminal 2 — the web frontend
cd frontend && npm run dev
```

Open **http://localhost:3000** and start talking.

---

## What needs what

The commands above get the **voice agent + web room** running. Some dashboard
features (login, saved/resumable sessions, file uploads) need additional services
that are **optional for a first local run** — the README covers them:

- **Supabase** — auth, dashboard history, file storage.
- **Smithery** — cloud-hosted MCP tool servers (YouTube, GitHub, etc.).
- **Recall.ai** — the Zoom / Google Meet meeting bot.

See the [README](README.md) for the full env reference, voice modes, configuration
(`~/.osborn/config.yaml`), and architecture. New contributor? Start with
[CONTRIBUTING.md](CONTRIBUTING.md), and check the [roadmap](ROADMAP.md) for where
things are headed.

## Troubleshooting

- **Agent can't reach LiveKit / no audio:** confirm `LIVEKIT_URL` is the `wss://`
  URL and the API key + secret match the same LiveKit project in *both* env files.
- **Port 3000 busy:** Next.js will offer another port; the agent HTTP API auto-bumps
  from `OSBORN_API_PORT` (default 8741) on `EADDRINUSE`.
- **`npx osborn` can't find the project:** it runs in your current directory — `cd`
  into the repo you want the agent to work on first (or set `OSBORN_CWD`).
