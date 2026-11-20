import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { turnCutWindow } from './converse'

// #185: the transcript is cut to end where the clip ends.
assert.deepEqual(turnCutWindow(5000), { cutMs: 4000, durationMs: null }, 'no end: runs to the end of the recording')
assert.deepEqual(turnCutWindow(5000, 12000), { cutMs: 4000, durationMs: 8000 }, 'ends at untilMs')
assert.deepEqual(turnCutWindow(300, 2000), { cutMs: 0, durationMs: 2000 }, 'cut clamps at the file start')
assert.deepEqual(turnCutWindow(5000, 3000), { cutMs: 4000, durationMs: 0 }, 'an end before the cut is empty, not negative')

// The engine passes the clip's end (tClip) to both hearing paths and skips the clip on clip:false.
const src = readFileSync(new URL('../scripts/session-engine.ts', import.meta.url), 'utf8')
assert.match(src, /hearFromWav\(decoded\.wav, recordingMsAt\(decoded\.clock, t0\), recordingMsAt\(decoded\.clock, tClip\)\)/, 'decoded hearing ends at the clip cut')
assert.match(src, /hearSince\(page, Math\.max\(0, t0 - earsAt\), Math\.max\(0, tClip - earsAt\)\)/, 'raw hearing ends at the clip cut')
assert.match(src, /const hearSpan = hearing \? \[t0, tClip\] : null/, 'stamped hearSpan ends with the clip')
assert.match(src, /const rangeJob = wantClip && live\?\.clipRange/, '/say clip:false cuts no clip')
assert.match(src, /const actRange = body\.clip !== false && live\?\.clipRange/, '/act clip:false cuts no clip')
console.log('turn-window: ok')
