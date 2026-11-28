// Run: npx tsx agent/tests/speech-timeline.test.ts
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'osb-speech-timeline-'))
process.env.HOME = home
process.env.CLAUDE_CONFIG_DIR = join(home, '.claude')
delete process.env.OSBORN_SPEECH_TIMELINE_HOLD

const { SpeechTimeline, speechTimeline, speechTimelineHold, CONTINUATION_WINDOW_MS } = await import('../src/speech-timeline.js')
const { isShhCue } = await import('../src/noise-gate.js')
const { getContinuationNote, getNoiseCancelNote } = await import('../src/prompts.js')
const { cleanTurnText, steersTurn } = await import('../src/content/transcript-sanitizer.js')
const { ReplayScheduler, takePending } = await import('../src/stale-turn.js')
const { PipelineDirectLLM } = await import('../src/pipeline-direct-llm.js')
const { llm, initializeLogger } = await import('@livekit/agents')
initializeLogger({ pretty: false, level: 'warn' })

// #587: whole utterance or first word only
for (const t of ['shh', 'Shh.', 'shhh', 'Shhhh!', 'shush', 'Shush.', 'shh please', 'ok shh', 'shush now']) assert.equal(isShhCue(t), true, t)
for (const t of ['', 'sh', 'she', 'she said shh', 'shush the dog now', 'shell', 'show me', 'should we ship', 'hush', 'ssh into the box', 'shh, hold on, what does parseConfig return?', 'shhh I think the plan is fine', 'can you shh', 'shoo', 's h h']) assert.equal(isShhCue(t), false, t)

// The flag: on by default, off only for off/0/false
assert.equal(speechTimelineHold({}), true)
for (const v of ['off', '0', 'FALSE']) assert.equal(speechTimelineHold({ OSBORN_SPEECH_TIMELINE_HOLD: v } as any), false, v)
for (const v of ['on', '1', 'TRUE', 'yes', '']) assert.equal(speechTimelineHold({ OSBORN_SPEECH_TIMELINE_HOLD: v } as any), true, v)

// #581 two chunks: chunk 1 committed, a pause, then chunk 2
{
  const tl = new SpeechTimeline()
  assert.equal(tl.onTurnCommit(3000), null, 'first commit: nothing continued')
  assert.equal(tl.shouldHold(3500, true), false, 'single chunk: the reply plays')
  tl.onTranscript(4, 5300)
  assert.equal(tl.awaitingContinuation(5400), true, 'recorded passively')
  assert.equal(tl.shouldHold(5400), true, 'default: held')
  assert.equal(tl.shouldHold(5400, false), false, 'flag explicitly off: never held')
  assert.equal(tl.shouldHold(5400, true), true, 'flag on: reply to chunk 1 held')
  assert.equal(tl.shouldHold(5300 + CONTINUATION_WINDOW_MS, true), false, 'abandoned fragment: the hold expires')
  const c = tl.onTurnCommit(7000)
  assert.deepEqual(c, { continuedAfterMs: 2300 })
  assert.match(getContinuationNote(c!.continuedAfterMs), /kept talking about 2s after/)
  assert.equal(tl.shouldHold(7100, true), false, 'the new turn is committed: its reply plays')
  assert.equal(tl.onTurnCommit(9000), null, 'no speech between commits: no note')
}
// echo and noise do not count: 1-2 words, or anything while the agent speaks
{
  const tl = new SpeechTimeline()
  tl.onTurnCommit(0); tl.onTranscript(2, 100)
  assert.equal(tl.awaitingContinuation(200), false, 'two words')
  tl.onAgentState(true); tl.onTranscript(6, 300)
  assert.equal(tl.awaitingContinuation(400), false, 'while the agent speaks')
  tl.onAgentState(false); tl.onTranscript(6, 500)
  assert.equal(tl.awaitingContinuation(600), false, 'the agent already answered: the user is replying, not continuing')
  assert.equal(tl.onTurnCommit(2000), null)
  tl.onTranscript(6, 2500)
  assert.equal(tl.awaitingContinuation(2600), true, 'a new commit opens a new window')
}
// a normal follow-up turn is not a continuation: after the window, or after the agent replied
{
  const tl = new SpeechTimeline()
  tl.onTurnCommit(0); tl.onTranscript(5, CONTINUATION_WINDOW_MS + 1000)
  assert.equal(tl.onTurnCommit(CONTINUATION_WINDOW_MS + 2000), null, 'speech after the window: no note')
  tl.onAgentState(true); tl.onAgentState(false); tl.onTranscript(5, CONTINUATION_WINDOW_MS + 3000)
  assert.equal(tl.onTurnCommit(CONTINUATION_WINDOW_MS + 4000), null, 'speech after the agent replied: no note')
  // speech that never became a turn (the noise gate dropped it), then the held reply played: the next turn is no continuation
  tl.onTranscript(5, CONTINUATION_WINDOW_MS + 5000)
  assert.equal(tl.awaitingContinuation(CONTINUATION_WINDOW_MS + 5100), true)
  tl.onAgentState(true); tl.onAgentState(false)
  assert.equal(tl.onTurnCommit(CONTINUATION_WINDOW_MS + 90_000), null, 'the agent spoke after it: no note')
}

