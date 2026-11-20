import assert from 'node:assert/strict'
import { AUDIO_DECODE_CAP_MS, heldAfterPeek, mergePeek } from './audio-capture'

const b = (s: string) => Buffer.from(s)
const first = mergePeek(undefined, { startedAt: 1, from: 0, total: 3, bytes: b('abc') })!
assert.deepEqual(first, { startedAt: 1, chunks: 3, bytes: b('abc') }, 'a first peek holds what it copied')

const more = mergePeek(first, { startedAt: 1, from: 3, total: 5, bytes: b('de') })!
assert.equal(more.bytes.toString(), 'abcde', 'a later peek appends only the new chunks')
assert.equal(more.chunks, 5)

assert.equal(mergePeek(more, { startedAt: 1, from: 5, total: 5, bytes: b('') })!.bytes.toString(), 'abcde', 'nothing new: unchanged')
assert.equal(mergePeek(more, { startedAt: 1, from: 3, total: 6, bytes: b('def') }), null, 'a gap or overlap (a racing peek) means copy it all again')
assert.equal(mergePeek(more, { startedAt: 2, from: 5, total: 6, bytes: b('x') }), null, 'another recording is never appended to this one')
assert.equal(mergePeek(undefined, { startedAt: 1, from: 3, total: 4, bytes: b('d') }), null, 'nothing held: a partial copy cannot stand alone')
assert.equal(mergePeek(more, { startedAt: 2, from: 0, total: 1, bytes: b('z') })!.bytes.toString(), 'z', 're-armed ears: the new recording replaces the old')
assert.equal(heldAfterPeek(more, AUDIO_DECODE_CAP_MS), more, 'at the decode cap the recording is still held')
assert.equal(heldAfterPeek(more, AUDIO_DECODE_CAP_MS + 1), undefined, 'past the decode cap nothing is held: each peek copies it all, as before')
console.log('peek-cache mergePeek: all assertions passed')
