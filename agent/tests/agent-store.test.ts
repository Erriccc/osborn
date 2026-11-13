// Agent & skill store rules: run with `npx tsx agent/tests/agent-store.test.ts`.
import assert from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseUserAgents, mergeAgents, describeAgents, forkSkill, removeUserSkill, skillForkedFrom, coreSkillNames } from '../src/agent-store.js'

const core = {
  writer: { description: 'core writer', prompt: 'WRITER PROMPT', model: 'opus', tools: ['Edit'] },
  steward: { description: 'core steward', prompt: 'STEWARD PROMPT', model: 'sonnet', tools: ['Read'] },
}

// Core agents cannot be overridden or removed (tombstoned).
const rows = [
  { name: 'writer', description: 'evil', prompt: 'override', model: 'haiku', enabled: true },
  { name: 'steward', description: '(removed built-in)', prompt: '-', enabled: false },
  { name: 'my-writer', description: 'my fork', prompt: 'forked prompt', model: 'sonnet', tools: ['Edit'], enabled: true, forked_from: 'writer' },
  { name: 'helper', description: 'custom', prompt: 'helper prompt', enabled: true },
  { name: 'off', description: 'disabled', prompt: 'p', enabled: false },
]
const parsed = parseUserAgents(rows, core)
assert.deepEqual(parsed.ignored, ['writer'])
assert.deepEqual(Object.keys(parsed.agents).sort(), ['helper', 'my-writer'])
assert.deepEqual(parsed.forkedFrom, { 'my-writer': 'writer' })
assert.equal((parsed.agents['my-writer'] as any).forkedFrom, undefined, 'fork origin stays out of the SDK definition')

const merged = mergeAgents<any>(core, parsed.agents)
assert.equal(merged.writer.prompt, 'WRITER PROMPT')
assert.ok(merged.steward, 'a tombstone row does not remove a core agent')
assert.equal(merged['my-writer'].prompt, 'forked prompt')
assert.equal(merged.helper.prompt, 'helper prompt')
assert.ok(!('off' in merged))

// Even if a core name slips past parsing, the merge keeps the core definition.
assert.equal(mergeAgents<any>(core, { writer: { description: 'x', prompt: 'y' } }).writer.prompt, 'WRITER PROMPT')

const listing = describeAgents(core, parsed.agents, parsed.forkedFrom)
const byName = Object.fromEntries(listing.map((a) => [a.name, a]))
assert.equal(byName.writer.core, true)
assert.equal(byName.writer.prompt, 'WRITER PROMPT')
assert.equal(byName['my-writer'].core, false)
assert.equal(byName['my-writer'].forkedFrom, 'writer')
assert.equal(byName['my-writer'].prompt, undefined)
assert.deepEqual(listing.slice(0, 2).map((a) => a.name), ['writer', 'steward'])

// Skills: shipped ones are locked, forks are user-owned copies.
const root = mkdtempSync(join(tmpdir(), 'agent-store-'))
try {
  const pkg = join(root, 'pkg'), home = join(root, 'home')
  mkdirSync(join(pkg, 'meetings'), { recursive: true })
  writeFileSync(join(pkg, 'meetings', 'SKILL.md'), '---\nname: meetings\ndescription: d\n---\n# Meetings\n')
  mkdirSync(join(home, 'meetings'), { recursive: true })
  writeFileSync(join(home, 'meetings', 'SKILL.md'), '---\nname: meetings\ndescription: d\n---\n# Meetings\n')
  mkdirSync(join(home, 'mine'), { recursive: true })
  writeFileSync(join(home, 'mine', 'SKILL.md'), '# Mine\n')
  assert.deepEqual([...coreSkillNames(pkg)], ['meetings'])

  assert.ok('error' in removeUserSkill(home, pkg, 'meetings'))
  assert.ok(existsSync(join(home, 'meetings', 'SKILL.md')))
  assert.ok('error' in forkSkill(home, pkg, 'mine', 'mine-2'), 'only core skills fork')
  assert.ok('error' in forkSkill(home, pkg, 'meetings', 'meetings'))
  assert.ok('error' in forkSkill(home, pkg, 'meetings', 'mine'), 'fork never overwrites')
  assert.ok('ok' in forkSkill(home, pkg, 'meetings', 'My Meetings'))
  assert.match(readFileSync(join(home, 'my-meetings', 'SKILL.md'), 'utf-8'), /^name: my-meetings$/m)
  assert.equal(skillForkedFrom(home, 'my-meetings'), 'meetings')
  assert.ok('ok' in removeUserSkill(home, pkg, 'my-meetings'))
  assert.ok(!existsSync(join(home, 'my-meetings')))
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('agent-store: all assertions passed')
