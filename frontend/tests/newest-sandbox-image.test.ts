// Run: npx tsx tests/newest-sandbox-image.test.ts
// New machines must be created from the newest version-tagged sandbox image,
// never from a `:latest` tag that the manual release path leaves stale.
import assert from 'node:assert'
import { pickNewestVersionTag } from '../src/lib/machines'

// The real tag list from 2026-11-12, when `:latest` was still 0.9.272.
const real = ['0.9.252', '0.9.269', '0.9.270', '0.9.271', '0.9.272', '0.9.275', '0.9.276', '0.9.277', 'latest', 'legacy-app-0.9.268']
assert.strictEqual(pickNewestVersionTag(real), '0.9.277')

// Numeric, not lexicographic: 0.9.100 > 0.9.99, 0.10.0 > 0.9.277, 1.0.0 > 0.99.99.
assert.strictEqual(pickNewestVersionTag(['0.9.99', '0.9.100']), '0.9.100')
assert.strictEqual(pickNewestVersionTag(['0.9.277', '0.10.0']), '0.10.0')
assert.strictEqual(pickNewestVersionTag(['0.99.99', '1.0.0']), '1.0.0')

// Only plain x.y.z counts: no latest, prefixes, pre-releases, digests or junk.
assert.strictEqual(pickNewestVersionTag(['latest', 'legacy-app-9.9.9', '9.9.9-rc1', 'v9.9.9', '9.9', 'sha256:abc', '', '0.0.1']), '0.0.1')
assert.strictEqual(pickNewestVersionTag(['latest', 'main']), null)
assert.strictEqual(pickNewestVersionTag([]), null)
assert.strictEqual(pickNewestVersionTag([null, 42, undefined, { tag: '9.9.9' }, ' 0.9.3 ']), '0.9.3')

console.log('newest-sandbox-image: all assertions passed')
