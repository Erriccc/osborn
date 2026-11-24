import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

// drive.sh with a stub curl that prints its headers: which x-driver-id does each pass send?
const dir = mkdtempSync(join(tmpdir(), 'drive-'))
writeFileSync(join(dir, 'curl'), '#!/bin/sh\nfor a in "$@"; do echo "$a"; done\n'); chmodSync(join(dir, 'curl'), 0o755)
const driverFor = (env: Record<string, string>) => {
  const r = spawnSync('bash', [new URL('./drive.sh', import.meta.url).pathname, 'status'], { env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, BSR_ENGINE: 'http://localhost:1', BSR_TOKEN: 'x', OSBORN_ENGINE_TOKEN: 'x', ...env }, encoding: 'utf8' })
  return /x-driver-id: (\S+)/.exec(r.stdout)?.[1]
}
const a = driverFor({ BSR_PROFILE: 'pass-a' }), b = driverFor({ BSR_PROFILE: 'pass-b' })
assert.ok(a && b && a !== b, `distinct profiles must be distinct drivers, got ${a} / ${b}`)
assert.equal(driverFor({ BSR_PROFILE: 'pass-a', BSR_DRIVER: 'me' }), 'me')
console.log('drive-driver ok')
