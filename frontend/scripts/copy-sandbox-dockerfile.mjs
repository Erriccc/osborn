/**
 * Prebuild step — keeps frontend/Dockerfile.sandbox in sync with the
 * canonical agent/Dockerfile.sandbox source.
 *
 * Background:
 *   Railway's deploy root for this project is frontend/, so agent/ is NOT
 *   available at /app on the Railway dyno. The committed copy at
 *   frontend/Dockerfile.sandbox is what actually ships to production and gets
 *   used by image-build-check.ts → fly deploy --build-only --push.
 *
 * Local dev (agent/ available):
 *   Refreshes frontend/Dockerfile.sandbox from agent/Dockerfile.sandbox so
 *   developers don't have to remember to update both. If the destination
 *   already matches, no-op.
 *
 * Railway (agent/ NOT available):
 *   No-op. The committed frontend/Dockerfile.sandbox is used as-is.
 *
 * To update the Dockerfile, edit agent/Dockerfile.sandbox, run `npm run build`
 * once locally (or `node frontend/scripts/copy-sandbox-dockerfile.mjs`), and
 * commit the resulting frontend/Dockerfile.sandbox change.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const frontendDir = resolve(__dirname, '..')
const repoRoot = resolve(frontendDir, '..')

const src = join(repoRoot, 'agent', 'Dockerfile.sandbox')
const dst = join(frontendDir, 'Dockerfile.sandbox')

if (!existsSync(src)) {
  // Railway production — agent/ is outside the deploy root. The committed
  // Dockerfile.sandbox in frontend/ is what ships, no refresh needed.
  if (existsSync(dst)) {
    console.log(`[prebuild-sandbox] agent/Dockerfile.sandbox not available (probably Railway) — using committed copy at ${dst}`)
  } else {
    console.error(`[prebuild-sandbox] WARNING: neither ${src} nor ${dst} exists. Image build will fail.`)
  }
  process.exit(0)
}

// Local dev: refresh if content drifted
if (existsSync(dst)) {
  const srcContent = readFileSync(src, 'utf8')
  const dstContent = readFileSync(dst, 'utf8')
  if (srcContent === dstContent) {
    console.log(`[prebuild-sandbox] in sync with ${src} — no change`)
    process.exit(0)
  }
  console.log(`[prebuild-sandbox] drift detected — refreshing from ${src}`)
}

mkdirSync(dirname(dst), { recursive: true })
copyFileSync(src, dst)
console.log(`[prebuild-sandbox] copied ${src}`)
console.log(`[prebuild-sandbox]     → ${dst}`)
console.log(`[prebuild-sandbox] ⚠ Commit the updated frontend/Dockerfile.sandbox so Railway picks it up`)
