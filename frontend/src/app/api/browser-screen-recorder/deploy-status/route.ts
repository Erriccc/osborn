import { NextRequest, NextResponse } from 'next/server'
import { readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Heartbeat of the harness auto-deploy check (harness-deploy-check.ts writes
// it via a tmp file — instrumentation and routes can live in separate
// bundles, so module state wouldn't be shared). null lastRunAt after a fresh
// boot means the check hasn't fired yet; a stale timestamp (>20min) means
// the interval died. One GET answers "is the orchestrator alive?".
// ?run=1 triggers the check RIGHT NOW and returns its outcome — live
// diagnosis of the instrumentation path without Railway log access.
export async function GET(req: NextRequest) {
  let ran: string | null = null
  if (req.nextUrl.searchParams.get('run') === '1') {
    try {
      const { checkHarnessDeploy } = await import('@/lib/harness-deploy-check')
      await checkHarnessDeploy()
      ran = 'invoked synchronously'
    } catch (e) {
      ran = `import/run failed: ${(e as Error).message.slice(0, 300)}`
    }
  }
  try {
    const raw = readFileSync(join(tmpdir(), 'bsr-deploy-check.json'), 'utf8')
    return NextResponse.json({ ...JSON.parse(raw), ran }, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return NextResponse.json({ lastRunAt: null, result: 'not run since boot', ran }, { headers: { 'Cache-Control': 'no-store' } })
  }
}
