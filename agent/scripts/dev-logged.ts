/**
 * Dev-logger wrapper: spawns `tsx src/index.ts` as a child, tees its stdout /
 * stderr to BOTH the user's terminal AND a timestamped log file under
 * `.osborn/dev-logs/`. Forwards SIGINT / SIGTERM so Ctrl-C cleanly shuts down
 * the agent child before the wrapper exits.
 *
 * This is an OUT-OF-LOOP process — the agent itself (src/index.ts) is
 * unmodified and unaware of this wrapper. Removing the dev-logger means
 * deleting this file and the `"dev:logged"` script in package.json — zero
 * impact on the agent's runtime behavior.
 *
 * Usage:
 *   npm run dev:logged        # capture to .osborn/dev-logs/<ts>.log
 *
 * After shutdown, review with:
 *   npm run review
 */

import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// Invoked via `npm run dev:logged` from `agent/`, so process.cwd() === agent/.
// Log dir is co-located with the agent install — follows the existing
// `.osborn/` convention (already matched by the root .gitignore).
const logDir = join(process.cwd(), '.osborn', 'dev-logs')
mkdirSync(logDir, { recursive: true })

// YYYYMMDDHHMMSS timestamp — sortable, filesystem-safe on every OS.
const ts = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)
const logPath = join(logDir, `${ts}.log`)
const logStream = createWriteStream(logPath, { flags: 'a' })

console.log(`📝 [dev-logger] Capturing to ${logPath}`)
console.log(`📝 [dev-logger] Review later with: npm run review\n`)
logStream.write(`=== dev-logged session started at ${new Date().toISOString()} ===\n`)

// `tsx` resolves to `node_modules/.bin/tsx` because npm run <script> prepends
// the local node_modules/.bin to PATH. No need to hardcode the path.
const child = spawn('tsx', ['src/index.ts'], {
  stdio: ['inherit', 'pipe', 'pipe'],
  env: process.env,
})

child.stdout.on('data', (chunk: Buffer) => {
  process.stdout.write(chunk)
  logStream.write(chunk)
})

child.stderr.on('data', (chunk: Buffer) => {
  process.stderr.write(chunk)
  logStream.write(chunk)
})

// Forward termination signals exactly once — if the user hits Ctrl-C multiple
// times, only the first SIGINT goes to the child; subsequent ones are ignored
// to avoid racing the graceful shutdown.
let forwarded = false
const forward = (sig: NodeJS.Signals) => {
  if (forwarded) return
  forwarded = true
  try { child.kill(sig) } catch {}
}
process.on('SIGINT', () => forward('SIGINT'))
process.on('SIGTERM', () => forward('SIGTERM'))

child.on('exit', (code) => {
  logStream.write(`\n=== dev-logged session ended at ${new Date().toISOString()} (exit ${code}) ===\n`)
  // Wait for the log file to finish flushing BEFORE process.exit — otherwise
  // the final marker may be lost on disk.
  logStream.end(() => {
    console.log(`\n📝 [dev-logger] Log saved: ${logPath}`)
    console.log(`📝 [dev-logger] Review: npm run review`)
    process.exit(code ?? 0)
  })
})

child.on('error', (err) => {
  console.error(`❌ [dev-logger] Failed to spawn agent: ${err.message}`)
  logStream.end(() => process.exit(1))
})
