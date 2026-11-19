// Run: npx tsx agent/tests/phone-code.test.ts
// The emailed code on a phone call (#362): with PHONE_EMAIL_CODE_ENABLED on, a
// caller is not adopted (no voice session, no voice actions, no tools) until
// the frontend says the code they typed matched; every keypad press goes to the
// code, never to approvals. Off by default: calls are admitted as before.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PHONE_EMAIL_CODE_ENABLED } from '../src/data-sender-auth.js'
import {
  PHONE_CODE_LENGTH, addCodeDigit, checkPhoneCode, phoneCallerAdmission, phoneKeypadTarget, readPhoneCodeReply,
} from '../src/phone-code.js'

let pass = 0, fail = 0
async function t(name: string, fn: () => void | Promise<void>) {
  try { await fn(); pass++; console.log('PASS', name) }
  catch (e: any) { fail++; console.log('FAIL', name, '-', String(e?.message).split('\n')[0].slice(0, 300)) }
}
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.ts'), 'utf8')

await t('the emailed code is off by default', () => {
  assert.equal(PHONE_EMAIL_CODE_ENABLED, false)
})

await t('admission: flag off adopts; flag on asks for the code until this room is verified', () => {
  assert.equal(phoneCallerAdmission({ verifiedRoom: null, room: 'call-1' }), 'adopt', 'default (off)')
  assert.equal(phoneCallerAdmission({ verifiedRoom: null, room: 'call-1' }, false), 'adopt')
  assert.equal(phoneCallerAdmission({ verifiedRoom: null, room: 'call-1' }, true), 'code')
  assert.equal(phoneCallerAdmission({ verifiedRoom: 'call-1', room: 'call-1' }, true), 'adopt')
  assert.equal(phoneCallerAdmission({ verifiedRoom: 'call-0', room: 'call-1' }, true), 'code', 'an earlier call\'s code does not carry over')
  assert.equal(phoneCallerAdmission({ verifiedRoom: null, room: null }, true), 'code', 'no room')
})

await t('keypad routing: the code step takes every press', () => {
  assert.equal(phoneKeypadTarget(true), 'code')
  assert.equal(phoneKeypadTarget(false), 'approvals')
})

await t('digits add up to six and submit; * starts again; other keys are ignored', () => {
  assert.equal(PHONE_CODE_LENGTH, 6)
  let b = ''
  const subs: string[] = []
  for (const d of '48291') { const r = addCodeDigit(b, d); b = r.buffer; assert.equal(r.submit, undefined) }
  assert.equal(b, '48291')
  assert.deepEqual(addCodeDigit(b, '#'), { buffer: '48291' }, '# ignored')
  assert.deepEqual(addCodeDigit(b, 'A'), { buffer: '48291' }, 'letter ignored')
  assert.deepEqual(addCodeDigit(b, ''), { buffer: '48291' }, 'empty ignored')
  assert.deepEqual(addCodeDigit(b, undefined), { buffer: '48291' }, 'undefined ignored')
  assert.deepEqual(addCodeDigit(b, '12'), { buffer: '48291' }, 'two characters ignored')
  const r = addCodeDigit(b, '3')
  assert.deepEqual(r, { buffer: '', submit: '482913' })
  subs.push(r.submit!)
  assert.deepEqual(addCodeDigit('482', '*'), { buffer: '' }, '* clears')
})

await t('the frontend reply is read strictly', () => {
  for (const r of ['ok', 'wrong', 'locked', 'expired'] as const) assert.equal(readPhoneCodeReply(200, { result: r }), r)
  assert.equal(readPhoneCodeReply(200, { result: 'OK' }), 'error')
  assert.equal(readPhoneCodeReply(200, { result: true }), 'error')
  assert.equal(readPhoneCodeReply(200, null), 'error')
  assert.equal(readPhoneCodeReply(401, { result: 'ok' }), 'error', 'an ok body on an error status is not ok')
  assert.equal(readPhoneCodeReply(500, { error: 'x' }), 'error')
})

