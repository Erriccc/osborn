// Meeting multi-agent addressing + mute scaffolding.
// Pure parsers + mute registry + the flag-gated singleton pass-through.
// Run: npx tsx agent/tests/meeting-addressing.test.ts
import assert from 'node:assert/strict'

// Ensure the flag is OFF before the module's singleton is constructed/used so
// the pass-through assertions are unambiguous; individual tests flip it locally.
delete process.env.OSBORN_MEETING_ADDRESSING

const {
  buildRoster,
  resolveAgent,
  parseAddressing,
  parseMuteCommand,
  MuteRegistry,
  meetingAddressing,
  DEFAULT_AGENT_NAMES,
  isRoutableTarget,
  ORCHESTRATOR_ID,
} = await import('../src/meeting-addressing.js')

let pass = 0
const t = (name: string, fn: () => unknown) => {
  try { fn(); pass++; console.log('ok   ', name) } catch (e: any) { console.log('FAIL ', name, '\n     ', e.message.split('\n')[0]); process.exitCode = 1 }
}

const roster = buildRoster()

// ── buildRoster / resolveAgent ───────────────────────────────────────────────
t('default roster includes orchestrator + known workers', () => {
  const ids = roster.map(r => r.id)
  for (const n of DEFAULT_AGENT_NAMES) assert.ok(ids.includes(n), n)
})
t('buildRoster dedupes and lowercases', () => {
  const r = buildRoster(['Writer', 'writer', 'REVIEWER'])
  assert.deepEqual(r.map(x => x.id), ['writer', 'reviewer'])
})
t('resolveAgent matches id, is case-insensitive, strips @', () => {
  assert.equal(resolveAgent('researcher', roster), 'researcher')
  assert.equal(resolveAgent('@Researcher', roster), 'researcher')
  assert.equal(resolveAgent('  REASONER ', roster), 'reasoner')
})
t('resolveAgent returns null for unknown token', () => {
  assert.equal(resolveAgent('@bob', roster), null)
  assert.equal(resolveAgent('', roster), null)
})
t('extra aliases resolve to their id', () => {
  const r = buildRoster(['researcher'], { researcher: ['scout', 'rsrch'] })
  assert.equal(resolveAgent('scout', r), 'researcher')
  assert.equal(resolveAgent('@rsrch', r), 'researcher')
})

// ── parseAddressing ──────────────────────────────────────────────────────────
t('no addressing → verbatim pass-through', () => {
  const s = 'can we move the deadline to Friday'
  const r = parseAddressing(s, roster)
  assert.equal(r.target, null)
  assert.equal(r.cleanedText, s)
})
t('@mention resolves and is stripped, rest verbatim', () => {
  const r = parseAddressing('@researcher dig into the pricing page', roster)
  assert.equal(r.target, 'researcher')
  assert.equal(r.cleanedText, 'dig into the pricing page')
  assert.equal(r.token, '@researcher')
})
t('@mention mid-sentence resolves and collapses whitespace', () => {
  const r = parseAddressing('hey @writer can you draft that', roster)
  assert.equal(r.target, 'writer')
  assert.equal(r.cleanedText, 'hey can you draft that')
})
t('unknown @handle is left untouched (no false routing)', () => {
  const s = 'ping @bob about the invoice'
  const r = parseAddressing(s, roster)
  assert.equal(r.target, null)
  assert.equal(r.cleanedText, s)
})
t('leading "<alias>," address resolves only for known agents', () => {
  const r = parseAddressing('reasoner, weigh the two migration options', roster)
  assert.equal(r.target, 'reasoner')
  assert.equal(r.cleanedText, 'weigh the two migration options')
})
t('leading "So," is NOT treated as addressing', () => {
  const s = 'So, let us start with the agenda'
  const r = parseAddressing(s, roster)
  assert.equal(r.target, null)
  assert.equal(r.cleanedText, s)
})
t('empty / whitespace input is safe', () => {
  assert.equal(parseAddressing('', roster).target, null)
  assert.equal(parseAddressing('   ', roster).cleanedText, '   ')
})

