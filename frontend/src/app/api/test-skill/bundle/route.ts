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
const HARNESS_VERSION = 2

const INCLUDE_DIRS = ['lib', 'specs', 'scenarios', 'scripts']
const INCLUDE_ROOT = ['package.json', 'playwright.config.ts', 'Dockerfile', 'fly.toml', '.gitignore', '.dockerignore']
const TEXT_EXT = /\.(ts|js|json|yaml|yml|sh|md|toml|gitignore|dockerignore)$|^Dockerfile$/

export async function GET() {
  // Prefer the build-time snapshot (survives containers that prune tests/);
  // fall back to the live repo dir for local dev freshness.
  const snapshot = join(process.cwd(), 'public', 'voice-e2e-bundle.json')
  const root = join(process.cwd(), '..', 'tests', 'voice-e2e')
  if (!existsSync(root)) {
    if (existsSync(snapshot)) {
      return new NextResponse(readFileSync(snapshot, 'utf8'), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      })
    }
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
