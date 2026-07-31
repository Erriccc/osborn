import { NextResponse } from 'next/server'
import { readFileSync } from 'fs'
import { join } from 'path'

// Serves the browser-screen-recorder skill from the file the build copies out
// of tests/voice-e2e/SKILL.served.md (single source of truth — edit THAT file;
// a git push is the release). No more hardcoded skill text in this route.
export async function GET() {
  try {
    const md = readFileSync(join(process.cwd(), 'public', 'browser-screen-recorder-skill.md'), 'utf8')
    return new NextResponse(md, {
      headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' },
    })
  } catch {
    return new NextResponse(
      '# browser-screen-recorder\nSkill file missing from this deployment — check that the prebuild ran (frontend/scripts/build-harness-bundle.mjs) with tests/voice-e2e/SKILL.served.md present.',
      { status: 500, headers: { 'Content-Type': 'text/markdown; charset=utf-8' } },
    )
  }
}
