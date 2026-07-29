// Prebuild: snapshot tests/voice-e2e into public/voice-e2e-bundle.json so the
// /api/test-skill/bundle endpoint can serve it in deployments where the repo's
// tests/ directory is pruned from the runtime container (Railway).
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..', '..', 'tests', 'voice-e2e')
const out = join(__dirname, '..', 'public', 'voice-e2e-bundle.json')

const HARNESS_VERSION = 2
const INCLUDE_DIRS = ['lib', 'specs', 'scenarios', 'scripts']
const INCLUDE_ROOT = ['package.json', 'playwright.config.ts', 'Dockerfile', 'fly.toml', '.gitignore', '.dockerignore']
const TEXT_EXT = /\.(ts|js|json|yaml|yml|sh|md|toml|gitignore|dockerignore)$|^Dockerfile$/

if (!existsSync(root)) {
  console.warn('[harness-bundle] tests/voice-e2e not found — keeping existing bundle if any')
  process.exit(0)
}
const files = {}
for (const f of INCLUDE_ROOT) {
  const p = join(root, f)
  if (existsSync(p)) files[f] = readFileSync(p, 'utf8')
}
for (const dir of INCLUDE_DIRS) {
  const d = join(root, dir)
  if (!existsSync(d)) continue
  for (const f of readdirSync(d)) {
    const p = join(d, f)
    if (statSync(p).isFile() && (TEXT_EXT.test(f) || f === 'Dockerfile')) files[`${dir}/${f}`] = readFileSync(p, 'utf8')
  }
}
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify({ version: HARNESS_VERSION, generatedAt: new Date().toISOString(), files }))
console.log(`[harness-bundle] wrote ${Object.keys(files).length} files to public/voice-e2e-bundle.json`)
