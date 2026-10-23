#!/usr/bin/env node
/**
 * Generate the /industries scenario hero images with Fireworks AI (FLUX).
 *
 * Reads FIREWORKS_API_KEY from env (same key as the fast brain / refine route),
 * renders each scene 16:9, and writes public/industries/<slug>.jpg. The
 * ScenarioImage component picks them up automatically — no code change.
 *
 * Usage (key stays in your hands):
 *   FIREWORKS_API_KEY=fw_… node frontend/scripts/gen-industry-images.mjs
 *   FORCE=1 …                      # regenerate even if the file exists
 *   MODEL=flux-1-schnell-fp8 …     # faster/cheaper (default: flux-1-dev-fp8)
 *
 * Prompts mirror src/lib/scenarios.ts (imagePrompt). Keep them in sync.
 */

import { writeFile, mkdir, access } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(__dirname, '../public/industries')

const MODEL = process.env.MODEL || 'flux-1-dev-fp8'
const KEY = process.env.FIREWORKS_API_KEY
const FORCE = process.env.FORCE === '1'

// Appended to every prompt — belt-and-suspenders against text/logo artifacts.
const HOUSE = 'dark premium palette, one warm amber accent glow, cinematic lighting, shallow depth of field, photorealistic, high detail, no on-screen text, no words, no logos, no watermark'

const SCENES = [
  { slug: 'drivers', prompt: "Cinematic first-person POV from a driver's seat at dusk, warm amber ambient cabin lighting, dark premium interior, hands relaxed on a steering wheel, a large glowing dashboard screen ahead softly displaying streaming code and a merged pull request, a subtle luminous voice waveform reflected on the windshield, moody high-contrast, calm and in-control mood" },
  { slug: 'meeting-room', prompt: 'Cinematic wide shot of a modern enterprise glass-walled boardroom, several professionals mid-discussion around a table, a large wall screen quietly showing a live transcript turning into shipped action items and code, warm amber accent glow against cool daylight, a soft glowing voice orb on the screen, premium and calm' },
  { slug: 'gamers', prompt: 'Cinematic first-person POV at a dark RGB-lit gaming battlestation at night, hands on a controller and keyboard, a large ultrawide monitor showing a game paused beside a second panel streaming code and a deploying build, moody cyan-and-amber ambient glow, a glowing voice waveform overlay, immersive high-contrast' },
  { slug: 'onboarding', prompt: 'Cinematic shot of a relaxed new employee at a clean modern desk wearing a headset, smiling slightly while speaking, a large monitor showing a friendly guided setup and streaming code, warm natural window light with a soft amber accent, a glowing voice orb on screen, welcoming and calm' },
  { slug: 'remote-meeting-assistant', prompt: 'Cinematic over-the-shoulder shot of a person in a home office on a video call grid shown on a large screen, a side panel showing the agent turning the spoken conversation into shipped tasks and code, warm desk lamp glow with cool screen light, a subtle glowing voice waveform, premium focused mood' },
  { slug: 'multi-speaker', prompt: 'Cinematic shot of four colleagues gathered around a single large table-top screen in a warm modern workspace, all talking and gesturing, the screen showing multiple attributed voice threads merging into one stream of shipped work, warm amber ambient glow, glowing multi-source waveform visualization, energetic yet premium' },
]

async function exists(p) {
  try { await access(p); return true } catch { return false }
}

async function generate({ slug, prompt }) {
  const out = resolve(OUT_DIR, `${slug}.jpg`)
  if (!FORCE && (await exists(out))) {
    console.log(`• ${slug}: exists, skipping (FORCE=1 to redo)`)
    return 'skip'
  }
  const url = `https://api.fireworks.ai/inference/v1/workflows/accounts/fireworks/models/${MODEL}/text_to_image`
  const t0 = Date.now()
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      Accept: 'image/jpeg',
    },
    body: JSON.stringify({
      prompt: `${prompt}, ${HOUSE}`,
      aspect_ratio: '16:9',
      guidance_scale: 3.5,
    }),
  })
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '')
    throw new Error(`${slug}: HTTP ${resp.status} ${detail.slice(0, 200)}`)
  }
  const buf = Buffer.from(await resp.arrayBuffer())
  await writeFile(out, buf)
  console.log(`✓ ${slug}: ${(buf.length / 1024).toFixed(0)} KB in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  return 'ok'
}

async function main() {
  if (!KEY) {
    console.error('Missing FIREWORKS_API_KEY. Run: FIREWORKS_API_KEY=fw_… node frontend/scripts/gen-industry-images.mjs')
    process.exit(1)
  }
  await mkdir(OUT_DIR, { recursive: true })
  console.log(`Generating ${SCENES.length} images with ${MODEL} → ${OUT_DIR}\n`)
  let ok = 0, fail = 0
  for (const scene of SCENES) {
    try { if ((await generate(scene)) !== 'skip') ok++ }
    catch (e) { fail++; console.error(`✗ ${e.message}`) }
  }
  console.log(`\nDone: ${ok} generated, ${fail} failed.`)
  process.exit(fail ? 1 : 0)
}

main()
