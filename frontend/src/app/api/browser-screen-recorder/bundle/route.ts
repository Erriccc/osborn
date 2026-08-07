import { NextResponse } from 'next/server'
import { readFileSync, readdirSync, existsSync, statSync } from 'fs'
import { join } from 'path'

export const dynamic = 'force-dynamic'

/**
 * Browser Screen Recorder harness bundle — accompanying files for the
 * browser-screen-recorder skill (/api/browser-screen-recorder). Serves the
 * harness source as JSON { version, files } so an installing agent can write
 * them to disk. Read live from the repo checkout that ships alongside the
 * frontend (Railway deploys the full repo); falls back to the build-time
 * snapshot in deployments that prune tests/.
 *
 * The harness source dir is still tests/voice-e2e/ internally (the skill was
 * renamed from voice-e2e; the source tree keeps its path). The public bundle
 * filename is browser-screen-recorder-bundle.json, with a fallback to the
 * legacy voice-e2e-bundle.json name.
 */
// Derived from the served skill's `Version:` line — the single source of truth
// (same as build-harness-bundle.mjs), so the live-repo fallback can never drift
// from the snapshot. It used to be hardcoded and stuck at 5 while the skill was
// at 22, silently serving the wrong version whenever tests/ was present.
function deriveHarnessVersion(root: string): number {
  try { return Number(readFileSync(join(root, 'SKILL.served.md'), 'utf8').match(/^Version: (\d+)$/m)?.[1] ?? 0) } catch { return 0 }
}

const INCLUDE_DIRS = ['lib', 'specs', 'scenarios', 'scripts']
const INCLUDE_ROOT = ['package.json', 'playwright.config.ts', 'Dockerfile', 'fly.toml', '.gitignore', '.dockerignore']
const TEXT_EXT = /\.(ts|js|json|yaml|yml|sh|md|toml|gitignore|dockerignore)$|^Dockerfile$/

export async function GET() {
  // Prefer the build-time snapshot (survives containers that prune tests/);
  // fall back to the live repo dir for local dev freshness.
  const snapshot = join(process.cwd(), 'public', 'browser-screen-recorder-bundle.json')
  const legacySnapshot = join(process.cwd(), 'public', 'voice-e2e-bundle.json')
  const root = join(process.cwd(), '..', 'tests', 'voice-e2e')
  if (!existsSync(root)) {
    const snap = existsSync(snapshot) ? snapshot : (existsSync(legacySnapshot) ? legacySnapshot : null)
    if (snap) {
      return new NextResponse(readFileSync(snap, 'utf8'), {
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
  return NextResponse.json({ version: deriveHarnessVersion(root), generatedAt: new Date().toISOString(), files })
}