// A held block is never lost when the user never speaks again: the replay waits out the window, then speaks
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
    for (const on of [false, true]) {
      const tl = new SpeechTimeline()
      tl.onTurnCommit(now); tl.onTranscript(4, now + 500)
      const st = { li: { suppressedBlocks: [{ text: 'reply to chunk one', at: now + 1000 }], timestamp: now + 1000 } as any }
      const log: string[] = []
      const start = now
      const sch = new ReplayScheduler({
        current: () => st.li, userListening: () => true,
        inputs: (c) => ({ hasSession: true, sameInterruption: st.li === c, hasText: !!st.li?.suppressedBlocks.length, agentSpeaking: false, gateTriaging: tl.shouldHold(now, on) }),
        speak: () => { log.push(`speak@${now - start}`); st.li = takePending(st.li).rest }, expire: () => log.push('expire'),
        log: (m) => log.push(m), now: () => now,
      })
      advance(1000); sch.arm(); advance(20_000)
      const spoke = log.find((m) => m.startsWith('speak@'))
      assert.ok(spoke, `${on}: ${JSON.stringify(log)}`)
      if (!on) assert.equal(spoke, 'speak@2200', 'flag off: replay timing as on main')
      else assert.ok(Number(spoke.slice(6)) >= 500 + CONTINUATION_WINDOW_MS, `flag on: waits out the window (${spoke})`)
    }
  } finally { globalThis.setTimeout = realST; globalThis.clearTimeout = realCT }
}

