// OSBORN_AEC_WARMUP_MS parsing: unset or invalid leaves the SDK default (undefined).
// Run: npx tsx agent/tests/aec-warmup-env.test.ts
import assert from 'node:assert/strict'
import { parseAecWarmupMs } from '../src/env-keys.js'

const MAX = 60_000  // the documented ceiling (CLAUDE.md: 0 to 60000)

let passed = 0
const t = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ok  ${name}`) }

t('unset, empty and blank leave the default', () => {
  assert.equal(parseAecWarmupMs(undefined), undefined)
  assert.equal(parseAecWarmupMs(''), undefined)
  assert.equal(parseAecWarmupMs('   '), undefined)
})
t('valid integers are used', () => {
  assert.equal(parseAecWarmupMs('800'), 800)
  assert.equal(parseAecWarmupMs(' 1500 '), 1500)
  assert.equal(parseAecWarmupMs(String(MAX)), MAX)
})
t('zero is a valid value, not "unset"', () => {
  assert.equal(parseAecWarmupMs('0'), 0)
})
t('negative, decimal and non-numeric are invalid', () => {
  for (const v of ['-1', '-500', '1.5', '1e3', 'abc', '12ms', '0x10', 'NaN', 'Infinity']) {
    assert.equal(parseAecWarmupMs(v), undefined, v)
  }
})
t('huge values are invalid', () => {
  assert.equal(parseAecWarmupMs(String(MAX + 1)), undefined)
  assert.equal(parseAecWarmupMs('99999999999999999999'), undefined)
  assert.equal(parseAecWarmupMs('9'.repeat(400)), undefined)  // Number() is Infinity
})
console.log(`${passed} passed`)
