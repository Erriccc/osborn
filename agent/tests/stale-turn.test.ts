import assert from 'node:assert/strict'
import { staleIdOnConsume, isStaleBlock, currentIdOnPush, ReplayScheduler, takePending, putBack, settleAfterSay, isExpired, appendBlock, partitionForReplay, liveBlocks, joinBlocks } from '../src/stale-turn.js'
import { noiseGate } from '../src/noise-gate.js'

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
  const mk = (t: string, at: number): any => ({ suppressedBlocks: t ? [{ text: t, at }] : [], timestamp: at })
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
    const st = { li: mk('reply A', 0) as any, listening: true, triaging: false, speaking: false, session: true }
    const log: string[] = []
    const sch = new ReplayScheduler({
      current: () => st.li, userListening: () => st.listening,
      inputs: (c) => ({ hasSession: st.session, sameInterruption: st.li === c, hasText: !!st.li?.suppressedBlocks.length, agentSpeaking: st.speaking, gateTriaging: st.triaging }),
      speak: () => { log.push('speak'); st.li = takePending(st.li).rest }, expire: () => { log.push('expire'); st.li = null },
      log: (m) => log.push(m), now: () => now,
    })
    // flap: back to speaking cancels, the next listening restarts the full 1.2s window
    sch.arm(); advance(1000); st.listening = false; sch.cancel(); advance(5000)
    assert.deepEqual(log, [], 'a flap to speaking cancels the replay')
    st.listening = true; sch.arm(); advance(1100); assert.deepEqual(log, []); advance(200)
    assert.deepEqual(log, ['speak'])
    assert.equal(st.li.suppressedBlocks.length, 0, 'spoken text is cleared (B/A never replay twice)')
    // gate triaging: skipped, re-armed, then speaks after the gate dropped the utterance
    log.length = 0; st.li = mk('reply B', now); st.triaging = true
    sch.arm(); advance(1300); assert.match(log[0], /WAITING 7 chars \(noise gate triaging/)
    st.triaging = false; advance(1300); assert.equal(log.at(-1), 'speak')
    // agent speaking, then done: re-arm continues until quiet
    log.length = 0; st.li = mk('reply C', now); st.speaking = true
    sch.arm(); advance(2500); assert.equal(log.length, 2); st.speaking = false; advance(1300); assert.equal(log.at(-1), 'speak')
    // expiry: text older than 60s is cleared, never spoken
    log.length = 0; st.li = mk('old', now - 61_000); st.speaking = false
    sch.arm(); advance(1300); assert.ok(log.includes('expire') && !log.includes('speak'), JSON.stringify(log)); assert.equal(st.li, null)
    // consumed by a new turn: identity changed -> skipped, nothing spoken
    log.length = 0; st.speaking = false; st.li = mk('x', now); sch.arm(); st.li = null; advance(1300)
    assert.match(log[0], /SKIPPED 1 chars \(replaced or consumed/)
    // the agent never stops speaking: bounded re-arms, then it gives up without speaking
    log.length = 0; st.li = mk('reply D', now); st.speaking = true
    sch.arm(); advance(30_000); st.speaking = false
    assert.equal(log.filter((m) => m.startsWith('REPLAY WAITING')).length, 5, JSON.stringify(log))
    assert.match(log.at(-1)!, /SKIPPED 7 chars \(agent speaking, gave up\)/); assert.ok(!log.includes('speak'))
    // the user spoke again before the timer fired (no cancel reached it), no session, or the text was taken
    for (const [set, why] of [
      [() => { st.listening = false }, /user speaking/],
      [() => { st.session = false }, /no session/],
      [() => { st.li.suppressedBlocks = [] }, /nothing buffered/],
    ] as const) {
      log.length = 0; st.listening = true; st.session = true; st.li = mk('reply E', now)
      sch.arm(); set(); advance(1300)
      assert.equal(log.length, 1, JSON.stringify(log)); assert.match(log[0], why)
    }
  } finally { globalThis.setTimeout = realST; globalThis.clearTimeout = realCT }
}

// #539 A: the replay's gateTriaging input is true only while classify() holds an utterance
{
  const key = process.env.OPENROUTER_API_KEY
  delete process.env.OPENROUTER_API_KEY
  try {
    const ctx = { recentTurns: [], activeWork: '' }
    assert.equal(noiseGate.triaging, false)
    const held = [noiseGate.classify('x', ctx), noiseGate.classify('y', ctx)]
    assert.equal(noiseGate.triaging, true, 'held while triage runs')
    await Promise.all(held)
    assert.equal(noiseGate.triaging, false, 'released once every triage settled')
  } finally { if (key !== undefined) process.env.OPENROUTER_API_KEY = key }
}

