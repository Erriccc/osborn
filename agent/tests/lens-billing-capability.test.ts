import assert from 'node:assert/strict'
import { readCandidates } from '../src/content/compaction-lens.js'

const raw = JSON.stringify({
  angles: [],
  capabilities: [
    { name: 'automated invoice reconciliation', did: 'built it', evidence: 'shipped', proof: 'ran in prod', quotes: [] },
    { name: 'WebSocket proxy header fix', did: 'added x-forwarded-host', evidence: 'root-caused', proof: 'tests pass', quotes: [] },
  ],
})
const r = { billingDropped: 0, notDone: 0 }
const c = readCandidates(raw, 10, 10, r)
assert.deepEqual(c.capabilities.map(x => x.name), ['WebSocket proxy header fix'])
assert.equal(r.billingDropped, 1)
assert.equal(r.notDone, 0)
console.log('ok billing capability dropped+counted; technical kept')

// Technical billing work survives; personal money talk does not.
const raw2 = JSON.stringify({
  angles: [
    { title: 'LinkedIn ads API billed spend vs budget', why: 'spend caps overshoot', quotes: [] },
    { title: 'Negotiating the retainer', why: 'contract terms', quotes: [] },
  ],
  capabilities: [
    { name: 'Stripe payment webhook integration', did: 'verified signatures + idempotency', evidence: 'shipped', proof: 'tests pass', quotes: [] },
    { name: 'Token pricing comparison', did: 'priced models per million tokens', evidence: 'shipped', proof: 'table', quotes: [] },
    { name: 'Sent the invoice to the client', did: 'emailed it', evidence: 'shipped', proof: 'sent', quotes: [] },
    { name: 'Client still owes me', did: 'followed up on the overdue payment', evidence: 'shipped', proof: 'email', quotes: [] },
  ],
})
const r2 = { billingDropped: 0, notDone: 0 }
const c2 = readCandidates(raw2, 10, 10, r2)
assert.deepEqual(c2.angles.map(a => a.title), ['LinkedIn ads API billed spend vs budget'])
assert.deepEqual(c2.capabilities.map(x => x.name), ['Stripe payment webhook integration', 'Token pricing comparison'])
assert.equal(r2.billingDropped, 3)
console.log('ok technical billing kept; personal invoicing / retainer / money owed dropped')
