// Agent roles: inference, inheritance, and the role-keyed write gate.
// Run with `npx tsx agent/tests/agent-roles.test.ts`.
import assert from 'node:assert'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ROLES, ROLE_NAMES, CORE_AGENT_ROLES, inferRole, resolveRole, roleOf, roleBehaviours, roleChains, parseUserAgents, describeAgents } from '../src/agent-store.js'
import { NAMED_AGENTS, decideWrite } from '../src/claude-llm.js'

// Every core agent holds the role of its own name, and every role but 'reader' belongs to one.
assert.deepEqual(Object.keys(NAMED_AGENTS).sort(), Object.keys(CORE_AGENT_ROLES).sort())
for (const [n, r] of Object.entries(CORE_AGENT_ROLES)) assert.equal(n, r)
assert.deepEqual(ROLE_NAMES.filter((r) => r !== 'reader').sort(), Object.values(CORE_AGENT_ROLES).sort())

// Inference from tools.
assert.equal(inferRole(['Read', 'Edit']), 'writer')
assert.equal(inferRole(['MultiEdit']), 'writer')
assert.equal(inferRole(['Write']), 'writer')
assert.equal(inferRole(['Read', 'Grep', 'Bash']), 'reader')
assert.equal(inferRole([]), 'reader', 'no tools listed stays workspace-only')
assert.equal(inferRole(undefined), 'reader')

// Explicit > inherited > inferred; junk roles ignored.
assert.equal(resolveRole({ role: 'tester', forkedFrom: 'writer', tools: ['Edit'] }), 'tester')
assert.equal(resolveRole({ forkedFrom: 'steward', tools: ['Read'] }), 'steward')
assert.equal(resolveRole({ role: 'admin', forkedFrom: 'reviewer' }), 'reviewer')
assert.equal(resolveRole({ forkedFrom: 'src:o/r@abcdef1/x.md', tools: ['Edit'] }), 'writer')

const parsed = parseUserAgents([
  { name: 'my-steward', description: 'd', prompt: 'p', forked_from: 'steward', tools: ['Read'] },
  { name: 'my-writer', description: 'd', prompt: 'p', forked_from: 'writer' },
  { name: 'docs-bot', description: 'd', prompt: 'p', tools: ['Read', 'Write'], role: 'reviewer' },
  { name: 'helper', description: 'd', prompt: 'p', tools: ['Read'] },
  { name: 'editor', description: 'd', prompt: 'p', tools: ['Edit'] },
  { name: 'writer', description: 'd', prompt: 'override' },
], NAMED_AGENTS)
assert.deepEqual(parsed.roles, { 'my-steward': 'steward', 'my-writer': 'writer', 'docs-bot': 'reviewer', helper: 'reader', editor: 'writer' })

// roleOf: core agents keep their own role even with no map; the main agent has none.
assert.equal(roleOf('writer'), 'writer')
assert.equal(roleOf('writer', { writer: 'reader' } as any), 'reader', 'map wins (never populated for core names: parseUserAgents ignores them)')
assert.equal(roleOf('my-steward', parsed.roles), 'steward')
assert.equal(roleOf('constructor'), null, 'prototype keys are not agents')
assert.equal(roleOf('constructor', { constructor: 'writer' } as any), 'writer', 'an own user role still resolves')
assert.equal(roleOf('stranger', parsed.roles), null)
assert.equal(roleOf(null, parsed.roles), null)

// Write gate by role — the same results the old name-keyed rules gave for core agents.
const outside = '/etc/somewhere/file.ts'
const ws = join(homedir(), '.claude', 'projects', 'x', 'osb', '00000000-0000-0000-0000-000000000000', 'notes.md')
assert.equal(decideWrite(roleOf('writer'), outside).decision, 'defer')
assert.equal(decideWrite(roleOf('steward'), outside).decision, 'defer')
assert.equal(decideWrite(roleOf('researcher'), outside).decision, 'deny')
assert.equal(decideWrite(roleOf('planner'), outside).decision, 'deny')
assert.equal(decideWrite(null, outside).decision, 'deny', 'main orchestrator: workspace only')
assert.equal(decideWrite(null, ws).decision, 'allow')
assert.equal(decideWrite(roleOf('tester'), '/repo/src/a.test.ts').decision, 'defer')
assert.equal(decideWrite(roleOf('tester'), '/repo/src/a.ts').decision, 'deny')
assert.equal(decideWrite(roleOf('reviewer'), '/repo/README.md').decision, 'defer')
assert.equal(decideWrite(roleOf('reviewer'), '/repo/src/a.ts').decision, 'deny')
// Forks carry their role's rule.
assert.equal(decideWrite(roleOf('my-writer', parsed.roles), outside).decision, 'defer')
assert.equal(decideWrite(roleOf('helper', parsed.roles), outside).decision, 'deny')
assert.equal(decideWrite(roleOf('docs-bot', parsed.roles), '/repo/src/a.ts').decision, 'deny')

// Behaviours and chains.
assert.ok(ROLES.writer.skillInstall && ROLES.writer.historyFirst && !ROLES.steward.skillInstall)
assert.ok(ROLES.steward.verdict && ROLES.steward.signsOff)
assert.ok(ROLES.writer.chain!.afterReminder.includes('`steward`'))
assert.deepEqual(ROLES.writer.chain!.parallelAtStart, ['tester'])
assert.ok(!ROLES.reviewer.chain && !ROLES.tester.chain && !ROLES.steward.chain, 'verifiers never re-chain')
assert.deepEqual(roleChains(), [['researcher', 'reasoner'], ['planner', 'steward', 'writer'], ['writer', 'tester', 'steward', 'reviewer']])
assert.ok(roleBehaviours('steward').some((b) => /verdict/.test(b)))
assert.ok(roleBehaviours('reader').length === 1)

const listing = Object.fromEntries(describeAgents(NAMED_AGENTS, parsed.agents, parsed.forkedFrom, false, parsed.roles).map((a) => [a.name, a]))
assert.equal(listing.writer.role, 'writer')
assert.equal(listing['my-steward'].role, 'steward')
assert.ok(listing['my-steward'].behaviours.includes('Its verdict shows as a card in chat'))
assert.equal(listing.helper.role, 'reader')

console.log('agent-roles: all assertions passed')
// A user or catalog writer never gets silent skill installs (built-in agents only).
{
  const { roleBehaviours } = await import('../src/agent-store.js')
  if (!roleBehaviours('writer', true).some((b) => /skills without asking/.test(b))) throw new Error('core writer lost skill install')
  if (roleBehaviours('writer', false).some((b) => /skills without asking/.test(b))) throw new Error('non-core writer must not auto-install skills')
  console.log('agent-roles: skill install is built-in only')
}
