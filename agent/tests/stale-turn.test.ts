import assert from 'node:assert/strict'
import { staleIdOnConsume, isStaleBlock, currentIdOnPush, isStaleOrRetired, replayStep, ReplayScheduler, takePending, settleAfterSay, isExpired, MAX_REPLAY_REARMS } from '../src/stale-turn.js'

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
  assert.equal(isStaleOrRetired(null, isRetired, 'OLD'), true, 'leftover old-id block is stale')
  assert.equal(currentIdOnPush(retired, 'OLD'), null, 'next push drops the retired id')
  assert.equal(isStaleOrRetired(null, isRetired, 'NEW'), false, 'new reply is not stale')
  assert.equal(isStaleOrRetired(null, isRetired, undefined), false)
  assert.equal(currentIdOnPush(new Set(), 'LIVE'), 'LIVE')
}

// #539 A: one step of the replay decision
{
  const ok = { hasSession: true, userListening: true, sameInterruption: true, hasText: true, agentSpeaking: false, gateTriaging: false, expired: false, attempts: 0 }
  const step = (o: object) => replayStep({ ...ok, ...o }) as any
  assert.equal(step({}).act, 'speak')
  assert.equal(step({ hasSession: false }).reason, 'no session')
  assert.equal(step({ userListening: false }).reason, 'user speaking')
  assert.match(step({ sameInterruption: false }).reason, /new turn/)
  assert.equal(step({ hasText: false }).reason, 'nothing buffered')
  assert.equal(step({ expired: true }).act, 'expire')
  assert.deepEqual(step({ gateTriaging: true }), { act: 'rearm', reason: 'noise gate triaging' })
  assert.deepEqual(step({ agentSpeaking: true }), { act: 'rearm', reason: 'agent speaking' })
  assert.equal(step({ gateTriaging: true, attempts: MAX_REPLAY_REARMS }).act, 'skip', 'bounded re-arms')
  assert.equal(isExpired(0, 60_000), false); assert.equal(isExpired(0, 60_001), true)
}

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
    const st = { li: { suppressedText: 'reply A', timestamp: 0 } as any, listening: true, triaging: false, speaking: false }
    const log: string[] = []
    const sch = new ReplayScheduler({
      current: () => st.li, userListening: () => st.listening,
      inputs: (c) => ({ hasSession: true, sameInterruption: st.li === c, hasText: !!st.li?.suppressedText, agentSpeaking: st.speaking, gateTriaging: st.triaging }),
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
    sch.arm(); advance(1300); assert.match(log[0], /WAITING \(noise gate triaging/)
    st.triaging = false; advance(1300); assert.equal(log.at(-1), 'speak')
    // agent speaking, then done: re-arm continues until quiet
    log.length = 0; st.li = { suppressedText: 'reply C', timestamp: now }; st.speaking = true
    sch.arm(); advance(2500); assert.equal(log.length, 2); st.speaking = false; advance(1300); assert.equal(log.at(-1), 'speak')
    // expiry: text older than 60s is cleared, never spoken
    log.length = 0; st.li = { suppressedText: 'old', timestamp: now - 61_000 }; st.speaking = false
    sch.arm(); advance(1300); assert.ok(log.includes('expire') && !log.includes('speak'), JSON.stringify(log)); assert.equal(st.li, null)
    // consumed by a new turn: identity changed -> skipped, nothing spoken
    log.length = 0; st.speaking = false; st.li = { suppressedText: 'x', timestamp: now }; sch.arm(); st.li = null; advance(1300)
    assert.match(log[0], /SKIPPED/)
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
    settleAfterSay({ spokenText: 'x', recentMessages: 'y', suppressedText: 'later', timestamp: 5 }),
    { spokenText: '', recentMessages: '', suppressedText: 'later', timestamp: 5 },
  )
}
console.log('stale-turn: ok')
