// Agent roles: drafts, inheritance, and the role-keyed write gate.
// Run with `npx tsx agent/tests/agent-roles.test.ts`.
import assert from 'node:assert'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ROLES, ROLE_NAMES, EDIT_TOOLS, draftRole, coreRole, roleOf, installsSkillsSilently, parseUserAgents, describeAgents, describeRoles } from '../src/agent-store.js'
import { NAMED_AGENTS, decideWrite } from '../src/claude-llm.js'
import { getChainReminder } from '../src/prompts.js'

// Every core agent holds the role of its own name, and every role but 'reader' belongs to one.
for (const n of Object.keys(NAMED_AGENTS)) assert.equal(coreRole(n, NAMED_AGENTS), n)
assert.deepEqual(ROLE_NAMES.filter((r) => r !== 'reader').sort(), Object.keys(NAMED_AGENTS).sort())
assert.equal(coreRole('constructor', NAMED_AGENTS), null, 'prototype keys are not agents')

// Drafts start from their tools; saved rows never do.
assert.equal(draftRole(['Read', 'Edit']), 'writer')
assert.equal(draftRole(['NotebookEdit']), 'writer')
assert.equal(draftRole(['Read', 'Grep', 'Bash']), 'reader')
assert.equal(draftRole([]), 'reader', 'no tools listed stays workspace-only')
assert.equal(draftRole(undefined), 'reader')
assert.ok(EDIT_TOOLS.has('NotebookEdit'))

const parsed = parseUserAgents([
  { name: 'my-steward', description: 'd', prompt: 'p', forked_from: 'steward', tools: ['Read'] },
  { name: 'my-writer', description: 'd', prompt: 'p', forked_from: 'writer' },
  { name: 'my-researcher', description: 'd', prompt: 'p', forked_from: 'researcher', role: 'researcher' },
  { name: 'docs-bot', description: 'd', prompt: 'p', tools: ['Read', 'Write'], role: 'reviewer' },
  { name: 'helper', description: 'd', prompt: 'p', tools: ['Read'] },
  { name: 'editor', description: 'd', prompt: 'p', tools: ['Edit'] },
  { name: 'odd', description: 'd', prompt: 'p', role: 'admin', forked_from: 'reviewer' },
  { name: 'constructor', description: 'd', prompt: 'p' },
  { name: 'writer', description: 'd', prompt: 'override' },
], NAMED_AGENTS)
assert.deepEqual(parsed.roles, {
  'my-steward': 'steward', 'my-writer': 'writer', 'my-researcher': 'researcher', 'docs-bot': 'reviewer',
  helper: 'reader', editor: 'reader', odd: 'reviewer', constructor: 'reader',
}, 'set role > built-in parent > reader; an unset role is never inferred from tools')
assert.deepEqual(parsed.dropped.map((d) => d.name), ['writer'])
assert.ok(parsed.agents.constructor, 'a user agent named constructor is not mistaken for a core agent')
// Forks of grounded built-ins read the recall store too.
assert.equal(parsed.agents['my-writer'].grounded, (NAMED_AGENTS as any).writer.grounded || undefined)
assert.equal(parsed.agents['my-researcher'].grounded, true)
assert.equal(parsed.agents['my-steward'].grounded, undefined)

// roleOf: core agents keep their own role; the main agent has none.
assert.equal(roleOf('writer', {}, NAMED_AGENTS), 'writer')
assert.equal(roleOf('my-steward', parsed.roles, NAMED_AGENTS), 'steward')
assert.equal(roleOf('constructor', {}, NAMED_AGENTS), null)
assert.equal(roleOf('constructor', parsed.roles, NAMED_AGENTS), 'reader', 'an own user role still resolves')
assert.equal(roleOf('stranger', parsed.roles, NAMED_AGENTS), null)
assert.equal(roleOf(null, parsed.roles, NAMED_AGENTS), null)

