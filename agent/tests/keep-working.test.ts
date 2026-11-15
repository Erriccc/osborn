// Keep working after hang-up: the phone notice, and the agent wiring that parks
// the brain without the short grace. Run with `npx tsx agent/tests/keep-working.test.ts`.
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { notifyPhone } from '../src/pushover.js'

const run = async () => {
  // notifyPhone: nothing configured → no request, false.
  const calls: { url: string; body: string }[] = []
  ;(globalThis as any).fetch = async (url: string, init: any) => { calls.push({ url: String(url), body: String(init?.body ?? '') }); return { ok: true } }
  for (const k of ['PUSHOVER_TOKEN', 'PUSHOVER_USER_KEY', 'NTFY_URL', 'NTFY_TOPIC']) delete process.env[k]
  assert.equal(await notifyPhone('done'), false)
  assert.equal(calls.length, 0)

  // ntfy configured → one plain message (no Approve/Deny actions), true.
  process.env.NTFY_URL = 'https://ntfy.example'
  process.env.NTFY_TOPIC = 't'
  assert.equal(await notifyPhone('Osborn finished'), true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://ntfy.example')
  const body = JSON.parse(calls[0].body)
  assert.equal(body.message, 'Osborn finished')
  assert.equal(body.actions, undefined, 'a notice, not an approval')

  // A failed send reports false.
  ;(globalThis as any).fetch = async () => ({ ok: false })
  assert.equal(await notifyPhone('x'), false)

  // Agent wiring (index.ts is not importable in a test): keep-working extends the
  // keep-warm park only after the room teardown is armed (armFastLeaveTimer bails
  // while agentsActive() is true, which keep-working makes it), the held machine
  // counts as active, and a reconnect or teardown ends keep-working.
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/index.ts'), 'utf8')
  const warm = src.indexOf("parkWarm('participant_disconnected')")
  const leave = src.indexOf('armFastLeaveTimer()', warm)
  const kw = src.indexOf('keepWorkingAfterLeave()', warm)
  assert.ok(warm > 0 && leave > warm && kw > leave && kw < src.indexOf('} else {', warm), 'keep-working starts after the keep-warm teardown is armed')
  assert.ok(src.includes('hostActive || slots.size > 0 || keepWorkingActive'), 'keep-working holds the machine')
  assert.ok(/const clearWarmTimers = [^\n]*\n\s+stopKeepWorking\(\)/.test(src), 'clearing the warm timers ends keep-working')
  assert.ok(/const killWarm = [^\n]*\n\s+clearWarmTimers\(\)/.test(src), 'killWarm ends keep-working')
  assert.ok(/const claimWarm = [^\n]*\n\s+clearWarmTimers\(\)/.test(src), 'a reconnect ends keep-working')
  assert.ok(src.includes("data.type === 'get_busy'") && src.includes("data.type === 'keep_working'"), 'End asks, then requests')
  console.log('keep-working: all assertions passed')
}
run().catch((e) => { console.error(e); process.exit(1) })
