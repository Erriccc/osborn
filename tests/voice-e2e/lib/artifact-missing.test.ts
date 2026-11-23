import assert from 'node:assert/strict'
import { artifactMissing } from './artifact-missing'
assert.equal(artifactMissing(1, null, undefined, false).code, 'task_unknown')
assert.equal(artifactMissing(1, null, { artifact: null }, false).code, 'no_frame_captured')
const m = artifactMissing(3, 'R', { artifact: '/x.jpg' }, false)
assert.equal(m.code, 'frame_file_missing'); assert.match(m.error, /task 3 in run R/)
console.log('artifact-missing ok')