// #539 B: older pending blocks are taken (and cleared) before a newer block speaks
{
  const li = { suppressedBlocks: [{ text: 'A', at: 3 }], timestamp: 3, spokenText: 'x', recentMessages: '' }
  const { blocks, rest } = takePending(li)
  assert.equal(joinBlocks(blocks), 'A'); assert.equal(rest!.suppressedBlocks.length, 0); assert.equal(rest!.spokenText, 'x')
  assert.equal(takePending(null).blocks.length, 0); assert.equal(takePending(rest).blocks.length, 0, 'never spoken twice')
}

// #539 C: blocks buffered after a say started survive its uninterrupted finish
{
  assert.equal(settleAfterSay(null), null)
  assert.equal(settleAfterSay({ spokenText: 'x', recentMessages: 'y', suppressedBlocks: [], timestamp: 1 }), null)
  assert.deepEqual(
    settleAfterSay({ spokenText: 'x', recentMessages: 'y', suppressedBlocks: [{ text: 'later', turnId: 'T', at: 5 }], timestamp: 9 }),
    { spokenText: '', recentMessages: '', suppressedBlocks: [{ text: 'later', turnId: 'T', at: 5 }], timestamp: 5 },
    'the kept block keeps its turn id and first-buffered time',
  )
}
// #539 B put-back: a replay cut off before it was heard returns to the buffer (the user's own turn committed)
{
  const base = { spokenText: '', recentMessages: '' }
  const B2 = { text: 'B2', turnId: 'T1', at: 100 }
  let li: any = { ...base, suppressedBlocks: [B2], timestamp: 100 }
  const { blocks, rest } = takePending(li); li = rest
  assert.equal(li.suppressedBlocks.length, 0)
  li = { ...li, suppressedBlocks: [{ text: 'B3', turnId: 'T1', at: 500 }], timestamp: 500 }
  li = putBack(li, blocks, 1000)
  assert.equal(joinBlocks(li.suppressedBlocks), 'B2\nB3', 'older text first, newer kept')
  assert.equal(li.suppressedBlocks[0].at, 100, 'keeps the original age per block')
  assert.equal(li.timestamp, 100)
  const after = putBack({ ...base, spokenText: 'heard', suppressedBlocks: [], timestamp: 900 } as any, [B2], 1000) as any
  assert.equal(joinBlocks(after.suppressedBlocks), 'B2'); assert.equal(after.spokenText, 'heard'); assert.equal(after.suppressedBlocks[0].turnId, 'T1')
  assert.equal(joinBlocks((putBack(null, [B2], 1000) as any).suppressedBlocks), 'B2')
  assert.equal(putBack(null, [{ text: 'B2', at: 0 }], 61_000), null, 'expired text is not put back')
}

// #549: per-block provenance and age
{
  const stale = (ids: string[]) => (id?: string) => !!id && ids.includes(id)
  const texts = (bs: any[]) => bs.map((b) => b.text)
  // retired + live, either order: retired never spoken (kept for the prompt), live spoken
  for (const order of [['R', 'L'], ['L', 'R']]) {
    let li: any = null
    order.forEach((id, n) => { li = appendBlock(li, id === 'R' ? 'retired' : 'live', id, 1000 + n) })
    const p = partitionForReplay(li.suppressedBlocks, 2000, stale(['R']))
    assert.deepEqual(texts(p.speak), ['live'], order.join()); assert.deepEqual(texts(p.keep), ['retired'])
  }
  // a no-id block after a retired one does not erase the retired entry's provenance, and is itself live
  let li: any = appendBlock(null, 'retired', 'R', 0)
  li = appendBlock(li, 'anon', undefined, 1)
  assert.deepEqual(li.suppressedBlocks.map((b: any) => b.turnId), ['R', undefined])
  const p = partitionForReplay(li.suppressedBlocks, 2, stale(['R']))
  assert.deepEqual([texts(p.speak), texts(p.keep)], [['anon'], ['retired']])
  // appends at t=0 and t=50s: the t=0 block expires at 60s whatever was appended later
  let e: any = appendBlock(null, 'first', 'T', 0)
  e = appendBlock(e, 'second', 'T', 50_000)
  assert.deepEqual(texts(liveBlocks(e.suppressedBlocks, 60_000)), ['first', 'second'])
  assert.deepEqual(texts(liveBlocks(e.suppressedBlocks, 60_001)), ['second'])
  const q = partitionForReplay(e.suppressedBlocks, 60_001, () => false)
  assert.deepEqual([texts(q.speak), q.expired], [['second'], 1])
  // carried into a new context (handleSpeechDone) keeps original times: same objects
  assert.equal(liveBlocks(e.suppressedBlocks, 1)[0].at, 0)
  // a say started, then a block arrives: settleAfterSay keeps it with its own time
  const kept = settleAfterSay({ ...appendBlock(null, 'post', 'T9', 7_000), spokenText: 'x' } as any)
  assert.deepEqual(kept!.suppressedBlocks, [{ text: 'post', turnId: 'T9', at: 7_000 }])
}
console.log('stale-turn: ok')
