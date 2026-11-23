// Keep working after hang-up: the phone notice, and the agent wiring that parks
// the brain without the short grace. Run with `npx tsx agent/tests/keep-working.test.ts`.
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { notifyPhone, armPermissionPush, settlePermissionPush, handleWatchAck, phonePushPending } from '../src/pushover.js'

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

  // Answering a request cancels its push receipt and frees the single push slot.
  for (const k of ['NTFY_URL', 'NTFY_TOPIC']) delete process.env[k]
  process.env.PUSHOVER_TOKEN = 'tok'
  process.env.PUSHOVER_USER_KEY = 'usr'
  process.env.WATCH_ACK_SECRET = 'sec'
  process.env.OSBORN_PUBLIC_URL = 'https://agent.example'
  const reqs: { url: string; body: string }[] = []
  let n = 0
  ;(globalThis as any).fetch = async (url: string, init: any) => {
    reqs.push({ url: String(url), body: String(init?.body ?? '') })
    return { ok: true, json: async () => ({ receipt: `rcpt${++n}` }) }
  }
  await armPermissionPush({ toolName: 'Bash', description: 'run ls', requestId: 'r1' })
  assert.equal(phonePushPending(), true)
  settlePermissionPush('other') // a different request never cancels this one
  assert.equal(phonePushPending(), true)
  settlePermissionPush('r1')
  assert.equal(phonePushPending(), false, 'answered: nothing pending')
  const cancel = reqs.find(r => r.url.endsWith('/receipts/rcpt1/cancel.json'))
  assert.ok(cancel && cancel.body.includes('token=tok'), 'the receipt was cancelled')
  const before = reqs.length
  await armPermissionPush({ toolName: 'Edit', description: 'edit x', requestId: 'r2' })
  assert.ok(reqs.length > before && phonePushPending(), 'the next request still gets its push')
  settlePermissionPush('r2')
  settlePermissionPush('r2') // idempotent
  assert.equal(reqs.filter(r => r.url.endsWith('/cancel.json')).length, 2)

  // An ntfy Deny/Approve answer cancels the Pushover receipt too, exactly once.
  process.env.NTFY_URL = 'https://ntfy.example'
  process.env.NTFY_TOPIC = 't'
  const sent: { url: string; body: string }[] = []
  ;(globalThis as any).fetch = async (url: string, init: any) => {
    sent.push({ url: String(url), body: String(init?.body ?? '') })
    return { ok: true, json: async () => ({ receipt: 'rcptN' }) }
  }
  await armPermissionPush({ toolName: 'Bash', description: 'run pwd', requestId: 'r3' })
  const ntfyMsg = JSON.parse(sent.find(r => r.url === 'https://ntfy.example')!.body)
  const qid = decodeURIComponent(ntfyMsg.actions[1].url.split('/').pop()!.split('?')[0])
  assert.equal(handleWatchAck(qid, undefined, false), true)
  assert.equal(sent.filter(r => r.url.endsWith('/receipts/rcptN/cancel.json')).length, 1, 'ntfy answer cancels the receipt')
  assert.equal(handleWatchAck(qid, undefined, false), false)
  settlePermissionPush('r3')
  assert.equal(sent.filter(r => r.url.endsWith('/cancel.json')).length, 1, 'a repeat cancels nothing more')
  assert.equal(phonePushPending(), false)

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
