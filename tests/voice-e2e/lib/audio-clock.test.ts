import assert from 'node:assert/strict'
import { recordingMsAt } from './audio-capture'

// The recording runs on the page's audio clock. On a throttled machine it ran at
// 0.37x wall time, so a wall-clock window must be mapped through the samples.
const slow: Array<[number, number]> = [[1000, 0], [11000, 3700], [21000, 7400]]
assert.equal(recordingMsAt(slow, 11000), 3700, 'a sample maps exactly')
assert.equal(Math.round(recordingMsAt(slow, 16000)), 5550, 'between samples it interpolates')
assert.equal(Math.round(recordingMsAt(slow, 31000)), 11100, 'past the last sample it keeps the last rate')
assert.equal(recordingMsAt(slow, 0), -1000, 'before the recording started: the wall-clock gap (the clip starts first)')
assert.equal(recordingMsAt([[5000, 0]], 8000), 3000, 'one sample: real time')
assert.equal(recordingMsAt([], 8000), 0, 'no samples: the start')
console.log('audio clock: all assertions passed')
