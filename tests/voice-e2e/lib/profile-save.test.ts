import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { serialSaver, writeAtomic } from './profile-save'

const tick = () => new Promise((r) => setTimeout(r, 5))
let live = 0, maxLive = 0, runs = 0, stop = false
const s = serialSaver(async () => { live++; runs++; maxLive = Math.max(maxLive, live); await tick(); await tick(); live-- }, () => stop)

// interval tick in flight, then shutdown's save and two more: never two at once
s.tick()
const a = s.now(), b = s.now(), c = s.now()
assert.equal(b, c, 'calls while one is queued share it')
await Promise.all([a, b, c])
assert.equal(maxLive, 1, 'saves never overlap')
assert.equal(runs, 2, 'the in-flight save plus one queued save')
stop = true; s.tick(); await tick(); await tick(); await tick()
assert.equal(runs, 2, 'no interval save once shutdown has begun')
await s.now(); assert.equal(runs, 3, 'shutdown still saves explicitly')
const f = serialSaver(async () => { throw new Error('x') })
await f.now(); await f.now()  // a failed save never wedges the next one

const dir = mkdtempSync(join(tmpdir(), 'ps-'))
const file = join(dir, 'p.json')
writeAtomic(file, '{"a":1}'); writeAtomic(file, '{"a":2}')
assert.equal(readFileSync(file, 'utf8'), '{"a":2}')
assert.deepEqual(readdirSync(dir), ['p.json'], 'no temp file left behind')
assert.ok(existsSync(file))
console.log('profile-save: all assertions passed')
