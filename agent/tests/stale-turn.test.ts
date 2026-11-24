import assert from 'node:assert/strict'
import { staleIdOnConsume, isStaleBlock, currentIdOnPush, ReplayScheduler, takePending, putBack, settleAfterSay, isExpired } from '../src/stale-turn.js'

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
  const retired = new Set<string>(['OLD'])
  const isRetired = (id: string) => retired.has(id)
  assert.equal(isStaleBlock(null, 'OLD', isRetired), true, 'leftover old-id block is stale')
  assert.equal(currentIdOnPush(retired, 'OLD'), null, 'next push drops the retired id')
  assert.equal(isStaleBlock(null, 'NEW', isRetired), false, 'new reply is not stale')
  assert.equal(isStaleBlock(null, undefined, isRetired), false)
  assert.equal(isStaleBlock('NEW', 'NEW', isRetired), true, 'the consumed-stale id still counts')
  assert.equal(currentIdOnPush(new Set(), 'LIVE'), 'LIVE')
}

assert.equal(isExpired(0, 60_000), false); assert.equal(isExpired(0, 60_001), true)

// #539 A: the scheduler with fake timers and state (flap, triage, expiry)
{
  const realST = globalThis.setTimeout, realCT = globalThis.clearTimeout
  let now = 0, seq = 0
  const timers = new Map<number, { at: number; f: () => void }>()
  ;(globalThis as any).setTimeout = (f: () => void, ms: number) => { timers.set(++seq, { at: now + ms, f }); return seq }
  ;(globalThis as any).clearTimeout = (id: number) => { timers.delete(id) }
  const advance = (ms: number) => {
    const end = now + ms
    for (;;) {
      const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      timers.delete(next[0]); now = next[1].at; next[1].f()
    }
    now = end
  }
  try {
    const st = { li: { suppressedText: 'reply A', timestamp: 0 } as any, listening: true, triaging: false, speaking: false, session: true }
    const log: string[] = []
    const sch = new ReplayScheduler({
      current: () => st.li, userListening: () => st.listening,
      inputs: (c) => ({ hasSession: st.session, sameInterruption: st.li === c, hasText: !!st.li?.suppressedText, agentSpeaking: st.speaking, gateTriaging: st.triaging }),
      speak: () => { log.push('speak'); st.li = takePending(st.li).rest }, expire: () => { log.push('expire'); st.li = null },
      log: (m) => log.push(m), now: () => now,
    })
    // flap: back to speaking cancels, the next listening restarts the full 1.2s window
    sch.arm(); advance(1000); st.listening = false; sch.cancel(); advance(5000)
    assert.deepEqual(log, [], 'a flap to speaking cancels the replay')
    st.listening = true; sch.arm(); advance(1100); assert.deepEqual(log, []); advance(200)
    assert.deepEqual(log, ['speak'])
    assert.equal(st.li.suppressedText, '', 'spoken text is cleared (B/A never replay twice)')
    // gate triaging: skipped, re-armed, then speaks after the gate dropped the utterance
    log.length = 0; st.li = { suppressedText: 'reply B', timestamp: now }; st.triaging = true
    sch.arm(); advance(1300); assert.match(log[0], /WAITING 7 chars \(noise gate triaging/)
    st.triaging = false; advance(1300); assert.equal(log.at(-1), 'speak')
    // agent speaking, then done: re-arm continues until quiet
    log.length = 0; st.li = { suppressedText: 'reply C', timestamp: now }; st.speaking = true
    sch.arm(); advance(2500); assert.equal(log.length, 2); st.speaking = false; advance(1300); assert.equal(log.at(-1), 'speak')
    // expiry: text older than 60s is cleared, never spoken
    log.length = 0; st.li = { suppressedText: 'old', timestamp: now - 61_000 }; st.speaking = false
    sch.arm(); advance(1300); assert.ok(log.includes('expire') && !log.includes('speak'), JSON.stringify(log)); assert.equal(st.li, null)
    // consumed by a new turn: identity changed -> skipped, nothing spoken
    log.length = 0; st.speaking = false; st.li = { suppressedText: 'x', timestamp: now }; sch.arm(); st.li = null; advance(1300)
    assert.match(log[0], /SKIPPED 1 chars \(replaced or consumed/)
    // the agent never stops speaking: bounded re-arms, then it gives up without speaking
    log.length = 0; st.li = { suppressedText: 'reply D', timestamp: now }; st.speaking = true
    sch.arm(); advance(30_000); st.speaking = false
    assert.equal(log.filter((m) => m.startsWith('REPLAY WAITING')).length, 5, JSON.stringify(log))
    assert.match(log.at(-1)!, /SKIPPED 7 chars \(agent speaking, gave up\)/); assert.ok(!log.includes('speak'))
    // the user spoke again before the timer fired (no cancel reached it), no session, or the text was taken
    for (const [set, why] of [
      [() => { st.listening = false }, /user speaking/],
      [() => { st.session = false }, /no session/],
      [() => { st.li.suppressedText = '' }, /nothing buffered/],
    ] as const) {
      log.length = 0; st.listening = true; st.session = true; st.li = { suppressedText: 'reply E', timestamp: now }
      sch.arm(); set(); advance(1300)
      assert.equal(log.length, 1, JSON.stringify(log)); assert.match(log[0], why)
    }
  } finally { globalThis.setTimeout = realST; globalThis.clearTimeout = realCT }
}

// #539 B: older pending text is taken (and cleared) before a newer block speaks
{
  const li = { suppressedText: 'A', timestamp: 3, spokenText: 'x', recentMessages: '' }
  const { text, rest } = takePending(li)
  assert.equal(text, 'A'); assert.equal(rest!.suppressedText, ''); assert.equal(rest!.spokenText, 'x')
  assert.equal(takePending(null).text, ''); assert.equal(takePending(rest).text, '', 'never spoken twice')
}

// #539 C: text buffered after a say started survives its uninterrupted finish
{
  assert.equal(settleAfterSay(null), null)
  assert.equal(settleAfterSay({ spokenText: 'x', recentMessages: 'y', suppressedText: '', timestamp: 1 }), null)
  assert.deepEqual(
    settleAfterSay({ spokenText: 'x', recentMessages: 'y', suppressedText: 'later', suppressedTurnId: 'T', timestamp: 5 }),
    { spokenText: '', recentMessages: '', suppressedText: 'later', suppressedTurnId: 'T', timestamp: 5 },
    'the kept text keeps its turn id, so a replay still sees when that turn was cut off',
  )
}
// #539 B put-back: a replay cut off before it was heard returns to the buffer (the user's own turn committed)
{
  const base = { spokenText: '', recentMessages: '' }
  // flow: B2 buffered, replayed (buffer emptied), B3 buffered meanwhile, the user turn interrupts the replay
  let li: any = { ...base, suppressedText: 'B2', suppressedTurnId: 'T1', timestamp: 100 }
  const { text, rest } = takePending(li); li = rest
  assert.equal(li.suppressedText, '')
  li = { ...li, suppressedText: 'B3', suppressedTurnId: 'T1', timestamp: 500 }
  li = putBack(li, text, 'T1', 100, 1000)
  assert.equal(li.suppressedText, 'B2\nB3', 'older text first, newer kept')
  assert.equal(li.timestamp, 100, 'keeps the original age')
  // put-back landing after a handleSpeechDone that carried ''
  const after = putBack({ ...base, spokenText: 'heard', suppressedText: '', timestamp: 900 } as any, 'B2', 'T1', 100, 1000) as any
  assert.equal(after.suppressedText, 'B2'); assert.equal(after.spokenText, 'heard'); assert.equal(after.suppressedTurnId, 'T1')
  // no context at all, and expired text
  assert.equal((putBack(null, 'B2', 'T1', 100, 1000) as any).suppressedText, 'B2')
  assert.equal(putBack(null, 'B2', 'T1', 0, 61_000), null, 'expired text is not put back')
}
console.log('stale-turn: ok')