await t('checkPhoneCode posts room and code with the sync token; no token, no request', async () => {
  const seen: any[] = []
  const fake = (async (url: any, init: any) => {
    seen.push({ url: String(url), init })
    return new Response(JSON.stringify({ result: 'ok' }), { status: 200 })
  }) as typeof fetch
  assert.equal(await checkPhoneCode('https://front.example', 'tok', 'call-1', '482913', fake), 'ok')
  assert.equal(seen[0].url, 'https://front.example/api/phone/code')
  assert.equal(seen[0].init.headers.Authorization, 'Bearer tok')
  assert.deepEqual(JSON.parse(seen[0].init.body), { roomName: 'call-1', code: '482913' })
  assert.equal(await checkPhoneCode('https://front.example', undefined, 'call-1', '482913', fake), 'error')
  assert.equal(seen.length, 1)
  const throws = (async () => { throw new Error('down') }) as typeof fetch
  assert.equal(await checkPhoneCode('https://front.example', 'tok', 'call-1', '482913', throws), 'error')
})

// ── index.ts wiring ──
await t('index.ts: /connect-room asks the frontend for the code only for a phone room with the flag on', () => {
  assert.match(src, /\.\.\.\(phoneRoom && PHONE_EMAIL_CODE_ENABLED \? \{ callCode: true \} : \{\}\)/)
})
await t('index.ts: keypad presses go to the code while it is awaited, and never reach approvals', () => {
  const start = src.indexOf('room.on(RoomEvent.DtmfReceived')
  const body = src.slice(start, start + 700)
  const code = body.indexOf("phoneKeypadTarget(!!phoneCodeCaller) === 'code'")
  const approvals = body.indexOf('handlePhoneKeypad(')
  assert.ok(code > 0 && approvals > code, 'the code check comes first')
  assert.match(body.slice(code, approvals), /onPhoneCodeDigit\(digit\)\s+return\s+\}/, 'and returns before approvals')
  assert.match(body.slice(code, approvals), /participant\.identity === phoneCodeCaller\?\.identity/, 'only the waiting caller')
})
await t('index.ts: a caller who must type the code is not adopted (nothing is built before the check)', () => {
  const start = src.indexOf('participantConnectedHandler = async')
  const body = src.slice(start)
  const gate = body.indexOf("phoneCallerAdmission({ verifiedRoom: phoneCodeVerifiedRoom, room: activeRoomName }) === 'code'")
  assert.ok(gate > 0, 'gate present')
  const after = body.slice(gate, gate + 400)
  assert.match(after, /phoneCodeCaller = participant[\s\S]*?return\n/, 'stops the handler')
  // The gate runs before any session is built or torn down.
  for (const marker of ['cancelMeetingLeaveGrace()', 'killCurrentLLM(', 'currentUserId = OWNER_USER_ID', 'new voice.AgentSession', 'createDirectSession', 'createRealtimeSession']) {
    const at = body.indexOf(marker)
    if (at >= 0) assert.ok(at > gate, `${marker} comes after the gate`)
  }
})
await t('index.ts: only an "ok" from the frontend adopts the caller, in the same room', () => {
  const start = src.indexOf('const onPhoneCodeDigit')
  const body = src.slice(start, start + 1200)
  assert.match(body, /if \(result !== 'ok' \|\| phoneCodeCaller !== caller \|\| activeRoomName !== room\) return\s+phoneCodeVerifiedRoom = room\s+phoneCodeCaller = null\s+participantConnectedHandler\?\.\(caller\)/)
  assert.match(body, /if \(phoneCodeChecking \|\| !phoneCodeCaller \|\| !activeRoomName\) return/, 'one try at a time')
})
await t('index.ts: during the code step nobody else is adopted, and nobody leaving tears anything down', () => {
  assert.match(src, /if \(isPhoneLinePlayer\(participant\) \|\| \(phoneCodeCaller && participant\.identity !== phoneCodeCaller\.identity\)\) \{/)
  const start = src.indexOf('const handleParticipantDisconnected')
  assert.match(src.slice(start, start + 300), /if \(phoneCodeLeave\(participant\)\) return/)
  const leave = src.indexOf('const phoneCodeLeave')
  assert.match(src.slice(leave, leave + 500), /if \(isPhoneLinePlayer\(p\)\) return true\s+if \(!phoneCodeCaller\) return false[\s\S]*?clearPhoneCode\(\)[\s\S]*?return true/)
})
await t('index.ts: the code state ends with the call and with the room', () => {
  assert.match(src, /if \(phoneCallerLeft\) clearPhoneCode\(\)/)
  assert.match(src, /phoneRoomName = null\n\s+clearPhoneCode\(\)\n\s+if \(aloneTimer\)/)
})

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
