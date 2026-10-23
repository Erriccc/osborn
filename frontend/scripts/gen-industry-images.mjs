#!/usr/bin/env node
/**
 * Generate the /industries scenario hero images and write them to
 * public/industries/<slug>.<ext>. The ScenarioImage component picks them up
 * automatically (it points at <slug> + whatever extension we save).
 *
 * Providers (auto-detected by which key is in the environment):
 *   GEMINI_API_KEY   → Google Generative Language API (gemini image models;
 *                      has a free tier). DEFAULT when present.
 *   OPENROUTER_API_KEY / OPENROUTER_WORKSPACE_API_KEY → OpenRouter image models
 *                      (needs ≥$1 OpenRouter balance for image output).
 *
 * Usage:
 *   GEMINI_API_KEY=… node frontend/scripts/gen-industry-images.mjs
 *   OPENROUTER_WORKSPACE_API_KEY=… node frontend/scripts/gen-industry-images.mjs
 *   FORCE=1 …                       # regenerate even if a file exists
 *   MODEL=…                         # override the provider's default model
 *
 * Prints the final slug→filename map so scenarios.ts can be aligned if the
 * provider returns PNG (default jpg paths). Prompts mirror src/lib/scenarios.ts.
 */

import { writeFile, mkdir, readdir, unlink, access } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(__dirname, '../public/industries')
const FORCE = process.env.FORCE === '1'

const HOUSE = 'widescreen 16:9 aspect ratio, dark premium palette, one warm amber accent glow, cinematic lighting, shallow depth of field, photorealistic, high detail, no on-screen text, no words, no logos, no watermark'

const SCENES = [
  { slug: 'drivers', prompt: "Cinematic first-person POV from a driver's seat at dusk, warm amber ambient cabin lighting, dark premium interior, hands relaxed on a steering wheel, a large glowing dashboard screen ahead softly displaying streaming code and a merged pull request, a subtle luminous voice waveform reflected on the windshield, moody high-contrast, calm and in-control mood" },
  { slug: 'meeting-room', prompt: 'Cinematic wide shot of a modern enterprise glass-walled boardroom, several professionals mid-discussion around a table, a large wall screen quietly showing a live transcript turning into shipped action items and code, warm amber accent glow against cool daylight, a soft glowing voice orb on the screen, premium and calm' },
  { slug: 'gamers', prompt: 'Cinematic first-person POV at a dark RGB-lit gaming battlestation at night, hands on a controller and keyboard, a large ultrawide monitor showing a game paused beside a second panel streaming code and a deploying build, moody cyan-and-amber ambient glow, a glowing voice waveform overlay, immersive high-contrast' },
  { slug: 'onboarding', prompt: 'Cinematic shot of a relaxed new employee at a clean modern desk wearing a headset, smiling slightly while speaking, a large monitor showing a friendly guided setup and streaming code, warm natural window light with a soft amber accent, a glowing voice orb on screen, welcoming and calm' },
  { slug: 'remote-meeting-assistant', prompt: 'Cinematic over-the-shoulder shot of a person in a home office on a video call grid shown on a large screen, a side panel showing the agent turning the spoken conversation into shipped tasks and code, warm desk lamp glow with cool screen light, a subtle glowing voice waveform, premium focused mood' },
  { slug: 'multi-speaker', prompt: 'Cinematic shot of four colleagues gathered around a single large table-top screen in a warm modern workspace, all talking and gesturing, the screen showing multiple attributed voice threads merging into one stream of shipped work, warm amber ambient glow, glowing multi-source waveform visualization, energetic yet premium' },
]

const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
const OR_KEY = process.env.OPENROUTER_WORKSPACE_API_KEY || process.env.OPENROUTER_API_KEY

const extFromMime = (m) => (m.includes('png') ? 'png' : m.includes('webp') ? 'webp' : 'jpg')

async function removeExisting(slug) {
  const files = await readdir(OUT_DIR).catch(() => [])
  for (const f of files) if (f.startsWith(slug + '.') && f !== slug + '.md') await unlink(resolve(OUT_DIR, f)).catch(() => {})
}

async function anyExists(slug) {
  for (const ext of ['jpg', 'png', 'webp']) {
    try { await access(resolve(OUT_DIR, `${slug}.${ext}`)); return `${slug}.${ext}` } catch {}
  }
  return null
}

// ── Google Gemini (generativelanguage) ──────────────────────────────────────
async function genGemini(prompt, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `${prompt}, ${HOUSE}` }] }],
      generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '16:9' } },
    }),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 220)}`)
  const j = await r.json()
  const part = (j?.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData || p.inline_data)
  const inline = part?.inlineData || part?.inline_data
  if (!inline?.data) throw new Error(`no image in response ${JSON.stringify(j).slice(0, 220)}`)
  return { buf: Buffer.from(inline.data, 'base64'), ext: extFromMime(inline.mimeType || inline.mime_type || 'image/png') }
}

// ── OpenRouter (chat completions, image modality) ───────────────────────────
async function genOpenRouter(prompt, model) {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OR_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, modalities: ['image', 'text'], messages: [{ role: 'user', content: `${prompt}, ${HOUSE}` }] }),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 220)}`)
  const j = await r.json()
  const dataUri = j?.choices?.[0]?.message?.images?.[0]?.image_url?.url
  if (!dataUri) throw new Error(`no image in response ${JSON.stringify(j?.error || j).slice(0, 220)}`)
  const m = dataUri.match(/^data:([^;]+);base64,(.*)$/)
  if (!m) throw new Error('unexpected image url format')
  return { buf: Buffer.from(m[2], 'base64'), ext: extFromMime(m[1]) }
}

async function main() {
  const gemini = !!GEMINI_KEY
  if (!gemini && !OR_KEY) {
    console.error('Set GEMINI_API_KEY (preferred) or OPENROUTER_WORKSPACE_API_KEY.')
    process.exit(1)
  }
  const provider = gemini ? 'gemini' : 'openrouter'
  const model = process.env.MODEL || (gemini ? 'gemini-2.5-flash-image' : 'google/gemini-3-pro-image')
  const gen = gemini ? genGemini : genOpenRouter

  await mkdir(OUT_DIR, { recursive: true })
  console.log(`Provider: ${provider} · model: ${model} · out: ${OUT_DIR}\n`)
  let ok = 0, fail = 0
  const map = {}
  for (const { slug, prompt } of SCENES) {
    const existing = await anyExists(slug)
    if (!FORCE && existing) { console.log(`• ${slug}: exists (${existing}), skipping`); map[slug] = existing; continue }
    const t0 = Date.now()
    try {
      const { buf, ext } = await gen(prompt, model)
      await removeExisting(slug)
      const name = `${slug}.${ext}`
      await writeFile(resolve(OUT_DIR, name), buf)
      map[slug] = name
      ok++
      console.log(`✓ ${slug}: ${name} ${(buf.length / 1024).toFixed(0)}KB in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    } catch (e) { fail++; console.error(`✗ ${slug}: ${e.message}`) }
  }
  console.log(`\nDone: ${ok} ok, ${fail} failed.`)
  console.log('slug→file map:', JSON.stringify(map))
  process.exit(fail && !ok ? 1 : 0)
}

main()
