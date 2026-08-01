// Prebuild: snapshot tests/voice-e2e into the harness bundle JSON so the
// /api/browser-screen-recorder/bundle endpoint (and its legacy /api/test-skill/bundle
// alias) can serve it in deployments where the repo's tests/ directory is pruned
// from the runtime container (Railway). Writes both the new bundle filename and
// the legacy one for backwards compatibility.
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..', '..', 'tests', 'voice-e2e')
const out = join(__dirname, '..', 'public', 'browser-screen-recorder-bundle.json')
const legacyOut = join(__dirname, '..', 'public', 'voice-e2e-bundle.json')

// SINGLE SOURCE OF TRUTH: tests/voice-e2e/SKILL.served.md carries the served
// skill text AND its Version: line — this script copies it into public/ and
// derives the bundle version from it. A git push IS the skill release.
const servedSkillPath = join(root, 'SKILL.served.md')
const servedSkill = existsSync(servedSkillPath) ? readFileSync(servedSkillPath, 'utf8') : null
const HARNESS_VERSION = Number(servedSkill?.match(/^Version: (\d+)$/m)?.[1] ?? 6)
if (servedSkill) {
  writeFileSync(join(__dirname, '..', 'public', 'browser-screen-recorder-skill.md'), servedSkill)
  console.log(`[harness-bundle] served skill v${HARNESS_VERSION} copied to public/browser-screen-recorder-skill.md`)
}
const INCLUDE_DIRS = ['lib', 'specs', 'scenarios', 'scripts', 'references']
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
// fixtures/ is binary (WAVs) and can't ride a text bundle — but the
// Dockerfile COPYs it, so a materialized build context MUST have the dir
// (first autonomous orchestrator deploy failed on exactly this: COPY
// fixtures → "/fixtures": not found). Runtime doesn't need the WAVs — the
// reactive mic synthesizes speech.
files['fixtures/.keep'] = '# placeholder — WAV fixtures are optional; the reactive mic synthesizes speech at runtime\n'
mkdirSync(dirname(out), { recursive: true })
const payload = JSON.stringify({ version: HARNESS_VERSION, generatedAt: new Date().toISOString(), files })
writeFileSync(out, payload)
writeFileSync(legacyOut, payload) // legacy alias for /api/test-skill/bundle
console.log(`[harness-bundle] wrote ${Object.keys(files).length} files to public/browser-screen-recorder-bundle.json (+ legacy voice-e2e-bundle.json)`)
