// Run: npx tsx agent/tests/recall-check.test.ts
// #681: the recall regression check passes on the committed baseline (keyword mode, synthetic fixture).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const r = spawnSync('npx', ['tsx', join(import.meta.dirname, '../scripts/recall-check.ts')], {
  env: { ...process.env, OSBORN_EMBED: '0' }, encoding: 'utf-8' })
assert.equal(r.status, 0, r.stdout + r.stderr)
assert.match(r.stdout, /^keyword /m)
console.log('recall-check: ok')
