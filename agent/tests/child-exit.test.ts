// The wrapper's exit status must follow its child (#450): a child killed by a
// signal exits non-zero so Fly restarts it, and stop signals reach the child.
// Run with `npx tsx agent/tests/child-exit.test.ts`.
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
// @ts-ignore plain JS module
import { superviseChild } from '../bin/child-exit.js'

// Wiring with fakes: exit is mapped, SIGINT/SIGTERM are forwarded.
const supervise = () => {
  const child: any = new EventEmitter(); const killed: string[] = []
  child.kill = (s: string) => { killed.push(s) }
  const proc: any = new EventEmitter(); const out = { child, proc, killed, exited: undefined as number | undefined }
  proc.exit = (c: number) => { out.exited = c }
  superviseChild(child, { proc })
  return out
}
const exitFor = (code: number | null, signal: string | null) => {
  const s = supervise(); s.child.emit('exit', code, signal); return s.exited
}
assert.equal(exitFor(0, null), 0)
assert.equal(exitFor(3, null), 3)
assert.equal(exitFor(null, 'SIGKILL'), 137)
assert.equal(exitFor(null, 'SIGTERM'), 143)
assert.equal(exitFor(null, null), 1, 'no code and no signal is never a clean exit')

const s = supervise()
s.proc.emit('SIGINT'); s.proc.emit('SIGTERM')
assert.deepEqual(s.killed, ['SIGINT', 'SIGTERM'])
s.child.emit('exit', null, 'SIGABRT')
assert.equal(s.exited, 134)
s.child.emit('error', new Error('boom'))
assert.equal(s.exited, 1)

// onAbnormalExit runs (and is awaited) before a non-zero exit, never on a clean one (#378).
{
  const seen: number[] = []
  const mk = () => { const child: any = new EventEmitter(); child.kill = () => {}; const proc: any = new EventEmitter()
    const o = { child, proc, exited: undefined as number | undefined }; proc.exit = (c: number) => { o.exited = c }
    superviseChild(child, { proc, onAbnormalExit: async (c: number) => { seen.push(c) } }); return o }
  const clean = mk(); clean.child.emit('exit', 0, null); assert.equal(clean.exited, 0)
  const crash = mk(); crash.child.emit('exit', null, 'SIGABRT'); assert.equal(crash.exited, undefined)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(crash.exited, 134); assert.deepEqual(seen, [134])
}

// Real processes: a wrapper whose child aborts itself must exit 137, not 0.
const dir = dirname(fileURLToPath(import.meta.url))
const helper = join(dir, '..', 'bin', 'child-exit.js')
const script = `import { spawn } from 'child_process'; import { superviseChild } from ${JSON.stringify('file://' + helper)};
superviseChild(spawn(process.execPath, ['-e', ${JSON.stringify('process.kill(process.pid, "SIGKILL")')}], { stdio: 'inherit' }))`
const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
assert.equal(r.status, 137, r.stderr)
// Both wrappers must use the helper (an inline `code || 0` would bring the bug back).
for (const f of ['cli.js', 'recall.js']) {
  const src = readFileSync(join(dir, '..', 'bin', f), 'utf8')
  assert.ok(src.includes('superviseChild(child'), f + ' must call superviseChild')
  assert.ok(!/code \|\| 0/.test(src), f + ' must not map a null code to 0')
}
console.log('child-exit tests passed')
