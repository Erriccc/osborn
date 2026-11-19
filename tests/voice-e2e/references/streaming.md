# Streaming & casting — live view, meetings, tokens

## Live view — private by default (v55)
`startLiveStream()` serves an MJPEG viewer: locally `http://127.0.0.1:8080/`, on Fly the machine's public `https://<app>.fly.dev/`. Visiting the URL WAKES a stopped Fly machine (auto_start) — a "waking up" screen shows progress (~40s to pixels).

The engine is shared by several drivers and signed-in people, so no viewer ever sees the fronted tab:
- **Public viewer and `/stream`**: only the tab a driver CAST, else a "Nothing is being shared" frame. `POST /tab {"op":"cast","i":n}` shares one of YOUR tabs (`409 not_your_tab` otherwise); `{"op":"uncast"}` stops it (the caster or the tab's owner). Closing or releasing the tab ends the cast. `/status.cast` = `{i, by}` or null. Cast a tab before giving the user this URL.
- **Your own tab, privately**: `GET /stream` on the control API (`x-engine-token` + `x-driver-id`; over 443 as `https://<app>.fly.dev/control/stream`) — MJPEG of your current tab, following it as you switch; `?tab=i` for another tab you own (`409 not_your_tab` otherwise); "Nothing is being shared" while you have no tab. The in-app /browser panel shows each person this stream of their own tab.
- Frames come from each tab's own recorder (960 wide), so a display-mode engine's viewers see the page, not the whole window with its tab strip.

## Stream token
Set `OSBORN_STREAM_TOKEN` and the viewer + `/stream` require `?key=<token>`. SET THIS when self-hosting: a public stream URL both shows your browser AND wakes your machine (compute cost). Default open is for solo/dev use only.

## Casting into a meeting — NO TUNNELS (policy)
The meeting cast chain: **cast your tab** (`POST /tab {"op":"cast","i":n}`) → engine's public MJPEG → agent `POST /canvas {"kind":"show","mode":"stream","url":"https://<engine>.fly.dev"}` → meeting-canvas `<img src="{url}/stream">` → Recall bot camera. Without a cast the camera shows "Nothing is being shared". When you navigate or act in the cast tab the camera follows; switching to another tab does not move the cast (cast that tab instead). `uncast` when the demo is over. Use your own driver id (`x-driver-id`) and your own tab: tab 0 and unowned tabs cannot be cast. A takeover of the cast tab stops the cast (a person signing in is never broadcast). The cast survives a restart. The feed URL must be PUBLIC:
- **Never tunnel a local engine.** ngrok's free tier burned its entire monthly bandwidth cap on ONE continuous-MJPEG demo (`ERR_NGROK_725`, everything 403 until reset), and free URLs rotate every restart.
- **The sanctioned path**: run the engine on its Fly machine — `:8080` is already public, stable, uncapped.

## Browse requests while casting
When the canvas is in `stream` mode, "pull up X / show them Y" means: make the STREAMED BROWSER go there (`/act` or `/tab navigate` on the engine). Do NOT flip the canvas to link/web mode — that silently replaces the live browser feed with a static card (observed failure: a "PULLING UP youtube.com" card replaced the stream mid-meeting).
