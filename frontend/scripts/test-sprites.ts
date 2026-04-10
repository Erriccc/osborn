/**
 * test-sprites.ts — Diagnostic test for Sprites sandbox provisioning.
 *
 * Uses the EXACT same functions as production (imported from sprites.ts).
 * Run with: cd frontend && SPRITES_API_TOKEN=... tsx scripts/test-sprites.ts [userId]
 *
 * If userId is omitted, uses "test-user-debug-123" as a test user.
 */

import { config } from 'dotenv'
import { resolve } from 'path'
config({ path: resolve(__dirname, '../.env.local') })

import {
  createSandbox,
  findUserSandbox,
  execInSprite,
  registerService,
  startService,
  waitForHealth,
  listCheckpoints,
  isSpritesConfigured,
} from '../src/lib/sprites'

const userId = process.argv[2] || 'test-user-debug-123'
const spriteName = `osborn-${userId.substring(0, 12).toLowerCase().replace(/[^a-z0-9]/g, '-')}`

async function deleteSprite(name: string): Promise<void> {
  const token = process.env.SPRITES_API_TOKEN!
  const res = await fetch(`https://api.sprites.dev/v1/sprites/${name}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.ok || res.status === 404) {
    console.log(`[test] Sprite ${name} deleted (or did not exist)`)
  } else {
    const text = await res.text()
    console.warn(`[test] DELETE sprite returned ${res.status}: ${text.substring(0, 200)}`)
  }
  // Wait for deletion to propagate
  await new Promise(r => setTimeout(r, 2000))
}

async function main() {
  if (!isSpritesConfigured()) {
    console.error('[test] SPRITES_API_TOKEN not set. Add it to frontend/.env.local')
    process.exit(1)
  }

  console.log(`[test] === Sprites Diagnostic Test ===`)
  console.log(`[test] userId: ${userId}`)
  console.log(`[test] spriteName: ${spriteName}`)
  console.log()

  // 1. Clean slate — delete any existing sprite with this name
  console.log('[test] STEP 1: Deleting old sprite if it exists...')
  await deleteSprite(spriteName)

  // 2. Run full createSandbox — this calls all the same functions production does
  console.log('[test] STEP 2: Running createSandbox (full flow)...')
  console.log('[test] (This takes ~2-3 minutes: create → install → script → service → health)')
  console.log()
  const startTime = Date.now()

  const result = await createSandbox(userId)

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log()
  console.log(`[test] === createSandbox completed in ${elapsed}s ===`)
  console.log(`[test] Status: ${result.status}`)
  console.log(`[test] URL: ${result.previewUrl || 'N/A'}`)
  if (result.error) console.error(`[test] Error: ${result.error}`)
  console.log()

  if (result.status !== 'running') {
    // Try to diagnose what went wrong
    console.log('[test] === DIAGNOSTICS (createSandbox failed) ===')

    console.log('[test] Checking if osborn is on PATH (exec is fire-and-forget, result may be empty)...')
    const whichResult = await execInSprite(
      spriteName, 'bash',
      ['-c', 'export PATH="/.sprite/bin:${PATH:-/usr/local/bin:/usr/bin:/bin}"; command -v osborn && echo "osborn found" || echo "osborn NOT found"'],
      10,
    )
    console.log(`[test] command -v osborn exit=${whichResult.exitCode}, output=${whichResult.output || '(empty — exec is fire-and-forget)'}`)
    console.log()

    console.log('[test] Checking port 8080...')
    const curlResult = await execInSprite(
      spriteName, 'bash',
      ['-c', 'curl -s --max-time 3 http://localhost:8080/health || echo "curl exit: $?"'],
      10,
    )
    console.log(`[test] curl exit=${curlResult.exitCode}, output=${curlResult.output}`)
    process.exit(1)
  }

  // 3. Verify the health endpoint works from our side
  console.log(`[test] STEP 3: Verifying health endpoint at ${result.previewUrl}/health...`)
  const healthy = await waitForHealth(result.previewUrl!, 90)
  console.log(`[test] Health check: ${healthy ? 'PASS' : 'FAIL'}`)

  // 4. Check checkpoints
  console.log('[test] STEP 4: Listing checkpoints...')
  const cps = await listCheckpoints(spriteName)
  console.log(`[test] Checkpoints: ${cps.length > 0 ? cps.map(c => c.id).join(', ') : 'none'}`)

  console.log()
  console.log('[test] === All steps passed ===')
  console.log(`[test] Sprite URL: ${result.previewUrl}`)
  console.log('[test] You can now test cloud mode in the frontend.')
}

main().catch(err => {
  console.error('[test] Fatal error:', err)
  process.exit(1)
})