// Write gate by role — the same results the old name-keyed rules gave for core agents.
const outside = '/etc/somewhere/file.ts'
const ws = join(homedir(), '.claude', 'projects', 'x', 'osb', '00000000-0000-0000-0000-000000000000', 'notes.md')
const r = (n: string) => roleOf(n, parsed.roles, NAMED_AGENTS)
assert.equal(decideWrite(r('writer'), outside).decision, 'defer')
assert.equal(decideWrite(r('steward'), outside).decision, 'defer')
assert.equal(decideWrite(r('researcher'), outside).decision, 'deny')
assert.equal(decideWrite(r('planner'), outside).decision, 'deny')
assert.equal(decideWrite(null, outside).decision, 'deny', 'main orchestrator: workspace only')
assert.equal(decideWrite(null, ws).decision, 'allow')
assert.equal(decideWrite(r('researcher'), '').decision, 'deny', 'an edit with no path is not a workspace write')
assert.equal(decideWrite(r('tester'), '/repo/src/a.test.ts').decision, 'defer')
assert.equal(decideWrite(r('tester'), '/repo/src/a.ts').decision, 'deny')
assert.equal(decideWrite(r('reviewer'), '/repo/README.md').decision, 'defer')
assert.equal(decideWrite(r('reviewer'), '/repo/src/a.ts').decision, 'deny')
// Forks carry their role's rule; a saved agent with edit tools and no role stays in the workspace.
assert.equal(decideWrite(r('my-writer'), outside).decision, 'defer')
assert.equal(decideWrite(r('helper'), outside).decision, 'deny')
assert.equal(decideWrite(r('editor'), outside).decision, 'deny')
assert.equal(decideWrite(r('docs-bot'), '/repo/src/a.ts').decision, 'deny')

// Silent skill installs: built-in agents of a skill-installing role only.
assert.ok(installsSkillsSilently('writer', true))
assert.ok(!installsSkillsSilently('writer', false), 'a user or catalog writer asks for each skill file')
assert.ok(!installsSkillsSilently('steward', true))

// Behaviours and chains.
assert.ok(ROLES.writer.historyFirst && ROLES.steward.verdict)
for (const role of ROLE_NAMES) assert.equal(!!getChainReminder(role), !!ROLES[role].chain, `${role}: a chain needs a prompt file and only a chain has one`)
const fork = getChainReminder('writer', 'my-writer')!
assert.ok(fork.includes('`my-writer`') && !fork.includes('{{agent}}') && fork.includes('`steward`'), 'the reminder names the agent that finished')
assert.ok(getChainReminder('writer')!.includes('`writer`'))
assert.ok(!ROLES.reviewer.chain && !ROLES.tester.chain && !ROLES.steward.chain, 'verifiers never re-chain')
const meta = describeRoles()
assert.deepEqual(meta.chains, [['researcher', 'reasoner'], ['planner', 'steward', 'writer'], ['writer', 'tester', 'steward', 'reviewer']])
assert.ok(meta.roles.find((x) => x.role === 'writer')!.behaviours.every((b) => !/skills without asking/.test(b)), 'the role picker describes user agents')
assert.ok(meta.models.includes('inherit') && meta.limits.prompt > 0)

const listing = Object.fromEntries(describeAgents(NAMED_AGENTS, parsed.agents, parsed.roles).map((a) => [a.name, a]))
assert.equal(listing.writer.role, 'writer')
assert.ok(listing.writer.behaviours.some((b) => /skills without asking/.test(b)), 'built-in writer')
assert.ok(!listing['my-writer'].behaviours.some((b) => /skills without asking/.test(b)), 'fork of the writer')
assert.equal(listing['my-steward'].role, 'steward')
assert.ok(listing['my-steward'].behaviours.includes('Its verdict shows as a card in chat'))
assert.equal(listing.helper.role, 'reader')
assert.equal(listing.writer.summary, ROLES.writer.summary)
assert.equal(listing.writer.icon, 'pen')

console.log('agent-roles: all assertions passed')
