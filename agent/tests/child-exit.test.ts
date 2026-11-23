// The wrapper's exit status must follow its child (#450): a child killed by a
// signal exits non-zero so Fly restarts it, and stop signals reach the child.
// Run with `npx tsx agent/tests/child-exit.test.ts`.
import assert from 'node:assert'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
// @ts-ignore plain JS module
import { exitCodeFor, superviseChild } from '../bin/child-exit.js'

assert.equal(exitCodeFor(0, null), 0)
assert.equal(exitCodeFor(3, null), 3)
assert.equal(exitCodeFor(null, 'SIGABRT'), 134)
assert.equal(exitCodeFor(null, 'SIGKILL'), 137)
assert.equal(exitCodeFor(null, 'SIGTERM'), 143)
assert.equal(exitCodeFor(null, null), 1, 'no code and no signal is never a clean exit')

// Wiring with fakes: exit is mapped, SIGINT/SIGTERM are forwarded.
const child: any = new EventEmitter(); const killed: string[] = []
child.kill = (s: string) => { killed.push(s) }
const proc: any = new EventEmitter(); let exited: number | undefined
proc.exit = (c: number) => { exited = c }
superviseChild(child, { proc })
proc.emit('SIGINT'); proc.emit('SIGTERM')
assert.deepEqual(killed, ['SIGINT', 'SIGTERM'])
child.emit('exit', null, 'SIGABRT')
assert.equal(exited, 134)
child.emit('error', new Error('boom'))
assert.equal(exited, 1)

// Real processes: a wrapper whose child aborts itself must exit 134, not 0.
const dir = dirname(fileURLToPath(import.meta.url))
const helper = join(dir, '..', 'bin', 'child-exit.js')
const script = `import { spawn } from 'child_process'; import { superviseChild } from ${JSON.stringify('file://' + helper)};
superviseChild(spawn(process.execPath, ['-e', ${JSON.stringify('process.kill(process.pid, "SIGABRT")')}], { stdio: 'inherit' }))`
const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
assert.equal(r.status, 134, r.stderr)
console.log('child-exit tests passed')
