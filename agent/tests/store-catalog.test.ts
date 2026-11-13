// Store catalog: normalisation from a fixture snapshot, install refusals, recommendations.
// Run with `npx tsx agent/tests/store-catalog.test.ts`. No network.
import assert from 'node:assert'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SOURCES, normaliseSource, installSkill, agentDraft, recommend, installedIds, safeRelPath, skillProvenance, PROVENANCE_FILE, type CatalogEntry } from '../src/store-catalog.js'
import { parseUserAgents, parseFrontMatter } from '../src/agent-store.js'

const fx = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'store-catalog.json'), 'utf-8'))
const read = async (p: string) => fx.files[p] ?? null
const src = SOURCES.find((s) => s.id === 'wshobson-agents')!

// Front matter: inline lists, block lists, folded scalars, quotes.
assert.deepEqual(parseFrontMatter('---\nname: "x"\ntools: [a]\n---\nbody').meta.name, 'x')
assert.deepEqual(parseFrontMatter('---\ntools: ["Read", Grep]\n---\n').meta.tools, ['Read', 'Grep'])
assert.deepEqual(parseFrontMatter('---\ntools:\n  - Read\n  - Grep\n---\n').meta.tools, ['Read', 'Grep'])
assert.equal(parseFrontMatter('---\ndescription: >\n  one\n  two\n---\n').meta.description, 'one two')
assert.equal(parseFrontMatter('no front matter').body, 'no front matter')

