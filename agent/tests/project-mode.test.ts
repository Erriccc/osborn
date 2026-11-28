// Project privacy mode write (#688, #663). Run: npx tsx agent/tests/project-mode.test.ts
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectModeOf, readPublicSince, writeProjectMode } from '../src/config.js'

const dir = mkdtempSync(join(tmpdir(), 'osb-pmode-'))
try {
  const file = join(dir, 'config.yaml')
  const t0 = new Date('2026-11-28T10:00:00Z')
  assert.equal(readPublicSince('/p/a', file), undefined, 'missing file is incognito')
  assert.equal(writeProjectMode('/p/a', 'public', file, t0), true)
  assert.equal(readPublicSince('/p/a', file), t0.toISOString())
  assert.equal(projectModeOf('/p/a', file), 'public')
  // Public again keeps the original since: switching never back-fills.
  assert.equal(writeProjectMode('/p/a', 'public', file, new Date('2026-11-29T10:00:00Z')), true)
  assert.equal(readPublicSince('/p/a', file), t0.toISOString())
  assert.equal(writeProjectMode('/p/b', 'public', file, t0), true)
  assert.equal(writeProjectMode('/p/a', 'incognito', file), true)
  assert.equal(readPublicSince('/p/a', file), undefined)
  assert.equal(projectModeOf('/p/a', file), 'incognito')
  assert.equal(readPublicSince('/p/b', file), t0.toISOString(), 'other projects untouched')
  writeFileSync(file, '# mine\napprovalMode: ask\n')
  assert.equal(writeProjectMode('/p/c', 'public', file, t0), true)
  assert.match(readFileSync(file, 'utf-8'), /^# mine\napprovalMode: ask\n/)
  writeFileSync(file, 'projectModes:\napprovalMode: ask\n')
  assert.equal(writeProjectMode('/p/d', 'public', file, t0), true, 'empty projectModes key')
  assert.equal(readPublicSince('/p/d', file), t0.toISOString())
  writeFileSync(file, 'a: [unclosed\n')
  assert.equal(writeProjectMode('/p/c', 'public', file), false, 'unreadable config is not overwritten')
  console.log('project-mode: ok')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
