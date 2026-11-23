// Shared by bin/cli.js and bin/recall.js: make the wrapper's exit status match
// how its child ended, and pass stop signals on to it.
import os from 'os'

// A child killed by a signal has code null: exit 128+signo so Fly's on-failure restart fires.
function exitCodeFor(code, signal) {
  if (typeof code === 'number') return code
  if (signal) return 128 + (os.constants.signals[signal] || 1)
  return 1
}

// onAbnormalExit(exitCode): optional, runs before a non-zero exit (awaited if it returns a promise).
export function superviseChild(child, { name = 'agent', proc = process, onAbnormalExit } = {}) {
  child.on('error', (err) => {
    console.error(`Failed to start ${name}:`, err.message)
    proc.exit(1)
  })
  child.on('exit', (code, signal) => {
    const exitCode = exitCodeFor(code, signal)
    if (exitCode === 0 || !onAbnormalExit) return proc.exit(exitCode)
    Promise.resolve().then(() => onAbnormalExit(exitCode)).catch(() => {}).finally(() => proc.exit(exitCode))
  })
  for (const sig of ['SIGINT', 'SIGTERM']) {
    proc.on(sig, () => { child.kill(sig) })
  }
}