const run = async () => {
  const { entries, bodies, failed } = await normaliseSource(src, { sha: fx.sha, paths: fx.paths }, read)
  assert.equal(failed, 0)
  const flaky = await normaliseSource(src, { sha: fx.sha, paths: fx.paths }, (p: string) => (/frontend-dev/.test(p) ? Promise.reject(new Error('429')) : read(p)))
  assert.ok(flaky.failed > 0 && !flaky.entries.some((e) => e.name === 'frontend-dev'), 'a failed read is counted, so a partial catalog is not cached as good')
  const by = Object.fromEntries(entries.map((e) => [e.name, e]))
  assert.deepEqual(Object.keys(by).sort(), ['frontend-dev', 'pg-migrations', 'react-testing', 'sql-reviewer'], 'MCP entries and external_plugins are skipped')

  const fe = by['frontend-dev']
  assert.equal(fe.kind, 'agent')
  assert.deepEqual(fe.tools, ['Read', 'Edit', 'Write', 'Bash'])
  assert.equal(fe.model, 'sonnet')
  assert.equal(fe.sha, fx.sha)
  assert.equal(fe.repo, 'wshobson/agents')
  assert.equal(fe.license, 'MIT', 'repo license detected')
  assert.equal(fe.plugin, 'web')
  assert.equal(fe.category, 'frontend', 'marketplace category attached')
  assert.equal(fe.trust, 'community')
  assert.deepEqual(fe.scripts, [])
  assert.equal(bodies[fe.id], 'You are a frontend developer.', 'agent body is the prompt without front matter')

  const rt = by['react-testing']
  assert.equal(rt.kind, 'skill')
  assert.equal(rt.path, 'plugins/web/skills/react-testing')
  assert.deepEqual(rt.files.sort(), ['SKILL.md', 'references/guide.md', 'scripts/run.sh'], 'hidden files are left out')
  assert.deepEqual(rt.scripts, ['scripts/run.sh'])
  assert.equal(rt.description, 'Write and run React component tests with Playwright and Jest.')
  assert.deepEqual(by['sql-reviewer'].tools, ['Read', 'Grep'])
  assert.equal(by['pg-migrations'].license, 'Apache-2.0', 'own license wins')

  // Agent draft: role inferred from tools, pinned origin accepted by parseUserAgents.
  const draft = agentDraft(fe, bodies[fe.id])
  assert.equal(draft.role, 'writer')
  assert.equal(draft.forked_from, `wshobson-agents:wshobson/agents@${fx.sha}/plugins/web/agents/frontend-dev.md`)
  const rev = agentDraft(by['sql-reviewer'], bodies[by['sql-reviewer'].id])
  assert.equal(rev.role, 'reader')
  assert.equal(rev.model, 'claude-opus-5-5')
  const parsed = parseUserAgents([{ ...draft, enabled: true }], {})
  assert.equal(parsed.forkedFrom['frontend-dev'], draft.forked_from, 'catalog origin kept verbatim')
  assert.equal(parsed.roles['frontend-dev'], 'writer')

  // Install: copies files at the pinned sha, writes provenance, refuses collisions and traversal.
  const root = mkdtempSync(join(tmpdir(), 'store-catalog-'))
  try {
    const fetched: string[] = []
    const fetchFile = async (p: string) => { fetched.push(p); return fx.files[p] != null ? Buffer.from(fx.files[p]) : null }
    const ok = await installSkill(rt, root, new Set(['meetings']), fetchFile)
    assert.deepEqual(ok, { ok: true, name: 'react-testing' })
    assert.ok(existsSync(join(root, 'react-testing', 'scripts', 'run.sh')))
    assert.ok(fetched.every((p) => p.startsWith('plugins/web/skills/react-testing/')))
    assert.equal(skillProvenance(root, 'react-testing')?.sha, fx.sha)
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'react-testing', PROVENANCE_FILE), 'utf-8')).scripts, ['scripts/run.sh'])
    assert.ok(!readdirSync(root).some((n) => n.startsWith('.installing')), 'temp dir cleaned up')

    assert.ok('error' in await installSkill(rt, root, new Set(), fetchFile), 'never overwrites an installed skill')
    assert.match((await installSkill({ ...rt, name: 'meetings' }, root, new Set(['meetings']), fetchFile) as any).error, /built-in/)
    for (const bad of ['../evil.sh', 'scripts/../../x', '/etc/passwd', '.git/config', 'a\\b', 'scripts/./x']) {
      assert.equal(safeRelPath(bad), false, bad)
      const r = await installSkill({ ...rt, name: 'trav', files: ['SKILL.md', bad] }, root, new Set(), fetchFile)
      assert.match((r as any).error, /unsafe path/, bad)
      assert.ok(!existsSync(join(root, 'trav')))
    }
    assert.ok('error' in await installSkill({ ...rt, name: 'missing', files: ['SKILL.md', 'nope.md'] }, root, new Set(), fetchFile))
    assert.ok(!existsSync(join(root, 'missing')), 'a failed fetch leaves nothing behind')
    assert.ok('error' in await installSkill({ ...rt, name: 'big', files: ['SKILL.md'] }, root, new Set(), async () => Buffer.alloc(11 * 1024 * 1024)))
    assert.ok('error' in await installSkill(fe, root, new Set(), fetchFile), 'agents are not installed as skills')
  } finally { rmSync(root, { recursive: true, force: true }) }

  // Installed: a skill by its folder, an agent by a row installed from the same file (any commit).
  const inst = installedIds(entries, new Set(['react-testing']), [draft.forked_from.replace(fx.sha, 'abcdef1')])
  assert.deepEqual([...inst].sort(), [fe.id, rt.id].sort())

  // Recommendations: ranked by overlap with what the user does, with the reason; installed ones excluded.
  const recs = recommend(entries, [
    { text: 'Postgres schema migrations for supabase', reason: 'because you worked on “db migrations”' },
    { text: 'react-testing React component tests', reason: 'because you use the react-testing skill' },
  ], new Set([rt.id]))
  const names = recs.map((r) => entries.find((e) => e.id === r.id)!.name)
  assert.ok(!names.includes('react-testing'), 'installed entries are not recommended')
  assert.equal(names[0], 'pg-migrations')
  assert.equal(recs[0].reason, 'because you worked on “db migrations”')
  assert.ok(names.includes('frontend-dev'))
  assert.equal(recs.find((r) => r.id.endsWith('frontend-dev.md'))!.reason, 'because you use the react-testing skill')
  assert.deepEqual(recommend(entries, [], new Set()), [])
  // The same agent in two plugins is recommended once.
  const dup: CatalogEntry = { ...by['pg-migrations'], id: 'wshobson-agents:plugins/other/skills/pg-migrations' }
  assert.equal(recommend([...entries, dup], [{ text: 'postgres migrations', reason: 'r' }], new Set()).filter((r) => r.id.includes('pg-migrations')).length, 1)

  console.log('store-catalog: all assertions passed')
}
run().catch((e) => { console.error(e); process.exit(1) })
