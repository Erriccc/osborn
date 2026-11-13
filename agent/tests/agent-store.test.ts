// Agent & skill store rules: run with `npx tsx agent/tests/agent-store.test.ts`.
import assert from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseUserAgents, mergeAgents, describeAgents, forkSkill, removeUserSkill, addUserSkill, readUserSkill, skillForkedFrom, coreSkillNames, parseFrontMatter } from '../src/agent-store.js'

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
assert.deepEqual(parsed.dropped, [{ name: 'writer', reason: 'is a core agent (fork it under a new name)' }])
assert.deepEqual(Object.keys(parsed.agents).sort(), ['helper', 'my-writer'])
assert.deepEqual(parsed.forkedFrom, { 'my-writer': 'writer' })
assert.equal((parsed.agents['my-writer'] as any).forkedFrom, undefined, 'fork origin stays out of the SDK definition')

const merged = mergeAgents<any>(core, parsed.agents)
assert.equal(merged.writer.prompt, 'WRITER PROMPT')
assert.ok(merged.steward, 'a tombstone row does not remove a core agent')
assert.equal(merged['my-writer'].prompt, 'forked prompt')
assert.equal(merged.helper.prompt, 'helper prompt')
assert.ok(!('off' in merged))

// Every dropped row is reported with its reason.
const bad = parseUserAgents([
  { name: '', description: 'd', prompt: 'p' },
  { name: 'x'.repeat(41), description: 'd', prompt: 'p' },
  { name: 'nodesc', prompt: 'p' },
  { name: 'longdesc', description: 'd'.repeat(501), prompt: 'p' },
  { name: 'noprompt', description: 'd' },
  { name: 'longprompt', description: 'd', prompt: 'p'.repeat(20001) },
], core).dropped
assert.deepEqual(bad.map((d) => d.reason), ['no name', 'name longer than 40', 'no description', 'description longer than 500', 'no prompt', 'prompt longer than 20000'])

// Even if a core name slips past parsing, the merge keeps the core definition.
assert.equal(mergeAgents<any>(core, { writer: { description: 'x', prompt: 'y' } }).writer.prompt, 'WRITER PROMPT')

assert.equal(describeAgents(core, parsed.agents, parsed.forkedFrom)[0].prompt, undefined, 'no prompts on the data channel')
const listing = describeAgents(core, parsed.agents, parsed.forkedFrom, true)
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
  assert.equal(parseFrontMatter(readFileSync(join(home, 'my-meetings', 'SKILL.md'), 'utf-8')).meta.name, 'my-meetings')
  assert.equal(skillForkedFrom(home, 'my-meetings'), 'meetings')
  assert.ok('ok' in removeUserSkill(home, pkg, 'my-meetings'))
  assert.ok(!existsSync(join(home, 'my-meetings')))

  // Adding: an installed built-in is never overwritten; a missing one takes the content sent (the served copy).
  assert.ok('error' in addUserSkill(home, pkg, 'meetings', 'new'))
  rmSync(join(home, 'meetings'), { recursive: true })
  assert.ok('ok' in addUserSkill(home, pkg, 'meetings', '# Served copy v9'))
  assert.equal(readFileSync(join(home, 'meetings', 'SKILL.md'), 'utf-8'), '# Served copy v9')
  assert.ok('error' in addUserSkill(home, pkg, 'x', '  '))
  assert.ok('ok' in addUserSkill(home, pkg, 'Mine', '# Mine v2'), 'a user skill can be replaced')
  assert.deepEqual(readUserSkill(home, 'mine'), { name: 'mine', content: '# Mine v2' })
  assert.ok('error' in readUserSkill(home, 'nope'))
} finally {
  rmSync(root, { recursive: true, force: true })
}

// Front matter: YAML, with a line-based fallback for what YAML rejects.
assert.deepEqual(parseFrontMatter('---\ntools: ["Read", Grep]\n---\n').meta.tools, ['Read', 'Grep'])
assert.equal(parseFrontMatter('---\ndescription: Use it: when asked\nname: x\n---\nbody').meta.description, 'Use it: when asked')
assert.equal(parseFrontMatter('no front matter').body, 'no front matter')

console.log('agent-store: all assertions passed')
