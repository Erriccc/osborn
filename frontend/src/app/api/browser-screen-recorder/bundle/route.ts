import { NextResponse } from 'next/server'
import { readFileSync } from 'fs'
import { join } from 'path'

export const dynamic = 'force-dynamic'

/**
 * Browser Screen Recorder harness bundle — accompanying files for the
 * browser-screen-recorder skill (/api/browser-screen-recorder), as JSON
 * { version, files } so an installing agent can write them to disk. Serves the
 * snapshot frontend/scripts/build-harness-bundle.mjs builds from tests/voice-e2e
 * (committed, and kept in sync by CI).
 */
export async function GET() {
  try {
    const bundle = readFileSync(join(process.cwd(), 'public', 'browser-screen-recorder-bundle.json'), 'utf8')
    return new NextResponse(bundle, {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    })
  } catch {
    return NextResponse.json({ error: 'harness bundle missing from this deployment — check that the prebuild ran (frontend/scripts/build-harness-bundle.mjs)' }, { status: 503 })
  }
}