// ── parseMuteCommand ─────────────────────────────────────────────────────────
t('mute <name>', () => {
  assert.deepEqual(parseMuteCommand('mute Daniel'), { action: 'mute', who: 'daniel' })
})
t('unmute <name> with trailing please', () => {
  assert.deepEqual(parseMuteCommand('unmute Daniel please'), { action: 'unmute', who: 'daniel' })
})
t('mute everyone → wildcard', () => {
  assert.deepEqual(parseMuteCommand('mute everyone'), { action: 'mute', who: '*' })
  assert.deepEqual(parseMuteCommand('mute all'), { action: 'mute', who: '*' })
})
t('sentence merely containing "mute" does not trigger', () => {
  assert.deepEqual(parseMuteCommand('I could not hear you on mute earlier today'), { action: null, who: null })
  assert.deepEqual(parseMuteCommand('please mute'), { action: null, who: null })
})

// ── MuteRegistry ─────────────────────────────────────────────────────────────
t('mute/unmute/isMuted are case-insensitive', () => {
  const m = new MuteRegistry()
  assert.equal(m.isMuted('Sara'), false)
  m.mute('Sara')
  assert.equal(m.isMuted('sara'), true)
  m.unmute('SARA')
  assert.equal(m.isMuted('Sara'), false)
})
t('mute-all mutes everyone; clearing all restores', () => {
  const m = new MuteRegistry()
  m.mute('*')
  assert.equal(m.isMuted('anyone'), true)
  assert.deepEqual(m.list(), ['*'])
  m.unmute('*')
  assert.equal(m.isMuted('anyone'), false)
})
t('list is sorted and clear empties', () => {
  const m = new MuteRegistry()
  m.mute('Zed'); m.mute('Ada')
  assert.deepEqual(m.list(), ['ada', 'zed'])
  m.clear()
  assert.deepEqual(m.list(), [])
})

// ── singleton flag gate (the safety contract) ────────────────────────────────
t('disabled → pure pass-through: never drops, never routes, verbatim', () => {
  delete process.env.OSBORN_MEETING_ADDRESSING
  meetingAddressing.reset()
  const v = meetingAddressing.processUtterance('Daniel', '@researcher look at this')
  assert.equal(v.gated, false)
  assert.equal(v.drop, false)
  assert.equal(v.target, null)
  assert.equal(v.cleanedText, '@researcher look at this')
  assert.equal(meetingAddressing.enabled, false)
})
t('enabled → parses addressing and honours mute drop', () => {
  process.env.OSBORN_MEETING_ADDRESSING = 'on'
  meetingAddressing.reset()
  assert.equal(meetingAddressing.enabled, true)

  const v1 = meetingAddressing.processUtterance('Daniel', '@reasoner compare the options')
  assert.equal(v1.gated, true)
  assert.equal(v1.target, 'reasoner')
  assert.equal(v1.cleanedText, 'compare the options')
  assert.equal(v1.drop, false)

  // Mute a participant by voice command, then their next turn drops.
  const cmd = meetingAddressing.processUtterance('Host', 'mute Daniel')
  assert.deepEqual(cmd.muteChanged, { action: 'mute', who: 'daniel' })
  const v2 = meetingAddressing.processUtterance('Daniel', 'this should be filtered')
  assert.equal(v2.drop, true)

  // A muted speaker can still unmute themselves (command applied BEFORE drop).
  const v3 = meetingAddressing.processUtterance('Daniel', 'unmute me')
  assert.equal(v3.drop, false)
  assert.deepEqual(v3.muteChanged, { action: 'unmute', who: 'daniel' })

  delete process.env.OSBORN_MEETING_ADDRESSING
  meetingAddressing.reset()
})

