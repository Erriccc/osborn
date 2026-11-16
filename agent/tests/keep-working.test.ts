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

  // Billing guards (index.ts is not importable in a test): keep-working starts only
  // after the hang-up released the agents and armed the room teardown.
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/index.ts'), 'utf8')
  const warm = src.indexOf("parkWarm('participant_disconnected')")
  const leave = src.indexOf('armFastLeaveTimer()', warm)
  const kw = src.indexOf('keepWorkingAfterLeave()', warm)
  assert.ok(warm > 0 && leave > warm && kw > leave && kw < src.indexOf('} else {', warm), 'keep-working starts after the keep-warm teardown is armed')
  // Background slots and the host anchor are released at hang-up, so the empty room tears down.
  assert.ok(/parkWarm\('participant_disconnected'\)[\s\S]{0,200}releaseAgents\(\)\n\s+armMeetingLeaveGrace/.test(src), 'the hang-up releases slots and the host anchor')
  console.log('keep-working: all assertions passed')
}
run().catch((e) => { console.error(e); process.exit(1) })
