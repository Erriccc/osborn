# send-media — deliver screenshots, images, and files to the user INLINE in chat

> 📅 Last updated: 2026-08-09. Use whenever you have a local file the user should SEE
> (screenshots, UI captures, generated images, PDFs, clips). Never describe an image
> you could just show.

## How it works
The osborn frontend exposes a public upload endpoint that stores files in the
`osborn-storage` Supabase bucket and returns a permanent PUBLIC url — the exact same
mechanism the user's app uses when they send you screenshots.

## The one command
```bash
curl -s -X POST "https://www.voice-native.com/api/upload" \
  -F "file=@/path/to/screenshot.png"
```
Response JSON contains `url` (the public URL). Extract it:
```bash
URL=$(curl -s -X POST "https://www.voice-native.com/api/upload" -F "file=@/tmp/shot.png" | python3 -c "import sys,json;print(json.load(sys.stdin)['url'])")
```
Optional form fields: `userId`, `sessionId` (namespace the storage path; omitting them is fine — guest uploads are allowed).

## Then render it inline
Put the URL in your NEXT REPLY as a markdown image/link — the app renders these:
```
[Image: nav-mobile-390px.png](https://frzbawsadhmmltokvexj.supabase.co/storage/v1/object/public/osborn-storage/...)
```
- One line per file, descriptive name in the label.
- For multiple screenshots (mobile/tablet/desktop), upload all, then list all links in one message.
- Also fine for non-images (PDF, mp4, logs) — same flow, the link downloads/plays.

## Rules
- ALWAYS send visual proof this way after browser-screen-recorder runs, UI checks, or when the user asks "share the screenshot" — files written to the session workspace are NOT visible to the user on mobile; this IS the delivery path.
- If curl fails (endpoint down), fall back to describing the image AND give the local path.
- Never upload files containing secrets/credentials — the URL is public.
