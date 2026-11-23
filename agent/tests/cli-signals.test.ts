// Follow-through (#378) and #450: bin/cli.js run for real against a stub agent entry.
// A signalled agent exits 128+signal (was 0) after an abnormal-exit flush; exit 1 stays 1 and
// flushes; a clean exit is 0 with no flush; a stop signal to the parent is forwarded and exits 0.
// Run: npx tsx agent/tests/cli-signals.test.ts
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { constants } from 'node:os'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'cli-signals-test-'))
mkdirSync(join(root, 'bin'))
mkdirSync(join(root, 'dist', 'content'), { recursive: true })
copyFileSync(join(here, '..', 'bin', 'cli.js'), join(root, 'bin', 'cli.js'))
writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', version: '0.0.0' }))
// The stub agent: behaviour chosen by STUB.
writeFileSync(join(root, 'dist', 'index.js'), `
const mode = process.env.STUB
if (mode === 'abort') process.kill(process.pid, 'SIGABRT')
else if (mode === 'exit0') process.exit(0)
else if (mode === 'exit1') process.exit(1)
else {
  if (mode === 'handle') process.on('SIGTERM', () => process.exit(0))
  setInterval(() => {}, 1000)
  console.log('READY')
}
`)
// The stub flush worker: leaves a marker so the test can see it was spawned.
writeFileSync(join(root, 'dist', 'content', 'loops-flush-worker.js'), `
import { writeFileSync } from 'node:fs'
writeFileSync(process.env.FLUSH_MARK, process.argv.slice(2).join(' '))
`)

let pass = 0
const t = async (name: string, fn: () => unknown) => {
  try { await fn(); pass++; console.log('ok   ', name) }
  catch (e: any) { console.log('FAIL ', name, '\n     ', String(e?.message ?? e).split('\n')[0]); process.exitCode = 1 }
}

let n = 0
function run(stub: string, parentSignal?: NodeJS.Signals): Promise<{ code: number | null; flushed: boolean }> {
  const mark = join(root, `flush-${n++}`)
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [join(root, 'bin', 'cli.js'), 'start'], {
      env: { ...process.env, STUB: stub, FLUSH_MARK: mark, HOME: root },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`timeout (${stub})`)) }, 20_000)
    p.stdout.on('data', (d) => { if (parentSignal && String(d).includes('READY')) p.kill(parentSignal) })
    p.on('exit', async (code) => {
      clearTimeout(timer)
      await new Promise((r) => setTimeout(r, 300)) // the detached worker writes its marker
      resolve({ code, flushed: existsSync(mark) })
    })
  })
}

await t('a signalled agent (heap-OOM abort) exits 128 + signal and flushes', async () => {
  const r = await run('abort')
  assert.equal(r.code, 128 + constants.signals.SIGABRT)
  assert.equal(r.code, 134)
  assert.equal(r.flushed, true)
})

await t('an agent exit 1 stays 1 (restart) and flushes', async () => {
  const r = await run('exit1')
  assert.equal(r.code, 1)
  assert.equal(r.flushed, true)
})

await t('a clean agent exit 0 exits 0 without a flush', async () => {
  const r = await run('exit0')
  assert.equal(r.code, 0)
  assert.equal(r.flushed, false)
})

await t('SIGTERM to the parent is forwarded; the agent stops cleanly and the parent exits 0', async () => {
  const r = await run('handle', 'SIGTERM')
  assert.equal(r.code, 0)
  assert.equal(r.flushed, false, 'the agent flushed in its own handler')
})

await t('a stop that kills an agent with no handler still exits 0 (stopping) and flushes', async () => {
  const r = await run('nohandle', 'SIGTERM')
  assert.equal(r.code, 0)
  assert.equal(r.flushed, true)
})

await t('SIGINT is forwarded too', async () => {
  const r = await run('nohandle', 'SIGINT')
  assert.equal(r.code, 0)
})

rmSync(root, { recursive: true, force: true })
console.log(`\n${pass} passed`)
