// Shared by bin/cli.js and bin/recall.js: make the wrapper's exit status match
// how its child ended, and pass stop signals on to it.
import os from 'os'

// A child killed by a signal (a heap-OOM SIGABRT, an OOM-killer SIGKILL) exits
// with code null. `code || 0` made that a clean exit, so Fly's on-failure
// restart policy never restarted the machine. Use the shell's 128 + signal.
export function exitCodeFor(code, signal) {
  if (typeof code === 'number') return code
  if (signal) return 128 + (os.constants.signals[signal] || 1)
  return 1
}

export function superviseChild(child, { name = 'agent', proc = process } = {}) {
  child.on('error', (err) => {
    console.error(`Failed to start ${name}:`, err.message)
    proc.exit(1)
  })
  child.on('exit', (code, signal) => proc.exit(exitCodeFor(code, signal)))
  for (const sig of ['SIGINT', 'SIGTERM']) {
    proc.on(sig, () => { try { child.kill(sig) } catch {} })
  }
}