// ── Phase C — routing-target resolution ──────────────────────────────────────
t('isRoutableTarget: a worker routes, the orchestrator does NOT', () => {
  assert.equal(isRoutableTarget('researcher'), true)
  assert.equal(isRoutableTarget('Reasoner'), true)
  assert.equal(isRoutableTarget(ORCHESTRATOR_ID), false) // 'osborn' = the orchestrator itself
  assert.equal(isRoutableTarget('osborn'), false)
})
t('isRoutableTarget: null / empty / whitespace are not routable (fail-safe)', () => {
  assert.equal(isRoutableTarget(null), false)
  assert.equal(isRoutableTarget(undefined), false)
  assert.equal(isRoutableTarget(''), false)
  assert.equal(isRoutableTarget('   '), false)
})
t('enabled processUtterance yields a routable target for @worker addressing', () => {
  process.env.OSBORN_MEETING_ADDRESSING = 'on'
  meetingAddressing.reset()
  const v = meetingAddressing.processUtterance('Daniel', '@researcher dig into pricing')
  assert.equal(v.target, 'researcher')
  assert.equal(isRoutableTarget(v.target), true) // flushMeetingBuffer would inject a Task directive
  assert.equal(v.cleanedText, 'dig into pricing')
  delete process.env.OSBORN_MEETING_ADDRESSING
  meetingAddressing.reset()
})
t('addressing the orchestrator by name is NOT routed to a worker', () => {
  process.env.OSBORN_MEETING_ADDRESSING = 'on'
  meetingAddressing.reset()
  const v = meetingAddressing.processUtterance('Daniel', 'osborn, summarize the call')
  assert.equal(v.target, 'osborn')
  assert.equal(isRoutableTarget(v.target), false) // orchestrator handles it directly, no Task dispatch
  delete process.env.OSBORN_MEETING_ADDRESSING
  meetingAddressing.reset()
})
t('an un-addressed turn produces no routing target', () => {
  process.env.OSBORN_MEETING_ADDRESSING = 'on'
  meetingAddressing.reset()
  const v = meetingAddressing.processUtterance('Daniel', 'can we push the deadline to Friday')
  assert.equal(v.target, null)
  assert.equal(isRoutableTarget(v.target), false)
  delete process.env.OSBORN_MEETING_ADDRESSING
  meetingAddressing.reset()
})

// ── Phase B — mute_participant control + state snapshot ───────────────────────
t('applyMuteControl mutes and unmutes a named participant', () => {
  meetingAddressing.reset()
  const a = meetingAddressing.applyMuteControl('mute', 'Daniel')
  assert.deepEqual(a, { action: 'mute', who: 'daniel' })
  assert.equal(meetingAddressing.mutes.isMuted('Daniel'), true)
  const b = meetingAddressing.applyMuteControl('unmute', 'DANIEL')
  assert.deepEqual(b, { action: 'unmute', who: 'daniel' })
  assert.equal(meetingAddressing.mutes.isMuted('Daniel'), false)
  meetingAddressing.reset()
})
t('applyMuteControl normalizes everyone/all → wildcard, rejects blanks', () => {
  meetingAddressing.reset()
  const a = meetingAddressing.applyMuteControl('mute', 'everyone')
  assert.deepEqual(a, { action: 'mute', who: '*' })
  assert.equal(meetingAddressing.mutes.isMuted('anyone'), true)
  assert.equal(meetingAddressing.applyMuteControl('mute', '   '), null) // no-op on blank
  meetingAddressing.reset()
})
t('a mute_participant control gates the muted speaker out (end-to-end via processUtterance)', () => {
  process.env.OSBORN_MEETING_ADDRESSING = 'on'
  meetingAddressing.reset()
  meetingAddressing.applyMuteControl('mute', 'Sara') // frontend mute button → MuteRegistry
  const v = meetingAddressing.processUtterance('Sara', 'this should be dropped')
  assert.equal(v.drop, true)
  meetingAddressing.applyMuteControl('unmute', 'Sara')
  const v2 = meetingAddressing.processUtterance('Sara', 'now this gets through')
  assert.equal(v2.drop, false)
  delete process.env.OSBORN_MEETING_ADDRESSING
  meetingAddressing.reset()
})
t('state() snapshot reflects enabled flag, roster ids, and muted list', () => {
  process.env.OSBORN_MEETING_ADDRESSING = 'on'
  meetingAddressing.setRoster(['osborn', 'researcher', 'writer'])
  meetingAddressing.reset() // clears mutes, keeps roster
  meetingAddressing.applyMuteControl('mute', 'Ada')
  const st = meetingAddressing.state()
  assert.equal(st.enabled, true)
  assert.deepEqual(st.roster, ['osborn', 'researcher', 'writer'])
  assert.deepEqual(st.muted, ['ada'])
  delete process.env.OSBORN_MEETING_ADDRESSING
  meetingAddressing.setRoster(DEFAULT_AGENT_NAMES)
  meetingAddressing.reset()
})

console.log(`\n${pass} passed`)
