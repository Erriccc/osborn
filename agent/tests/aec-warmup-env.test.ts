// OSBORN_AEC_WARMUP_MS parsing: unset or invalid leaves the SDK default (undefined).
// Run: npx tsx agent/tests/aec-warmup-env.test.ts
import assert from 'node:assert/strict'
import { parseAecWarmupMs, AEC_WARMUP_MAX_MS } from '../src/env-keys.js'

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
  assert.equal(parseAecWarmupMs(String(AEC_WARMUP_MAX_MS)), AEC_WARMUP_MAX_MS)
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
  assert.equal(parseAecWarmupMs(String(AEC_WARMUP_MAX_MS + 1)), undefined)
  assert.equal(parseAecWarmupMs('99999999999999999999'), undefined)
})
console.log(`${passed} passed`)
