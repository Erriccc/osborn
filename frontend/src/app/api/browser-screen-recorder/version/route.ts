import { NextResponse } from 'next/server'
import { readFileSync } from 'fs'
import { join } from 'path'

// One-GET version probe: installed skills poll this tiny JSON to detect drift
// without downloading the whole skill. The version derives from the served
// skill file (public/browser-screen-recorder-skill.md), which build copies
// from tests/voice-e2e/SKILL.served.md — so a git push updates it.
export async function GET() {
  try {
    const md = readFileSync(join(process.cwd(), 'public', 'browser-screen-recorder-skill.md'), 'utf8')
    const version = Number(md.match(/^Version: (\d+)$/m)?.[1] ?? 0)
    return NextResponse.json({ version }, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return NextResponse.json({ version: 0, error: 'skill file missing' }, { status: 500 })
  }
}
