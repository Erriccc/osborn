import { NextResponse } from 'next/server'
import { readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Heartbeat of the harness auto-deploy check (harness-deploy-check.ts writes
// it via a tmp file — instrumentation and routes can live in separate
// bundles, so module state wouldn't be shared). null lastRunAt after a fresh
// boot means the check hasn't fired yet; a stale timestamp (>20min) means
// the interval died. One GET answers "is the orchestrator alive?".
export async function GET() {
  try {
    const raw = readFileSync(join(tmpdir(), 'bsr-deploy-check.json'), 'utf8')
    return NextResponse.json(JSON.parse(raw), { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return NextResponse.json({ lastRunAt: null, result: 'not run since boot' }, { headers: { 'Cache-Control': 'no-store' } })
  }
}
