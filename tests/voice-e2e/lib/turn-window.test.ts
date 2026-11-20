import assert from 'node:assert/strict'
import { turnCutWindow } from './converse'

// #185: the transcript is cut to end where the clip ends.
assert.deepEqual(turnCutWindow(5000), { cutMs: 4000, durationMs: null }, 'no end: runs to the end of the recording')
assert.deepEqual(turnCutWindow(5000, 12000), { cutMs: 4000, durationMs: 8000 }, 'ends at untilMs')
assert.deepEqual(turnCutWindow(300, 2000), { cutMs: 0, durationMs: 2000 }, 'cut clamps at the file start')
assert.deepEqual(turnCutWindow(5000, 3000), { cutMs: 4000, durationMs: 0 }, 'an end before the cut is empty, not negative')

console.log('turn-window: ok')
