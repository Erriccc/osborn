import { NextResponse } from 'next/server'
import { readFileSync, readdirSync, existsSync, statSync } from 'fs'
import { join } from 'path'

export const dynamic = 'force-dynamic'

/**
 * Voice-E2E harness bundle — accompanying files for the voice-e2e skill
 * (/api/test-skill). Serves the harness source as JSON { version, files }
 * so an installing agent can write them to disk. Read live from the repo
 * checkout that ships alongside the frontend (Railway deploys the full repo).
 */
const HARNESS_VERSION = 1

const INCLUDE_DIRS = ['lib', 'specs', 'scenarios', 'scripts']
const INCLUDE_ROOT = ['package.json', 'playwright.config.ts', 'Dockerfile', 'fly.toml', '.gitignore', '.dockerignore']
const TEXT_EXT = /\.(ts|js|json|yaml|yml|sh|md|toml|gitignore|dockerignore)$|^Dockerfile$/

export async function GET() {
  const root = join(process.cwd(), '..', 'tests', 'voice-e2e')
  if (!existsSync(root)) {
    return NextResponse.json({ error: 'harness source not present in this deployment' }, { status: 503 })
  }
  const files: Record<string, string> = {}
  for (const f of INCLUDE_ROOT) {
    const p = join(root, f)
    if (existsSync(p)) files[f] = readFileSync(p, 'utf8')
  }
  for (const dir of INCLUDE_DIRS) {
    const d = join(root, dir)
    if (!existsSync(d)) continue
    for (const f of readdirSync(d)) {
      const p = join(d, f)
      if (statSync(p).isFile() && (TEXT_EXT.test(f) || f === 'Dockerfile')) {
        files[`${dir}/${f}`] = readFileSync(p, 'utf8')
      }
    }
  }
  return NextResponse.json({ version: HARNESS_VERSION, generatedAt: new Date().toISOString(), files })
}
