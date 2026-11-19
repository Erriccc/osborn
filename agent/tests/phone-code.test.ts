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
  PHONE_CODE_HANGUP_GRACE_MS, PHONE_CODE_LENGTH, PHONE_CODE_TIMEOUT_MS, PHONE_CODE_TTL_MS, addCodeDigit, checkPhoneCode, heldCode,
  isPhoneLinePlayer, offerPhoneCode, phoneCallerAdmission, phoneCodeAction, readPhoneCodeReply, removePhoneCaller,
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
  assert.equal(phoneCallerAdmission({ verifiedRoom: null, room: 'call-1', hasSyncToken: true }), 'adopt', 'default (off)')
  assert.equal(phoneCallerAdmission({ verifiedRoom: null, room: 'call-1', hasSyncToken: true }, false), 'adopt')
  assert.equal(phoneCallerAdmission({ verifiedRoom: null, room: 'call-1', hasSyncToken: true }, true), 'code')
  assert.equal(phoneCallerAdmission({ verifiedRoom: 'call-1', room: 'call-1', hasSyncToken: true }, true), 'adopt')
  assert.equal(phoneCallerAdmission({ verifiedRoom: 'call-0', room: 'call-1', hasSyncToken: true }, true), 'code', 'an earlier call\'s code does not carry over')
  assert.equal(phoneCallerAdmission({ verifiedRoom: null, room: null, hasSyncToken: true }, true), 'code', 'no room')
  assert.equal(phoneCallerAdmission({ verifiedRoom: null, room: 'call-1', hasSyncToken: false }, true), 'refuse', 'no sync token: no code can be checked')
  assert.equal(phoneCallerAdmission({ verifiedRoom: null, room: 'call-1', hasSyncToken: false }, false), 'adopt', 'flag off: as before')
})

