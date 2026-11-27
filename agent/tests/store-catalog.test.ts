// Store catalog: normalisation from a fixture snapshot, install refusals, recommendations.
// Run with `npx tsx agent/tests/store-catalog.test.ts`. No network.
import assert from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SOURCES, normaliseSource, installSkill, findUpdates, revOf, agentDraft, recommend, installedIds, safeRelPath, skillProvenance, PROVENANCE_FILE, TooLarge, type CatalogEntry } from '../src/store-catalog.js'
import { parseUserAgents, parseFrontMatter } from '../src/agent-store.js'

const fx = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'store-catalog.json'), 'utf-8'))
const read = async (p: string) => fx.files[p] ?? null
// A git blob sha: what GitHub lists for each file, so a script-only change moves it.
const blobSha = (t: string) => createHash('sha1').update(`blob ${Buffer.byteLength(t)}\0`).update(t).digest('hex')
const shasOf = (files: Record<string, string>) => Object.fromEntries(Object.keys(files).map((p) => [p, blobSha(files[p])]))
const snapAt = (sha: string, files: Record<string, string> = fx.files, paths: string[] = fx.paths) => ({ sha, paths, shas: shasOf(files) })
const src = SOURCES.find((s) => s.id === 'wshobson-agents')!

// Front matter: inline lists, block lists, folded scalars, quotes.
assert.deepEqual(parseFrontMatter('---\nname: "x"\ntools: [a]\n---\nbody').meta.name, 'x')
assert.deepEqual(parseFrontMatter('---\ntools: ["Read", Grep]\n---\n').meta.tools, ['Read', 'Grep'])
assert.deepEqual(parseFrontMatter('---\ntools:\n  - Read\n  - Grep\n---\n').meta.tools, ['Read', 'Grep'])
assert.equal(parseFrontMatter('---\ndescription: >\n  one\n  two\n---\n').meta.description, 'one two')
assert.equal(parseFrontMatter('no front matter').body, 'no front matter')

