// Background slot cap: default 2, OSBORN_MAX_BG_SLOTS overrides, the 3rd spawn is refused with the same
// error as before, and the same id cannot become two slots.
// Run: npx tsx agent/tests/slot-cap.test.ts
import assert from 'node:assert/strict'
import { DEFAULT_MAX_BG_SLOTS, MAX_BG_SLOTS_CEILING, SlotRegistry, capError, maxBgSlots, type SessionSlot } from '../src/slot-manager.js'

let pass = 0
const t = (name: string, fn: () => unknown) => {
  try { fn(); pass++; console.log('ok   ', name) } catch (e: any) { console.log('FAIL ', name, '\n     ', e.message.split('\n')[0]); process.exitCode = 1 }
}

const mk = (id: string): SessionSlot => ({ id, llm: {}, isFocused: false, workingDir: '/w' })
const spawn = (r: SlotRegistry, id: string) => {
  const seat = r.admit(id)
  if (seat.ok) r.add(mk(id))
  return seat
}

t('the cap is 2 by default; OSBORN_MAX_BG_SLOTS overrides it; junk falls back to 2', () => {
  assert.equal(DEFAULT_MAX_BG_SLOTS, 2)
  assert.equal(maxBgSlots({}), 2)
  assert.equal(maxBgSlots({ OSBORN_MAX_BG_SLOTS: '5' }), 5)
  assert.equal(maxBgSlots({ OSBORN_MAX_BG_SLOTS: '0' }), 0)
  assert.equal(maxBgSlots({ OSBORN_MAX_BG_SLOTS: 'lots' }), 2)
  assert.equal(maxBgSlots({ OSBORN_MAX_BG_SLOTS: '-1' }), 2)
  assert.equal(maxBgSlots({ OSBORN_MAX_BG_SLOTS: '999' }), 8, 'clamped to MAX_BG_SLOTS_CEILING')
  assert.equal(maxBgSlots({ OSBORN_MAX_BG_SLOTS: '8' }), MAX_BG_SLOTS_CEILING)
  assert.equal(new SlotRegistry({ max: () => maxBgSlots({ OSBORN_MAX_BG_SLOTS: '4' }) }).max, 4)
})

t('the 3rd spawn is refused with the same error text as before', () => {
  const r = new SlotRegistry({ max: 2 })
  assert.equal(spawn(r, 'aaaaaaaa-1').ok, true)
  assert.equal(spawn(r, 'bbbbbbbb-2').ok, true)
  const third = spawn(r, 'cccccccc-3')
  assert.equal(third.ok, false)
  assert.equal(third.reason, 'cap')
  assert.equal(third.error, 'Background session cap reached (2/2 slots in use). Kill an existing background slot before spawning a new one.')
  assert.equal(third.error, capError(2, 2))
  assert.equal(r.size, 2)
})

t('removing a slot frees its seat', () => {
  const r = new SlotRegistry({ max: 1 })
  spawn(r, 'aaaaaaaa-1')
  assert.equal(spawn(r, 'bbbbbbbb-2').ok, false)
  r.remove('aaaaaaaa-1')
  assert.equal(spawn(r, 'bbbbbbbb-2').ok, true)
})

t('the same id cannot become a second slot (same error text as the old handler)', () => {
  const r = new SlotRegistry({ max: 5 })
  assert.equal(spawn(r, 'aaaaaaaa-1').ok, true)
  const again = r.admit('aaaaaaaa-1')
  assert.equal(again.ok, false)
  assert.equal(again.reason, 'duplicate')
  assert.equal(again.error, 'Session aaaaaaaa is already running as a background slot')
})

console.log(`\n${pass} passed${process.exitCode ? ', some FAILED' : ''}`)
