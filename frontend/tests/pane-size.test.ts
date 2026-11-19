import assert from 'node:assert/strict'
import { paneSizes } from '../src/lib/pane-size'

// The chat header and Activity log row collapse on the chat column's width.
assert.equal(paneSizes(390), '', 'phone column: compact everything')
assert.equal(paneSizes(440), '', '1280 window with Rooms and Outputs open')
assert.equal(paneSizes(512), 'sm')
assert.equal(paneSizes(700), 'sm md', 'full approvals picker, icon-only header')
assert.equal(paneSizes(768), 'sm md', 'iPad column: one header row, icons only')
assert.equal(paneSizes(1024), 'sm md xl', 'header labels')
assert.equal(paneSizes(1028), 'sm md xl', '1280 window with Rooms: labels, but no model version or Audio label, so one row')
assert.equal(paneSizes(1256), 'sm md xl 2xl', 'full-width column: every label')
console.log('pane-size: ok')
