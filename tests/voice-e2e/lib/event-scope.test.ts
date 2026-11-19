import assert from 'node:assert/strict'
import { canonicalDriverId, eventOwners, eventVisibleTo, ownerSeenBy, personMayTake, personOwns, seesTabOf, tabsFor } from './event-scope'

// Tab 0 is the voice room (unowned); tab 1 person A's; tab 2 an agent's; tab 3 unowned; tab 4 person B's.
const A = 'person:a@x.com', B = 'person:b@x.com', AGENT = 'agent-1'
const owners = [null, A, AGENT, null, B]
const at = (i: number) => owners[i]

// THE RULE, table-driven: what person A may see and act on, and what an agent may.
type Row = { name: string; payload: Record<string, unknown>; a: boolean; agent: boolean }
const rows: Row[] = [
  { name: 'own tab', payload: { url: 'u', tab: 1 }, a: true, agent: true },
  { name: "another person's tab", payload: { url: 'u', tab: 4 }, a: false, agent: true },
  { name: "agent's tab", payload: { url: 'u', tab: 2 }, a: false, agent: true },
  { name: 'unowned tab', payload: { url: 'u', tab: 3 }, a: false, agent: true },
  { name: 'tab 0 (voice room)', payload: { text: 'transcript', tab: 0 }, a: false, agent: true },
  { name: 'task on tab 0', payload: { task: { n: 1, text: 't', tab: { owner: null } } }, a: false, agent: true },
  { name: 'own task', payload: { task: { n: 2, text: 't', tab: { owner: A } } }, a: true, agent: true },
  { name: 'tab event about your tab', payload: { op: 'open', by: A, activeTab: { i: 1, owner: A } }, a: true, agent: true },
  { name: 'tab event with no tab of yours', payload: { op: 'close', by: A }, a: true, agent: true },
  { name: "agent's tab event", payload: { op: 'open', by: AGENT, activeTab: { i: 2, owner: AGENT } }, a: false, agent: true },
  { name: 'takeover of an agent tab', payload: { i: 2, by: A, prevOwner: AGENT }, a: false, agent: true },
  { name: 'tab-less event (engine status)', payload: { live: 'https://e', useAuth: true }, a: true, agent: true },
  { name: 'journey of no one', payload: { name: 'j', owner: null }, a: false, agent: true },
]
for (const r of rows) {
  const o = eventOwners(r.payload, at)
  assert.equal(eventVisibleTo(o, A), r.a, `person: ${r.name}`)
  assert.equal(eventVisibleTo(o, AGENT), r.agent, `agent: ${r.name}`)
  assert.equal(eventVisibleTo(o, 'default'), true, `no x-driver-id: ${r.name}`)
}

// Seeing and taking tabs, by tab.
const tabRows: Array<{ i: number; sees: boolean; take: boolean; profile?: string }> = [
  { i: 1, sees: true, take: true, profile: 'person:a@x.com' },  // own
  { i: 4, sees: false, take: false, profile: 'person:b@x.com' },  // another person's
  { i: 2, sees: false, take: true, profile: '' },  // agent's: take control is allowed
  { i: 3, sees: false, take: false, profile: '' },  // unowned
  { i: 0, sees: false, take: false, profile: '' },  // tab 0
]
for (const t of tabRows) {
  assert.equal(seesTabOf(at(t.i), A), t.sees, `sees tab ${t.i}`)
  assert.equal(personMayTake(A, t.i, at(t.i), t.profile), t.take, `takes tab ${t.i}`)
  assert.equal(seesTabOf(at(t.i), AGENT), true, `agent sees tab ${t.i}`)
  assert.equal(personMayTake(AGENT, t.i, at(t.i), t.profile), true, `agent not limited, tab ${t.i}`)
}
assert.equal(personOwns(null, A), false, 'nobody owns an unowned tab')
assert.equal(personMayTake(B, 3, null, 'person:a@x.com'), false, "a released tab in another person's profile")
assert.equal(personMayTake('person:A@X.com', 1, 'person:A@X.com', 'person:a@x.com'), true, 'your profile, any email case')
assert.equal(personMayTake(A, 0, AGENT, ''), false, 'tab 0 even after an agent claimed it')
assert.equal(personMayTake(A, 0, A, ''), false, 'tab 0 even if a person somehow owns it')
assert.equal(personMayTake(AGENT, 0, null, ''), true, 'agents may still take tab 0')

// Tab lists: a person sees only their own URL, and other people as "person".
const urls = ['https://room', 'https://a-private', 'https://agent', 'https://free', 'https://b-private']
const list = (viewer: string) => tabsFor([0, 1, 2, 3, 4], at, (i) => urls[i], viewer)
assert.deepEqual(list(A).map((t) => t.url), ['', 'https://a-private', '', '', ''], 'person: own URL only')
assert.deepEqual(list(AGENT).map((t) => t.url), urls, 'agents keep URLs')
assert.deepEqual(list(B).map((t) => t.owner), [null, 'person', AGENT, null, B], 'another person is just "person"; agent ids stay')
assert.deepEqual(list(AGENT).map((t) => t.owner), owners, 'agents see every id')
assert.equal(ownerSeenBy(null, B), null)
// One spelling per driver (#243, #235): a person's id in any case or padding is one driver.
assert.equal(canonicalDriverId(' Person:A@X.com '), A, 'person id: trimmed and lowercased')
assert.equal(canonicalDriverId('PERSON:a@x.com'), A, 'person prefix in any case is a person')
assert.equal(canonicalDriverId(' Muse-Parity '), 'Muse-Parity', 'agent ids keep their case')
assert.equal(canonicalDriverId(undefined), 'default', 'no header')
assert.equal(canonicalDriverId('   '), 'default', 'blank header')
assert.equal(canonicalDriverId('x'.repeat(500)).length, 200, 'bounded')
console.log('event-scope: all assertions passed')
