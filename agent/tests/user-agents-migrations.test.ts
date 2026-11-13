// The user_agents SQL checks repeat agent-store.ts rules (the database's own
// guard); this keeps them equal. Run with `npx tsx agent/tests/user-agents-migrations.test.ts`.
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROLE_NAMES, AGENT_LIMITS, AGENT_MODELS } from '../src/agent-store.js'
import { agentDraft, type CatalogEntry } from '../src/store-catalog.js'
import { NAMED_AGENTS } from '../src/claude-llm.js'

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'frontend', 'supabase', 'migrations')
const sql = (f: string) => readFileSync(join(dir, f), 'utf-8').replace(/--.*$/gm, '')  // comments hold stray quotes
const quoted = (s: string) => [...s.matchAll(/'([^']*)'/g)].map((m) => m[1])
const core = Object.keys(NAMED_AGENTS).sort()

const m004 = sql('004_user_agents.sql'), m015 = sql('015_user_agents_forks.sql'), m016 = sql('016_user_agents_role.sql'), m017 = sql('017_user_agents_role_required.sql')

// Models and limits.
assert.deepEqual(quoted(/model in \(([^)]*)\)/.exec(m004)![1]).sort(), [...AGENT_MODELS].sort())
assert.ok(m004.includes(`name ~ '^[a-z0-9-]{1,${AGENT_LIMITS.name}}$'`))
assert.ok(m004.includes(`between 1 and ${AGENT_LIMITS.description}`))
assert.ok(m015.includes(`between 1 and ${AGENT_LIMITS.prompt}`))

// Core agent names (015 renames rows that used one; 017 gives forks their parent's role).
const nameLists = [...(m015 + m017).matchAll(/name in \(([^)]*)\)|forked_from in \(([^)]*)\)/g)].map((m) => quoted(m[1] ?? m[2]).sort())
assert.equal(nameLists.length, 3)
for (const l of nameLists) assert.deepEqual(l, core)

// Roles, and the forked_from check accepts what a catalog install saves (store-catalog.ts agentDraft).
assert.deepEqual(quoted(/role in \(([^)]*)\)/.exec(m016)![1]), [...ROLE_NAMES])
const origin = new RegExp(quoted(m016).find((q) => q.includes('@'))!)
const entry = { id: 'x', source: 'wshobson-agents', kind: 'agent', name: 'Frontend Dev', description: 'd', tools: [], files: ['frontend-dev.md'], repo: 'wshobson/agents', path: 'plugins/web/agents/frontend-dev.md', sha: 'a'.repeat(40), license: 'MIT', scripts: [], trust: 'community' } as CatalogEntry
assert.match(agentDraft(entry, 'prompt').forked_from, origin)
assert.doesNotMatch('wshobson-agents:wshobson/agents/plugins/web/agents/frontend-dev.md', origin, 'an unpinned origin is refused')
assert.match(m017, /set default 'reader'/)

console.log('user-agents-migrations: all assertions passed')
