import assert from 'node:assert/strict'
import { SpeechTimeline, continuationNote, rambleHoldMs, CONTINUATION_WINDOW_MS } from '../src/speech-timeline.js'
import { isShhCue } from '../src/noise-gate.js'

// #587: whole utterance or first word only
for (const t of ['shh', 'Shh.', 'shhh', 'Shhhh!', 'shush', 'Shush.', 'shh, hold on', 'shush the dog']) assert.equal(isShhCue(t), true, t)
for (const t of ['', 'sh', 'should we ship', 'she said shh', 'can you shh', 'show me', 'shell', 'hush', 'ssh into the box', 'ok shh']) assert.equal(isShhCue(t), false, t)

// #581 scripted two-chunk scenario: chunk 1, 2 s pause, chunk 2
{
  const tl = new SpeechTimeline()
  tl.onUserState(true, 0); tl.onTranscript('I want to refactor the', false, 500); tl.onTranscript('I want to refactor the auth module', true, 2000)
  tl.onUserState(false, 2100)
  assert.equal(tl.onTurnCommit(3000), null, 'first commit: nothing continued')
  assert.equal(tl.shouldHoldBlock(3500), false, 'single chunk: the reply plays, no added hold')
  // pause, then the user resumes
  tl.onUserState(true, 5000); tl.onTranscript('and also the session', false, 5300)
  assert.equal(tl.shouldHoldBlock(5400), true, 'reply to chunk 1 held while chunk 2 is spoken')
  tl.onUserState(false, 6500)
  assert.equal(tl.shouldHoldBlock(6600), true, 'still held between chunk 2 speech and its commit')
  assert.equal(tl.awaitingContinuation(6600), true)
  assert.equal(tl.shouldHoldBlock(5300 + CONTINUATION_WINDOW_MS + 1), false, 'abandoned fragment: hold expires')
  const c = tl.onTurnCommit(7000)
  assert.deepEqual(c, { continuedAfterMs: 2300 })
  assert.match(continuationNote(c), /kept talking about 2s after/)
  assert.equal(tl.shouldHoldBlock(7100), false, 'the new turn is committed: its reply plays')
  assert.equal(tl.onTurnCommit(9000), null, 'no speech between commits: no note')
}
// echo / one-word noise does not count
{
  const tl = new SpeechTimeline()
  tl.onTurnCommit(0); tl.onTranscript('uh', false, 100)
  assert.equal(tl.shouldHoldBlock(200), false)
  assert.equal(continuationNote(null), '')
}
// ramble hold: off by default, under 20 s zero, capped at 3 s, never touches anything else
assert.equal(rambleHoldMs(30_000), 0, 'flag off by default')
assert.equal(rambleHoldMs(5_000, true), 0)
assert.equal(rambleHoldMs(25_000, true), 2500)
assert.equal(rambleHoldMs(90_000, true), 3000)
{
  const tl = new SpeechTimeline(); tl.onUserState(true, 0); tl.onUserState(false, 30_000)
  assert.equal(tl.lastTalkedMs, 30_000)
}
console.log('speech-timeline: ok')