const run = async () => {
  const { entries, bodies, failed } = await normaliseSource(src, snapAt(fx.sha), read)
  assert.equal(failed, 0)
  const flaky = await normaliseSource(src, snapAt(fx.sha), (p: string) => (/frontend-dev/.test(p) ? Promise.reject(new Error('429')) : read(p)))
  assert.ok(flaky.failed > 0 && !flaky.entries.some((e) => e.name === 'frontend-dev'), 'a failed read is counted, so a partial catalog is not cached as good')
  const big = await normaliseSource(src, snapAt(fx.sha), (p: string) => (/frontend-dev/.test(p) ? Promise.reject(new TooLarge('big')) : read(p)))
  assert.ok(big.tooLarge === 1 && big.failed === 0 && !big.entries.some((e) => e.name === 'frontend-dev'), 'an oversize file is counted apart from a missing one')
  const by = Object.fromEntries(entries.map((e) => [e.name, e]))
  assert.deepEqual(Object.keys(by).sort(), ['frontend-dev', 'pg-migrations', 'react-testing', 'sql-reviewer'], 'MCP entries and external_plugins are skipped')

  const fe = by['frontend-dev']
  assert.equal(fe.kind, 'agent')
  assert.deepEqual(fe.tools, ['Read', 'Edit', 'Write', 'Bash'])
  assert.equal(fe.model, 'sonnet')
  assert.equal(fe.sha, fx.sha)
  const moved = await normaliseSource(src, snapAt('f'.repeat(40)), (p: string) => (/frontend-dev/.test(p) ? read(p).then((t) => t + '\nchanged') : read(p)))
  const movedBy = Object.fromEntries(moved.entries.map((e) => [e.name, e]))
  assert.equal(movedBy['react-testing'].rev, by['react-testing'].rev, 'a commit elsewhere in the repo leaves an entry\'s rev alone')
  assert.notEqual(movedBy['frontend-dev'].rev, fe.rev, 'a changed entry gets a new rev')
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
  assert.deepEqual([...rt.files].sort(), ['SKILL.md', 'references/guide.md', 'scripts/run.sh'], 'hidden files are left out')
  assert.deepEqual(rt.scripts, ['scripts/run.sh'])
  assert.equal(rt.description, 'Write and run React component tests with Playwright and Jest.')
  assert.deepEqual(by['sql-reviewer'].tools, ['Read', 'Grep'])
  assert.equal(by['pg-migrations'].license, 'Apache-2.0', 'own license wins')

  // Agent draft: role inferred from tools; parseUserAgents keeps the saved role.
  const draft = agentDraft(fe, bodies[fe.id])
  assert.equal(draft.role, 'writer')
  assert.equal(draft.forked_from, `wshobson-agents:wshobson/agents@${fx.sha}/plugins/web/agents/frontend-dev.md`)
  const rev = agentDraft(by['sql-reviewer'], bodies[by['sql-reviewer'].id])
  assert.equal(agentDraft(fe, 'x'.repeat(25000)).prompt.length, 25000, 'a long prompt is never cut (install refuses it instead)')
  assert.equal(rev.role, 'reader')
  assert.equal(rev.model, 'claude-opus-5-5')
  const parsed = parseUserAgents([{ ...draft, enabled: true }], {})
  assert.equal(parsed.roles['frontend-dev'], 'writer')

  // Install: copies files at the pinned sha, writes provenance, refuses collisions and traversal.
  const root = mkdtempSync(join(tmpdir(), 'store-catalog-'))
  try {
    const fetched: string[] = []
    const fetchFile = async (p: string) => { fetched.push(p); return fx.files[p] != null ? Buffer.from(fx.files[p]) : null }
    const ok = await installSkill(rt, root, new Set(['meetings']), fetchFile)
    assert.deepEqual(ok, { ok: true, name: 'react-testing' })
    assert.ok(existsSync(join(root, 'react-testing', 'scripts', 'run.sh')))
    assert.ok(fetched.every((p) => p.startsWith('plugins/web/skills/react-testing/') || p === 'LICENSE'), 'only the skill folder and the root licence are fetched')
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
    assert.match((await installSkill({ ...rt, name: 'huge' }, root, new Set(), async () => { throw new TooLarge('SKILL.md is larger than 2 MB') }) as any).error, /larger than 2 MB/, 'an oversize file is a refusal, not a crash')

    // Updates: same text at a new commit is no update; changed text is, and one click replaces the folder.
    const newSha = 'e'.repeat(40)
    const noReads = () => async () => { throw new Error('a stored rev needs no read') }
    assert.deepEqual(await findUpdates([{ ...rt, sha: newSha }], root, ['react-testing'], [], noReads), [], 'a commit elsewhere is no update')
    const rt2 = { ...rt, sha: newSha, rev: revOf(fx.files[`${rt.path}/SKILL.md`] + 'v2', rt.files) }
    assert.deepEqual(await findUpdates([rt2], root, ['react-testing'], [], noReads), [{ id: rt.id, kind: 'skill', target: 'react-testing', from: fx.sha, to: newSha }])
    assert.deepEqual(await findUpdates([{ ...rt2, name: 'react-tests' }], root, ['react-testing'], [], noReads), [], 'a skill renamed upstream is not offered (its update would target another folder)')
    const v2 = async (p: string) => Buffer.from(p.endsWith('SKILL.md') ? 'v2 skill' : fx.files[p])
    assert.match((await installSkill({ ...rt2, path: 'other/path' }, root, new Set(), v2, { update: true }) as any).error, /not installed from this catalog entry/, 'an update never replaces a folder from another entry')
    assert.deepEqual(await installSkill(rt2, root, new Set(), v2, { update: true }), { ok: true, name: 'react-testing' })
    assert.equal(readFileSync(join(root, 'react-testing', 'SKILL.md'), 'utf-8'), 'v2 skill')
    assert.equal(skillProvenance(root, 'react-testing')?.sha, newSha)
    assert.deepEqual(await findUpdates([rt2], root, ['react-testing'], [], noReads), [], 'up to date after the update')
    assert.ok(!readdirSync(root).some((n) => n.startsWith('.installing')), 'swap leaves no temp folders')
    // An install from before revs were stored: its rev is worked out once from its pinned commit.
    const prov = JSON.parse(readFileSync(join(root, 'react-testing', PROVENANCE_FILE), 'utf-8'))
    delete prov.rev; prov.sha = fx.sha
    writeFileSync(join(root, 'react-testing', PROVENANCE_FILE), JSON.stringify(prov))
    const atOld = () => read
    const shasAtOld = async () => shasOf(fx.files)
    assert.equal((await findUpdates([rt2], root, ['react-testing'], [], atOld, shasAtOld)).length, 1, 'legacy install: old text differs, so an update shows')
    assert.equal((await findUpdates([{ ...rt, sha: newSha }], root, ['react-testing'], [], atOld, shasAtOld)).length, 0, 'legacy install: same text, no update')
  } finally { rmSync(root, { recursive: true, force: true }) }

  // Agent updates: matched by the row's forked_from; the old rev is read at the pinned commit.
  const fe2 = { ...fe, sha: 'd'.repeat(40), rev: 'changed0rev00000' }
  const row = { name: 'my-fe', origin: draft.forked_from }
  const [au] = await findUpdates([fe2], tmpdir(), [], [row], () => read)
  assert.deepEqual({ ...au, base: undefined }, { id: fe.id, kind: 'agent', target: 'my-fe', from: fx.sha, to: fe2.sha, base: undefined })
  assert.deepEqual(au.base, { prompt: draft.prompt, tools: draft.tools, model: draft.model, description: draft.description }, 'the pinned draft fields come back, so an edited row can be told apart')
  assert.deepEqual(await findUpdates([{ ...fe, sha: 'd'.repeat(40) }], tmpdir(), [], [row], () => read), [], 'agent: same text at a new commit is no update')
  assert.deepEqual(await findUpdates([fe2], tmpdir(), [], [{ name: 'x', origin: 'other:a/b@abcdef1/c.md' }], () => read), [], 'unrelated origin')

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

  // iart-ai/b-roll-skills: a root LICENSE, a skill with scripts and an HTML template.
  const br = SOURCES.find((x) => x.id === 'iart-b-roll')!
  assert.equal(br.repo, 'iart-ai/b-roll-skills')
  const D = 'skills/talking-head-b-roll'
  const bFiles: Record<string, string> = {
    LICENSE: 'MIT License\n\nCopyright (c) iArt', 'README.md': 'readme',
    [`${D}/SKILL.md`]: '---\nname: talking-head-b-roll\ndescription: Add b-roll to a talking-head video.\n---\nbody',
    [`${D}/scripts/render.mjs`]: 'render v1', [`${D}/templates/b-roll.html`]: '<html>v1</html>',
  }
  const bPaths = Object.keys(bFiles)
  const bRead = async (path: string) => bodies0(path)
  let live = bFiles
  const bodies0 = (path: string) => live[path] ?? null
  const b1 = await normaliseSource(br, snapAt('1'.repeat(40), bFiles, bPaths), bRead)
  const [b] = b1.entries
  assert.equal(b1.entries.length, 1)
  assert.equal(b.name, 'talking-head-b-roll')
  assert.equal(b.license, 'MIT')
  assert.deepEqual(b.scripts.sort(), ['scripts/render.mjs', 'templates/b-roll.html'], 'an HTML template counts as a file that can run')
  assert.equal(b.licenseFile, 'LICENSE')
  assert.ok(b.rev.startsWith('s2:'))

  // A script-only upstream change moves the rev (so the 409 guard and the update offer both see it).
  const scriptOnly = { ...bFiles, [`${D}/scripts/render.mjs`]: 'render v2' }
  live = scriptOnly
  const b2 = (await normaliseSource(br, snapAt('2'.repeat(40), scriptOnly, bPaths), bRead)).entries[0]
  assert.notEqual(b2.rev, b.rev, 'a changed script moves the rev')
  const tmplOnly = { ...bFiles, [`${D}/templates/b-roll.html`]: '<html>v2</html>' }
  assert.notEqual((await normaliseSource(br, snapAt('3'.repeat(40), tmplOnly, bPaths), async (q) => tmplOnly[q] ?? null)).entries[0].rev, b.rev, 'so does the template')
  const elsewhere = { ...bFiles, 'README.md': 'new readme' }
  assert.equal((await normaliseSource(br, snapAt('4'.repeat(40), elsewhere, bPaths), async (q) => elsewhere[q] ?? null)).entries[0].rev, b.rev, 'a commit elsewhere in the repo leaves the rev alone')

  const root2 = mkdtempSync(join(tmpdir(), 'store-broll-'))
  try {
    live = bFiles
    const fetchB = async (q: string) => (bFiles[q] != null ? Buffer.from(bFiles[q]) : null)
    assert.deepEqual(await installSkill(b, root2, new Set(), fetchB), { ok: true, name: 'talking-head-b-roll' })
    assert.equal(readFileSync(join(root2, 'talking-head-b-roll', 'LICENSE'), 'utf-8'), bFiles.LICENSE, 'the root licence is installed with the skill')
    // A skill that ships its own licence keeps it and gets no second copy.
    const own = { ...b, name: 'own-lic', files: [...b.files, 'LICENSE.txt'] }
    const fetchOwn = async (q: string) => (q.endsWith('LICENSE.txt') ? Buffer.from('own') : fetchB(q))
    await installSkill(own, root2, new Set(), fetchOwn)
    assert.ok(!existsSync(join(root2, 'own-lic', 'LICENSE')))
    // A licence that cannot be fetched refuses the install and leaves nothing behind.
    assert.match((await installSkill({ ...b, name: 'nolic' }, root2, new Set(), async (q) => (q === 'LICENSE' ? null : fetchB(q))) as any).error, /could not fetch LICENSE/)
    assert.ok(!existsSync(join(root2, 'nolic')))

    // The installed skill is offered an update when only a script changed upstream.
    const newer = { ...b2 }
    const noReads = () => async () => { throw new Error('a stored rev needs no read') }
    assert.deepEqual(await findUpdates([newer], root2, ['talking-head-b-roll'], [], noReads), [{ id: b.id, kind: 'skill', target: 'talking-head-b-roll', from: b.sha, to: newer.sha }], 'a script-only change is an update')
    assert.deepEqual(await findUpdates([{ ...b, sha: '5'.repeat(40) }], root2, ['talking-head-b-roll'], [], noReads), [], 'a commit elsewhere is no update')
    // An install from before blob shas were hashed: no false update, and a script change still shows.
    const prov = JSON.parse(readFileSync(join(root2, 'talking-head-b-roll', PROVENANCE_FILE), 'utf-8'))
    prov.rev = revOf(bFiles[`${D}/SKILL.md`], b.files)
    writeFileSync(join(root2, 'talking-head-b-roll', PROVENANCE_FILE), JSON.stringify(prov))
    const atPin = () => async (q: string) => bFiles[q] ?? null
    const shasPin = async () => shasOf(bFiles)
    assert.equal((await findUpdates([{ ...b, sha: '5'.repeat(40) }], root2, ['talking-head-b-roll'], [], atPin, shasPin)).length, 0, 'old rev format: unchanged skill shows no update')
    assert.equal((await findUpdates([newer], root2, ['talking-head-b-roll'], [], atPin, shasPin)).length, 1, 'old rev format: a script change shows')
  } finally { rmSync(root2, { recursive: true, force: true }) }

  console.log('store-catalog: all assertions passed')
}
run().catch((e) => { console.error(e); process.exit(1) })