await t('/connect-room offers the code only for a phone room, flag on, sync token set', () => {
  assert.equal(offerPhoneCode('call-1', true, true), true)
  assert.equal(offerPhoneCode('call-1', false, true), false, 'no sync token')
  assert.equal(offerPhoneCode('call-1', true, false), false, 'flag off')
  assert.equal(offerPhoneCode(undefined, true, true), false, 'browser connect')
  assert.equal(offerPhoneCode('call-1', true), false, 'default flag (off)')
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

await t('digits typed while a try is checked are held (last six) for the next try', () => {
  let b = ''
  for (const d of '1234567') { const r = addCodeDigit(b, d, true); b = r.buffer; assert.equal(r.submit, undefined) }
  assert.equal(b, '234567', 'held, not submitted')
  assert.deepEqual(heldCode(b), { buffer: '', submit: '234567' }, 'submitted when the check comes back')
  assert.deepEqual(heldCode('234'), { buffer: '234' }, 'a partial code waits for more digits')
  assert.deepEqual(addCodeDigit('234', '*', true), { buffer: '' }, '* still clears')
})

await t('answers: ok takes the call, locked/expired hang up, wrong/error keep waiting', () => {
  assert.equal(phoneCodeAction('ok'), 'adopt')
  assert.equal(phoneCodeAction('locked'), 'hang-up')
  assert.equal(phoneCodeAction('expired'), 'hang-up')
  assert.equal(phoneCodeAction('wrong'), 'wait')
  assert.equal(phoneCodeAction('error'), 'wait')
})

await t('agent-side deadline: the code window plus 30 s; hang-up waits for the goodbye line', () => {
  assert.equal(PHONE_CODE_TTL_MS, 5 * 60_000)
  assert.equal(PHONE_CODE_TIMEOUT_MS, PHONE_CODE_TTL_MS + 30_000)
  assert.ok(PHONE_CODE_HANGUP_GRACE_MS >= 10_000 && PHONE_CODE_HANGUP_GRACE_MS < 30_000)
})

await t('removePhoneCaller removes the SIP caller; a refusal or no LiveKit config is false', async () => {
  const removed: string[] = []
  assert.equal(await removePhoneCaller('call-1', 'sip_+1555', { removeParticipant: async (r: string, i: string) => { removed.push(`${r}/${i}`) } } as any), true)
  assert.deepEqual(removed, ['call-1/sip_+1555'])
  const warn = console.warn; console.warn = () => {}
  try {
    assert.equal(await removePhoneCaller('call-1', 'sip_+1555', { removeParticipant: async () => { throw new Error('not found') } } as any), false)
  } finally { console.warn = warn }
  assert.equal(await removePhoneCaller('call-1', 'sip_+1555', null), false)
})

await t('line players (ingress) in a phone room are skipped, flag on or off (#365 hold line)', () => {
  assert.equal(PHONE_EMAIL_CODE_ENABLED, false, 'this runs with the flag off')
  assert.equal(isPhoneLinePlayer(true, 'call-1', 'call-1'), true, 'hold/prompt ingress in the call room')
  assert.equal(isPhoneLinePlayer(false, 'call-1', 'call-1'), false, 'the SIP caller or a user is not')
  assert.equal(isPhoneLinePlayer(true, 'osborn-x', null), false, 'an ingress outside a phone call is not')
  assert.equal(isPhoneLinePlayer(true, 'call-2', 'call-1'), false, 'another room')
  // Wired outside any flag check, on join and on leave.
  assert.match(src, /const isPhoneLinePlayer = \(p: RemoteParticipant\) => isLinePlayer\(p\.kind === ParticipantKind\.INGRESS, activeRoomName, phoneRoomName\)/)
  const leave = src.indexOf('const phoneCodeLeave')
  assert.match(src.slice(leave, leave + 200), /\{\s+if \(isPhoneLinePlayer\(p\)\) return true/, 'first line of the leave check')
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
  assert.match(src, /\.\.\.\(offerPhoneCode\(phoneRoom, !!process\.env\.OSBORN_SYNC_TOKEN\) \? \{ callCode: true \} : \{\}\)/)
})
await t('index.ts: keypad presses go to the code while it is awaited, and never reach approvals', () => {
  const start = src.indexOf('room.on(RoomEvent.DtmfReceived')
  const body = src.slice(start, start + 700)
  const code = body.indexOf('if (phoneCodeCaller) {')
  const approvals = body.indexOf('handlePhoneKeypad(')
  assert.ok(code > 0 && approvals > code, 'the code check comes first')
  assert.match(body.slice(code, approvals), /onPhoneCodeDigit\(digit\)\s+return\s+\}/, 'and returns before approvals')
  assert.match(body.slice(code, approvals), /participant\.identity === phoneCodeCaller\?\.identity/, 'only the waiting caller')
})
await t('index.ts: a caller who must type the code is not adopted (nothing is built before the check)', () => {
  const start = src.indexOf('participantConnectedHandler = async')
  const body = src.slice(start)
  const gate = body.indexOf("phoneCallerAdmission({ verifiedRoom: phoneCodeVerifiedRoom, room: activeRoomName, hasSyncToken: !!process.env.OSBORN_SYNC_TOKEN })")
  assert.ok(gate > 0, 'gate present')
  const after = body.slice(gate, gate + 1400)
  assert.match(after, /phoneCodeCaller = participant[\s\S]*?return\n/, 'stops the handler')
  // The gate runs before any session is built or torn down.
  for (const marker of ['cancelMeetingLeaveGrace()', 'killCurrentLLM(', 'currentUserId = OWNER_USER_ID', 'new voice.AgentSession', 'createDirectSession', 'createRealtimeSession']) {
    const at = body.indexOf(marker)
    if (at >= 0) assert.ok(at > gate, `${marker} comes after the gate`)
  }
})
await t('index.ts: only an "ok" from the frontend adopts the caller, in the same room', () => {
  const start = src.indexOf('const submitPhoneCode')
  const body = src.slice(start, start + 1800)
  assert.match(body, /if \(phoneCodeCaller !== caller \|\| activeRoomName !== room\) return\s+phoneCodeChecking = false\s+const action = phoneCodeAction\(result\)\s+if \(action === 'adopt'\) \{[\s\S]*?phoneCodeVerifiedRoom = room\s+phoneCodeCaller = null\s+participantConnectedHandler\?\.\(caller\)/)
  // A locked/expired answer hangs up after the goodbye line; wrong/error submit held digits.
  assert.match(body, /action === 'hang-up'\) \{[\s\S]*?setTimeout\(\(\) => endPhoneCodeCall\(caller, result\), PHONE_CODE_HANGUP_GRACE_MS\)/)
  assert.match(body, /const held = heldCode\(phoneCodeBuffer\)[\s\S]*?if \(held\.submit\) submitPhoneCode\(held\.submit\)/)
  const digit = src.indexOf('const onPhoneCodeDigit')
  assert.match(src.slice(digit, digit + 400), /addCodeDigit\(phoneCodeBuffer, digit, phoneCodeChecking\)/, 'digits during a check are held, one try at a time')
})
await t('index.ts: a required code with no sync token hangs up instead of waiting in silence', () => {
  assert.match(src, /if \(admission === 'refuse'\) \{[\s\S]{0,300}endPhoneCodeCall\(participant, 'no-sync-token'\)\s+return/)
})
await t('index.ts: the code step opens a timer that ends the call; adoption and leaving clear it', () => {
  assert.match(src, /phoneCodeTimer = setTimeout\(\(\) => endPhoneCodeCall\(participant, 'timeout'\), PHONE_CODE_TIMEOUT_MS\)/)
  const clear = src.indexOf('const clearPhoneCode')
  assert.match(src.slice(clear, clear + 300), /clearTimeout\(phoneCodeTimer\)/)
  const end = src.indexOf('const endPhoneCodeCall')
  assert.match(src.slice(end, end + 600), /if \(phoneCodeCaller !== caller \|\| !room\) return[\s\S]*?removePhoneCaller\(room, caller\.identity\)[\s\S]*?destroyRoomSession\(/, 'only while still waiting; leaves the room if the caller cannot be removed')
})
await t('index.ts: a check that outlives its call neither leaves the next call held nor clears its flag (#397)', () => {
  const clear = src.indexOf('const clearPhoneCode')
  assert.match(src.slice(clear, clear + 300), /phoneCodeChecking = false/, 'a new call starts unheld')
  const sub = src.indexOf('const submitPhoneCode')
  assert.match(src.slice(sub, sub + 900), /if \(phoneCodeCaller !== caller \|\| activeRoomName !== room\) return\s+phoneCodeChecking = false/, 'the flag is released only for the call it belongs to')
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
