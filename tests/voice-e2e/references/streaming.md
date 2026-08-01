# Streaming & casting — live view, meetings, tokens

## Live view
`startLiveStream()` serves an MJPEG viewer: locally `http://127.0.0.1:8080/`, on Fly the machine's public `https://<app>.fly.dev/`. ALWAYS return this URL to the user at run start — the live view is the during-the-run window; recorded clips are the after-the-fact proof. Visiting the URL WAKES a stopped Fly machine (auto_start) — a "waking up" screen shows progress (~40s to pixels), then you watch Chrome itself boot.

## Stream token
Set `OSBORN_STREAM_TOKEN` and the viewer + `/stream` require `?key=<token>`. SET THIS when self-hosting: a public stream URL both shows your browser AND wakes your machine (compute cost). Default open is for solo/dev use only.

## Casting into a meeting — NO TUNNELS (policy)
The meeting cast chain: engine's public MJPEG → agent `POST /canvas {"kind":"show","mode":"stream","url":"https://<engine>.fly.dev"}` → meeting-canvas `<img src="{url}/stream">` → Recall bot camera. The feed URL must be PUBLIC:
- **Never tunnel a local engine.** ngrok's free tier burned its entire monthly bandwidth cap on ONE continuous-MJPEG demo (`ERR_NGROK_725`, everything 403 until reset), and free URLs rotate every restart.
- **The sanctioned path**: run the engine on its Fly machine — `:8080` is already public, stable, uncapped.

## Browse requests while casting
When the canvas is in `stream` mode, "pull up X / show them Y" means: make the STREAMED BROWSER go there (`/act` or `/tab navigate` on the engine). Do NOT flip the canvas to link/web mode — that silently replaces the live browser feed with a static card (observed failure: a "PULLING UP youtube.com" card replaced the stream mid-meeting).
