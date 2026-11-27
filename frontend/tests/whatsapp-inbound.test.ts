// WhatsApp messages in (#679): signature, handshake, text parsing, 24 h window.
// Run: cd frontend && npx tsx tests/whatsapp-inbound.test.ts
import assert from 'node:assert'
import { createHmac } from 'node:crypto'
import { textMessages, verifyChallenge, verifyMetaSignature, whatsappWindowOpen, WA_WINDOW_MS } from '../src/lib/whatsapp-inbound'

const body = '{"a":1}'
const sig = 'sha256=' + createHmac('sha256', 's3cret').update(body).digest('hex')
assert(verifyMetaSignature(body, sig, 's3cret'))
assert(!verifyMetaSignature(body, sig, 'other'))
assert(!verifyMetaSignature(body + ' ', sig, 's3cret'))
assert(!verifyMetaSignature(body, null, 's3cret'))
assert(!verifyMetaSignature(body, sig, undefined))
assert(!verifyMetaSignature(body, 'sha256=zz', 's3cret'))

const q = (o: Record<string, string>) => new URLSearchParams(o)
assert.equal(verifyChallenge(q({ 'hub.mode': 'subscribe', 'hub.verify_token': 't', 'hub.challenge': '42' }), 't'), '42')
assert.equal(verifyChallenge(q({ 'hub.mode': 'subscribe', 'hub.verify_token': 'x', 'hub.challenge': '42' }), 't'), null)
assert.equal(verifyChallenge(q({ 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': '42' }), undefined), null)

const msg = (m: object) => ({ entry: [{ changes: [{ value: { messages: [m] } }] }] })
assert.deepEqual(textMessages(msg({ from: '15551230000', id: 'w1', timestamp: '100', type: 'text', text: { body: 'status?' } })),
  [{ from: '15551230000', id: 'w1', text: 'status?', at: 100000 }])
assert.deepEqual(textMessages(msg({ from: '1', id: 'w', timestamp: '1', type: 'image' })), [])
assert.deepEqual(textMessages(msg({ from: '1', id: 'w', timestamp: '1', type: 'text', text: { body: '  ' } })), [])
assert.deepEqual(textMessages({ entry: [{ changes: [{ value: { statuses: [{}] } }] }] }), [])
assert.deepEqual(textMessages(null), [])

assert(whatsappWindowOpen(1000, 1000 + WA_WINDOW_MS - 1))
assert(!whatsappWindowOpen(1000, 1000 + WA_WINDOW_MS))
assert(!whatsappWindowOpen(2000, 1000))
console.log('whatsapp-inbound: ok')
