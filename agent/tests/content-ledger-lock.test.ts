// Daily spend ledger lock: N child processes race a pre-aged STALE lock; no reservation may be lost.
// Run: npx tsx agent/tests/content-ledger-lock.test.ts   (OSBORN_HOME is a temp dir; the real ~/.osborn is never touched)
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const N = 8
const K = 12
const USD = 0.001

if (process.env.LEDGER_LOCK_CHILD === '1') {
  // Child: wait for the shared start time, then make K reservations.
  const { SpendGuard } = await import('../src/content/content-llm.js')
  const start = Number(process.env.LEDGER_LOCK_START)
  while (Date.now() < start) { /* barrier */ }
  const g = new SpendGuard(null, { periodUsd: 1e6, dailyUsd: 1e6, maxPieces: 4 })
  let ok = 0
  let failed = 0
  for (let i = 0; i < K; i++) {
    try {
      g.reserve(USD)
      ok++
    } catch {
      failed++
    }
  }
  process.stdout.write(JSON.stringify({ ok, failed }) + '\n')
  process.exit(0)
}

const tmp = mkdtempSync(join(tmpdir(), 'ledger-lock-test-'))
const home = join(tmp, 'osborn-home')
mkdirSync(home, { recursive: true })
process.env.OSBORN_HOME = home
const { ledgerPath, readLedger, daySpent } = await import('../src/content/content-llm.js')

let pass = 0
const t = async (name: string, fn: () => unknown) => {
  try { await fn(); pass++; console.log('ok   ', name) } catch (e: any) { console.log('FAIL ', name, '\n     ', e.message.split('\n')[0]); process.exitCode = 1 }
}

const runChild = (start: number): Promise<{ ok: number; failed: number }> =>
  new Promise((resolve, reject) => {
    const self = fileURLToPath(import.meta.url)
    const c = spawn(process.execPath, [...process.execArgv, self], {
      env: { ...process.env, OSBORN_HOME: home, LEDGER_LOCK_CHILD: '1', LEDGER_LOCK_START: String(start) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    c.stdout.on('data', d => (out += d))
    c.stderr.on('data', d => (err += d))
    c.on('error', reject)
    c.on('close', code => {
      if (code !== 0) return reject(new Error(`child exit ${code}: ${err.slice(0, 300)}`))
      try {
        resolve(JSON.parse(out.trim().split('\n').pop()!))
      } catch {
        reject(new Error(`child output unparsable: ${out.slice(0, 200)} ${err.slice(0, 200)}`))
      }
    })
  })

await t(`${N} processes racing a pre-aged stale lock: ledger total == sum of reservations`, async () => {
  const lock = `${ledgerPath()}.lock`
  writeFileSync(lock, '99999999')
  const old = new Date(Date.now() - 5 * 60_000)
  utimesSync(lock, old, old)
  // Children need a few seconds to boot tsx; all start reserving at the same instant.
  const start = Date.now() + 4000
  const results = await Promise.all(Array.from({ length: N }, () => runChild(start)))
  const ok = results.reduce((s, r) => s + r.ok, 0)
  const failed = results.reduce((s, r) => s + r.failed, 0)
  assert.equal(failed, 0, `${failed} reservation(s) failed to take the lock`)
  assert.equal(ok, N * K)
  const total = Object.values(readLedger().days).reduce((s, v) => s + Number(v), 0)
  assert.ok(Math.abs(total - ok * USD) < 1e-9, `ledger total ${total} != sum of reservations ${ok * USD}`)
  assert.ok(Math.abs(daySpent() - ok * USD) < 1e-9)
  assert.ok(!existsSync(lock), 'lock left behind')
  const leftovers = readdirSync(home).filter(f => f.includes('.lock') || f.endsWith('.tmp'))
  assert.deepEqual(leftovers, [], `leftover lock/tmp files: ${leftovers.join(', ')}`)
})

await t('a fresh (live) lock is not reaped: reserve fails closed with a day CapError', async () => {
  const { SpendGuard, CapError } = await import('../src/content/content-llm.js')
  const lock = `${ledgerPath()}.lock`
  writeFileSync(lock, 'someone-else')
  try {
    const before = daySpent()
    const g = new SpendGuard(null, { periodUsd: 1e6, dailyUsd: 1e6, maxPieces: 4 })
    assert.throws(() => g.reserve(USD), (e: any) => e instanceof CapError && e.cap === 'day')
    assert.equal(daySpent(), before)
    assert.ok(existsSync(lock), 'live lock was removed')
  } finally {
    try { (await import('node:fs')).unlinkSync(lock) } catch { /* gone */ }
  }
})

console.log(`\n${pass} passed${process.exitCode ? ' (with failures)' : ''}`)
