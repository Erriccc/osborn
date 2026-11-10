# In-app Browser panel

_Implements [#51](https://github.com/Erriccc/osborn/issues/51)._

Watch and drive the browser-screen-recorder engine **inside Voice Native**, instead
of opening the engine's raw Fly URL (which nested a browser in a browser and read as
"a meeting starting"). The engine already auto-wakes, streams, and records — this is
the in-app product surface over it.

## Surfaces

- **`/browser`** — the in-app page hosting the panel (auth-gated by middleware).
  The link to a run is this page's URL, so it's shareable. Reached from the
  Browser Screen Recorder landing page ("Watch & drive the live engine →").
- **`components/BrowserPanel.tsx`** — live MJPEG stream, engine status, controls,
  and this run's task links. Talks only to the proxy.
- **`app/api/browser/[action]/route.ts`** — the server proxy. Auth-gated; injects
  the engine/stream tokens so the client never holds them or the raw Fly URL.

## What the panel shows / does

- **Live view** — the engine's MJPEG stream, proxied. Starting it **wakes** the Fly
  machine (~40s to first pixels); the panel shows an explicit "waking…/retry" state
  so a stuck run is legible instead of a bare "Connecting…".
- **State** — awake / asleep / connecting / live. Asleep-vs-awake is read from the
  **Fly Machines API without waking** the engine (`engine-state`); page/tab/brain/
  stream-freshness come from the engine's `/status` while watching.
- **Controls** (over the existing control API): open a URL / new tab (`/tab`), say
  into the page mic and hear the reply (`/say`), stop the engine (`/end`).
- **Per-run links** — this run's tasks (`/tasks`) each link to the clip (`/clip`),
  clip+audio, and screenshot; plus the run's console/network logs and audio.

## Proxy endpoints (`/api/browser/<action>`)

| Action | → engine | Notes |
|---|---|---|
| `stream` | `:443 /stream` | MJPEG, piped live; wakes the engine |
| `engine-state` | Fly Machines API | awake/asleep **without** waking |
| `status` `tasks` `logs` `clip` `artifact` `audio` | `:8781` (GET) | buffered |
| `events` | `:8781 /events` | SSE, piped live |
| `act` `say` `hear` `tab` `end` `recover` | `:8781` (POST) | control |

`eval`, `brain`, and `journey` are **not** proxyable (arbitrary JS / advanced).

## Setup (env on the frontend / Railway)

The engine host is derived from `FLY_HARNESS_APP` (default `osborn-voice-e2e-n`) →
`https://<app>.fly.dev`. To make the proxy reach a token-protected engine, set:

- **`OSBORN_ENGINE_TOKEN`** — the engine's control-API token (`x-engine-token`).
- **`OSBORN_STREAM_TOKEN`** — the engine's `/stream` key, if the engine sets one.
- `FLY_API_TOKEN` — already used elsewhere; enables the no-wake awake/asleep probe.
- Optional overrides: `BROWSER_ENGINE_HOST`, `BROWSER_ENGINE_STREAM_URL`,
  `BROWSER_ENGINE_CONTROL_URL`.

Without the tokens the panel still renders and the controls return the engine's own
auth errors — it degrades, it doesn't break.

## Limits / follow-ups

- **Per-session isolation.** v1 targets the single shared engine, so the shareable
  link is "this engine's current run", not an isolated per-session run. True
  per-task/per-session links (independent live views + retained recordings/logs per
  run) need engine-side run IDs — the issue notes the engine currently uses one bare
  root URL for the wake event, the live stream, and the home.
- **Driving is powerful.** Any signed-in user can wake/drive the engine today;
  restricting write controls (`act`/`say`/`tab`/`end`) to admins is a sensible next
  step if this is exposed broadly.
