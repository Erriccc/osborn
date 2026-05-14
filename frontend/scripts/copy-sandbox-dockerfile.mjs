/**
 * Prebuild step — copies agent/Dockerfile.sandbox into frontend/ so it lands
 * at /app/Dockerfile.sandbox on Railway. Without this, the auto-publish flow
 * (image-build-check.ts) calls `fly deploy` from /app referencing the build
 * config's `dockerfile = "../agent/Dockerfile.sandbox"`, which resolves to
 * /agent/Dockerfile.sandbox — a path that doesn't exist on Railway because
 * the deploy root is only the frontend/ subtree.
 *
 * Runs in two paths:
 *   - Local: `npm run build` runs `prebuild` (this script), then `next build`
 *   - Railway: same — nixpacks runs `npm run build` which triggers prebuild
 *
 * Idempotent — overwrites on every build so the bundled Dockerfile stays in
 * sync with the canonical agent/Dockerfile.sandbox source.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const frontendDir = resolve(__dirname, '..')
const repoRoot = resolve(frontendDir, '..')

const src = join(repoRoot, 'agent', 'Dockerfile.sandbox')
const dst = join(frontendDir, 'Dockerfile.sandbox')

if (!existsSync(src)) {
  console.error(`[prebuild-sandbox] source missing: ${src}`)
  console.error(`[prebuild-sandbox] If running outside the monorepo this is expected — skipping.`)
  process.exit(0)
}

mkdirSync(dirname(dst), { recursive: true })
copyFileSync(src, dst)
console.log(`[prebuild-sandbox] copied ${src}`)
console.log(`[prebuild-sandbox]     → ${dst}`)
