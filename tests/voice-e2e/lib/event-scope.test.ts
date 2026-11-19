import assert from 'node:assert/strict'
import { eventOwners, eventVisibleTo, tabsFor } from './event-scope'

const owners = [null, 'person:a@x.com', 'agent-1']
const at = (i: number) => owners[i]
const A = 'person:a@x.com', B = 'person:b@x.com'

// Owners read from every tab field the engine's events carry.
assert.deepEqual(eventOwners({ url: 'https://x', tab: 1 }, at), [A], 'navigation on tab 1')
assert.deepEqual(eventOwners({ url: 'https://x', tab: 0 }, at), [], 'an unowned tab is public')
assert.deepEqual(eventOwners({ task: { n: 3, text: 'secret', tab: { owner: 'agent-1' } } }, at), ['agent-1'], 'task')
assert.deepEqual(eventOwners({ op: 'open', activeTab: { i: 2, owner: 'agent-1' } }, at), ['agent-1'], 'tab op')
assert.deepEqual(eventOwners({ i: 1, by: B, prevOwner: A }, at), [B, A], 'takeover names both')
assert.deepEqual(eventOwners({ live: 'https://e', useAuth: true }, at), [], 'engine status has no tab')

// Persons see public events and their own; agents see everything.
assert.equal(eventVisibleTo([], B), true, 'public event')
assert.equal(eventVisibleTo([A], A), true, 'own tab')
assert.equal(eventVisibleTo([A], B), false, "another person's tab")
assert.equal(eventVisibleTo(['agent-1'], B), false, "an agent's tab")
assert.equal(eventVisibleTo([B, A], A), true, 'a takeover of your tab')
assert.equal(eventVisibleTo([A], 'agent-1'), true, 'agents keep the full feed')
assert.equal(eventVisibleTo([A], 'default'), true, 'no x-driver-id keeps the full feed')
// Tab lists: a person sees other drivers' tabs without their URL; agents see all.
const urls = ['https://room', 'https://a-private', 'https://agent']
const list = (viewer: string) => tabsFor([0, 1, 2], at, (i) => urls[i], viewer)
assert.deepEqual(list(A).map((t) => t.url), ['', 'https://a-private', ''], 'person: own URL only')
assert.deepEqual(list(B).map((t) => t.url), ['', '', ''], 'another person: no URLs')
assert.deepEqual(list('agent-1').map((t) => t.url), urls, 'agents keep URLs')
assert.deepEqual(list(B).map((t) => t.owner), [null, A, 'agent-1'], 'owners stay listed, for takeover')
console.log('event-scope: all assertions passed')
