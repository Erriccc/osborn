import assert from 'node:assert/strict'
import { staleIdOnConsume, isStaleBlock, retireTurnId, currentIdOnPush, isStaleOrRetired, replayDecision, settleAfterSay } from '../src/stale-turn.js'

let stale: string | null = null
// barge-in recorded but never consumed: later blocks of that turn still play
const ctx = { spokenText: 'hello', messageId: 'A' }
assert.equal(isStaleBlock(stale, 'A'), false, 'unconsumed barge-in does not drop the turn')
// consumed: rest of the old turn dropped, the next turn (new id) passes
stale = staleIdOnConsume(ctx, stale)
assert.equal(isStaleBlock(stale, 'A'), true)
assert.equal(isStaleBlock(stale, 'B'), false)
// blocks without an id always pass
assert.equal(isStaleBlock(stale, undefined), false)
assert.equal(isStaleBlock(stale, null), false)
// suppressed-text-only or id-less contexts do not mark
assert.equal(staleIdOnConsume({ spokenText: '' , messageId: 'C' }, 'A'), 'A')
assert.equal(staleIdOnConsume({ spokenText: 'x' }, 'A'), 'A')
assert.equal(staleIdOnConsume(null, 'A'), 'A')
// next barge-in replaces the old id
assert.equal(staleIdOnConsume({ spokenText: 'y', messageId: 'B' }, 'A'), 'B')

// #539 D: successful interrupt, no result -> retired id; next push gets a fresh id
{
  const retired = new Set<string>()
  let cur: string | null = 'OLD'
  retireTurnId(retired, cur)
  assert.equal(isStaleOrRetired(null, retired, 'OLD'), true, 'leftover old-id block is stale')
  assert.equal(currentIdOnPush(retired, cur), null, 'next push drops the retired id')
  cur = currentIdOnPush(retired, cur) ?? 'NEW'
  assert.equal(isStaleOrRetired(null, retired, cur), false, 'new reply is not stale')
  assert.equal(isStaleOrRetired(null, retired, undefined), false)
  // live id (interrupt failed / never retired) is kept on push
  assert.equal(currentIdOnPush(new Set(), 'LIVE'), 'LIVE')
  retireTurnId(retired, null)
  assert.equal(retired.size, 1)
}

// #539 A: replay decision
{
  const ok = { hasSession: true, userListening: true, sameInterruption: true, hasText: true, agentSpeaking: false, gateTriaging: false }
  assert.deepEqual(replayDecision(ok), { replay: true })
  const why = (o: object) => (replayDecision({ ...ok, ...o }) as any).reason
  assert.equal(why({ hasSession: false }), 'no session')
  assert.equal(why({ userListening: false }), 'user speaking')
  assert.match(why({ sameInterruption: false }), /new turn/)
  assert.equal(why({ hasText: false }), 'nothing buffered')
  assert.equal(why({ gateTriaging: true }), 'noise gate triaging')
  assert.equal(why({ agentSpeaking: true }), 'agent speaking')
}

// #539 C: text buffered after a say started survives its uninterrupted finish
{
  assert.equal(settleAfterSay(null), null)
  assert.equal(settleAfterSay({ spokenText: 'x', recentMessages: 'y', suppressedText: '', timestamp: 1 }), null)
  assert.deepEqual(
    settleAfterSay({ spokenText: 'x', recentMessages: 'y', suppressedText: 'later', timestamp: 5 }),
    { spokenText: '', recentMessages: '', suppressedText: 'later', timestamp: 5 },
  )
}
console.log('stale-turn: ok')
