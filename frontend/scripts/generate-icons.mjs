// PWA/app icon generation (2026-10-24 mobile branch, P1.3).
// Rasterizes src/app/icon.svg (32-viewBox amber mic badge) into the PNG set
// referenced by layout.tsx metadata + public/manifest.webmanifest:
//   icon-192 / icon-512        — manifest + favicon-class
//   apple-touch-icon.png (180) — iOS home screen. Flattened onto the app
//                                background (#0c0b09): iOS composites BLACK
//                                behind transparent PNGs, so alpha would rim
//                                the circle. Solid square is the safe shape.
//   maskable-512               — glyph scaled to ~80% on the same background,
//                                inside the maskable safe zone (Android
//                                adaptive icons crop up to ~20% edge).
// Runs from `prebuild` alongside the other bundlers; committed outputs live
// in public/icons/. Skip guard: re-runs are cheap, but CI caches make the
// mtime check worth it.
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const src = join(root, 'src', 'app', 'icon.svg')
const outDir = join(root, 'public', 'icons')
const BG = '#0c0b09'

const svg = await readFile(src, 'utf8')
await mkdir(outDir, { recursive: true })

// Plain (transparent) renders — the circle fills the viewBox.
for (const size of [192, 512]) {
  const target = join(outDir, `icon-${size}.png`)
  await sharp(Buffer.from(svg)).resize(size, size).png().toFile(target)
  console.log(`[icons] ${relative(root, target)}`)
}

// Apple touch icon: 180×180, flattened onto the app background.
{
  const target = join(outDir, 'apple-touch-icon.png')
  await sharp(Buffer.from(svg))
    .resize(180, 180)
    .flatten({ background: BG })
    .png()
    .toFile(target)
  console.log(`[icons] ${relative(root, target)}`)
}

// Maskable: glyph at 80% centered on a full-bleed background square.
{
  const target = join(outDir, 'maskable-512.png')
  const glyph = await sharp(Buffer.from(svg)).resize(410, 410).png().toBuffer()
  await sharp({
    create: { width: 512, height: 512, channels: 4, background: BG },
  })
    .composite([{ input: glyph, gravity: 'center' }])
    .png()
    .toFile(target)
  console.log(`[icons] ${relative(root, target)}`)
}
