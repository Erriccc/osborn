import assert from 'node:assert/strict'
import { ownDefaultTab } from './tabs'

// Tabs as names; owners by name. Tab 0 is the voice room.
const owners: Record<string, string | null> = { room: null, a1: 'a', b1: 'b', a2: 'a', free: null }
const own = (p: string) => owners[p]
const pages = ['room', 'a1', 'b1', 'a2', 'free']

assert.equal(ownDefaultTab(pages, 'a1', own, 'a'), 'a1', 'the current tab when it is yours')
assert.equal(ownDefaultTab(pages, 'room', own, 'a'), 'a2', 'a fallback to tab 0 is not yours: the newest owned tab instead')
assert.equal(ownDefaultTab(pages, 'room', own, 'c'), null, 'no own tab: never tab 0')
assert.equal(ownDefaultTab(pages, 'free', own, 'c'), null, 'an unowned tab is not yours')
assert.equal(ownDefaultTab(pages, 'b1', own, 'a'), 'a2', "never another driver's tab")
assert.equal(ownDefaultTab(pages, 'gone', own, 'a'), 'a2', 'a closed current tab falls back')
owners.room = 'a'
assert.equal(ownDefaultTab(['room'], 'room', own, 'a'), null, 'tab 0 even when you own it')
console.log('tabs ownDefaultTab: all assertions passed')
