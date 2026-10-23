# Voice Native — hands-free scenario image prompts

Cinematic hero images for the `/industries` gallery and the niche pages
(`/drivers`, etc). Generate each, then drop the file at the exact path below —
the page swaps the placeholder for your render automatically (no code change).

## Fastest path — generate all of them with Fireworks (FLUX)

One command renders every scene 16:9 into `public/industries/` using the same
Fireworks key the fast brain uses:

```
FIREWORKS_API_KEY=fw_… node frontend/scripts/gen-industry-images.mjs
```

Flags: `FORCE=1` redo existing · `MODEL=flux-1-schnell-fp8` faster/cheaper
(default `flux-1-dev-fp8`, higher quality). Then review and commit the JPGs.
Prefer a different tool? The per-scene prompts are below.

**Where files go:** `frontend/public/industries/<slug>.jpg`
(e.g. `frontend/public/industries/drivers.jpg`). Served at `/industries/<slug>.jpg`.

**Format:** 16:9, landscape. JPG or WEBP, ~1600×900+ (hero slots render up to ~600px wide, 2× for retina). Keep files < ~400 KB.

**House style (append to every prompt for consistency):**
> dark premium palette, one warm amber accent glow, calm and in-control mood,
> cinematic lighting, shallow depth of field, photorealistic, high detail,
> no on-screen text, no logos, no watermark, 16:9.

**Style note:** `cabin` scenes are first-person POV (the viewer IS hands-free).
`scene` scenes show a relaxed person / room with work shipping on a screen.

---

## drivers  → `public/industries/drivers.jpg`  (cabin / POV)
Cinematic first-person POV from a driver's seat at dusk, warm amber ambient cabin lighting, dark premium interior, hands relaxed on a steering wheel, a large glowing dashboard screen ahead softly displaying streaming code and a merged pull request, a subtle luminous voice waveform reflected on the windshield, shallow depth of field, moody high-contrast, calm and in-control mood, photorealistic, 16:9.

## meeting-room  → `public/industries/meeting-room.jpg`  (scene)
Cinematic wide shot of a modern enterprise glass-walled boardroom, several professionals mid-discussion around a table, a large wall screen quietly showing a live transcript turning into shipped action items and code, warm amber accent glow against cool daylight, a soft glowing voice orb on the screen, premium and calm, photorealistic, shallow depth of field, 16:9.

## gamers  → `public/industries/gamers.jpg`  (cabin / POV)
Cinematic first-person POV at a dark RGB-lit gaming battlestation at night, hands on a controller/keyboard, a large ultrawide monitor showing a game paused beside a second panel streaming code and a deploying build, moody cyan-and-amber ambient glow, a glowing voice waveform overlay, photorealistic, high-contrast, immersive, 16:9.

## onboarding  → `public/industries/onboarding.jpg`  (scene)
Cinematic shot of a relaxed new employee at a clean modern desk wearing a headset, smiling slightly while speaking, a large monitor showing a friendly guided setup and streaming code, warm natural window light with a soft amber accent, a glowing voice orb on screen, welcoming and calm, photorealistic, shallow depth of field, 16:9.

## remote-meeting-assistant  → `public/industries/remote-meeting-assistant.jpg`  (scene)
Cinematic over-the-shoulder shot of a person in a home office on a video call grid on a large screen, a side panel showing the agent turning the spoken conversation into shipped tasks and code, warm desk lamp glow with cool screen light, a subtle glowing voice waveform, premium and focused mood, photorealistic, shallow depth of field, 16:9.

## multi-speaker  → `public/industries/multi-speaker.jpg`  (scene)
Cinematic shot of three or four colleagues gathered around a single large table-top screen in a warm modern workspace, all talking and gesturing, the screen showing multiple attributed voice threads merging into one stream of shipped work, warm amber ambient glow, glowing multi-source waveform visualization, energetic yet premium, photorealistic, shallow depth of field, 16:9.

---

Prompts live in code too: `frontend/src/lib/scenarios.ts` (the `imagePrompt`
field) is the single source — edit there and here together if you tweak a scene.