// Through PipelineDirectLLM.chat: the note reaches the model only with the flag on; off, the text is exactly the user's
{
  const seen: string[] = []
  const inner: any = new Proxy({}, { get: (_t, k) => k === 'chat' ? ({ chatCtx }: any) => { const m = chatCtx.items.at(-1); seen.push(m.content.join('\n')); return {} } : k === 'sessionId' ? 'aaaaaaaa-0000-4000-8000-000000000000' : () => undefined })
  const pd: any = new PipelineDirectLLM({ workingDirectory: home, voiceMode: 'direct', skipTTSQueue: true })
  pd.swapInner(inner)
  const say = (text: string) => { const c = new llm.ChatContext(); c.addMessage({ role: 'user', content: text }); pd.chat({ chatCtx: c }) }
  for (const on of [false, true]) {
    if (on) delete process.env.OSBORN_SPEECH_TIMELINE_HOLD; else process.env.OSBORN_SPEECH_TIMELINE_HOLD = 'off'
    seen.length = 0
    say('I want to refactor the auth module')
    speechTimeline.onTranscript(4, Date.now() + 1)
    await new Promise((r) => setTimeout(r, 5))
    say('and also the session store')
    assert.equal(seen[0], 'I want to refactor the auth module')
    if (on) {
      assert.match(seen[1], /^<system-reminder>\nThe user kept talking about 1s after your previous turn started[^\n]*\n<\/system-reminder>\n\nand also the session store$/)
      assert.equal(cleanTurnText(seen[1]), 'and also the session store', 'history, titles and echoes strip the note')
      assert.equal(cleanTurnText(`${getContinuationNote(2000)}\n\n[CONTEXT] x\n\nWhat the user is saying now:\n"and more"\n\nText you produced that the user did NOT hear:\n"y"`), 'and more', 'the [CONTEXT] wrapper under it still unwraps')
    }
    else assert.equal(seen[1], 'and also the session store', 'flag off: nothing added')
  }
  process.env.OSBORN_SPEECH_TIMELINE_HOLD = 'on'
  say('x y z'); assert.equal(seen.at(-1), 'x y z', 'explicit on behaves as on (no pending speech here)')
  delete process.env.OSBORN_SPEECH_TIMELINE_HOLD
}
// pending speech: expires with the window, reset drops it
{
  const t = new SpeechTimeline()
  t.onTurnCommit(0); t.onTranscript(4, 2000); t.onTranscript(4, 4000)
  assert.equal(t.onTurnCommit(240_000), null, 'a 240 s late turn gets no note')
  const u = new SpeechTimeline()
  u.onTurnCommit(0); u.onTranscript(4, 2000)
  assert.deepEqual(u.onTurnCommit(3000), { continuedAfterMs: 2000 })
  const r = new SpeechTimeline()
  r.onTurnCommit(0); r.onTranscript(4, 2000); r.reset()
  assert.equal(r.onTurnCommit(3000), null, 'reset drops pending speech')
}
// a handled voice action (or shh) is not a turn commit: the pending speech survives it (runtime, through chat())
{
  const inner: any = new Proxy({}, { get: (_t, k) => k === 'chat' ? () => ({}) : k === 'sessionId' ? 'aaaaaaaa-0000-4000-8000-000000000000' : () => undefined })
  const pd: any = new PipelineDirectLLM({ workingDirectory: home, voiceMode: 'direct', skipTTSQueue: true, takeVoiceAction: (t: string) => isShhCue(t) })
  pd.swapInner(inner)
  const say = (text: string) => { const c = new llm.ChatContext(); c.addMessage({ role: 'user', content: text }); pd.chat({ chatCtx: c }) }
  say('I want to refactor the auth module')
  speechTimeline.onTranscript(4, Date.now() + 1)
  assert.equal(speechTimeline.awaitingContinuation(Date.now() + 2), true)
  say('shh')
  assert.equal(speechTimeline.awaitingContinuation(Date.now() + 2), true, 'shh handled: no commit')
  say('and the session store too')
  assert.equal(speechTimeline.awaitingContinuation(Date.now() + 2), false, 'a model turn commits')
  speechTimeline.reset()
}
// a dropped side remark: after reset the next reply is not held
{
  const t = new SpeechTimeline()
  t.onTurnCommit(0); t.onTranscript(4, 1000)
  assert.equal(t.shouldHold(1500, true), true)
  t.reset()
  assert.equal(t.shouldHold(1500, true), false, 'no hold after a drop reset')
}
// The toggle's note never steers a live turn
assert.equal(steersTurn(getNoiseCancelNote(true)), false); assert.equal(steersTurn(getNoiseCancelNote(false)), false)
// takeVoiceCommand and setNoiseGate are closures inside main() (not exported): their wiring is checked on the source text
{
  const { readFileSync } = await import('node:fs')
  const ix = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.ok(/inPhoneRoom\(\) \|\| !isShhCue/.test(ix), 'shh not handled in a phone room')
  assert.ok(/noiseGate\.on\('drop'[\s\S]{0,400}?speechTimeline\.reset\(\)[\s\S]{0,200}?replayTimer\.arm\(\)/.test(ix), 'a gate drop resets the timeline before the replay')
  assert.ok(/setNoiseGate\(true, \{ quiet: true \}\)\s*\n\s*return noiseGate\.enabled/.test(ix), 'shh is forwarded when the gate cannot turn on')
  assert.equal((ix.match(/noiseGate\.setEnabled\([^)]*'ui'\)/g) || []).length, 1, 'the UI toggle and shh share setNoiseGate')
}
console.log('speech-timeline: ok')
process.exit(0)

// #687: a long turn that stops mid-sentence is flagged; complete or short ones are not
{
  const { truncatedInput } = await import('../src/speech-timeline.js')
  const long = 'so I want to change how the session list works and also the way the filters apply when we switch projects and then'
  assert.ok(truncatedInput(long.repeat(1)), 'long dangling')
  assert.match(truncatedInput(long)!.lastWords, /projects and then$/)
  assert.equal(truncatedInput('Can you check the tests?'), null)
  assert.equal(truncatedInput('I want to change how the session list works and also the way the filters apply when we switch projects, then rerun everything.'), null)
  assert.equal(truncatedInput('one two three four five six seven eight nine ten eleven twelve thirteen'), null)
  assert.ok(truncatedInput('one two three four five six seven eight nine ten eleven twelve thirteen', true), 'overlap')
  assert.ok(truncatedInput(long + ' the.'), 'dangling with period')
}
