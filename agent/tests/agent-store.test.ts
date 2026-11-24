// Agent & skill store rules: run with `npx tsx agent/tests/agent-store.test.ts`.
import assert from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { storeWriteRefusal, storeWriteOriginAllowed, parseUserAgents, mergeAgents, describeAgents, forkSkill, installMissingCoreSkills, removeUserSkill, addUserSkill, readUserSkill, skillForkedFrom, coreSkillNames, parseFrontMatter, skillHeading } from '../src/agent-store.js'

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
assert.equal(parsed.roles['my-writer'], 'writer', 'a fork holds its parent\'s role')
assert.equal((parsed.agents['my-writer'] as any).forkedFrom, undefined, 'fork origin stays out of the SDK definition')
assert.deepEqual(parsed.origins, { 'my-writer': 'writer' })
{
  const cat = parseUserAgents([{ name: 'fe', description: 'd', prompt: 'p', forked_from: `wshobson-agents:wshobson/agents@${'a'.repeat(40)}/plugins/web/agents/fe.md` }], core)
  assert.equal(describeAgents(core, cat.agents, cat.roles, false, cat.origins).find((a) => a.name === 'fe')!.origin, 'wshobson/agents @aaaaaaa', 'catalog origin label')
  assert.equal(describeAgents(core, cat.agents, cat.roles, false, cat.origins).find((a) => a.name === 'writer')!.origin, undefined)
}

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

assert.equal(describeAgents(core, parsed.agents, parsed.roles)[0].prompt, undefined, 'no prompts on the data channel')
const listing = describeAgents(core, parsed.agents, parsed.roles, true)
const byName = Object.fromEntries(listing.map((a) => [a.name, a]))
assert.equal(byName.writer.core, true)
assert.equal(byName.writer.prompt, 'WRITER PROMPT')
assert.equal(byName['my-writer'].core, false)
assert.equal(byName['my-writer'].role, 'writer')
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

  // Adding: an installed built-in is never overwritten; a missing one gets the packaged copy, not the body sent.
  assert.ok('error' in addUserSkill(home, pkg, 'meetings', 'new'))
  rmSync(join(home, 'meetings'), { recursive: true })
  assert.ok('ok' in addUserSkill(home, pkg, 'meetings', '# Served copy v9'))
  assert.equal(readFileSync(join(home, 'meetings', 'SKILL.md'), 'utf-8'), readFileSync(join(pkg, 'meetings', 'SKILL.md'), 'utf-8'))
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

// Store writes: who may change skills.
{
  const fe = 'https://app.example.com'
  assert.ok(storeWriteOriginAllowed(undefined, fe), 'no Origin: not a cross-site browser request')
  for (const o of ['http://localhost:3000', 'http://127.0.0.1:5173', 'https://voice-native.com', 'https://www.voice-native.com', 'https://app.example.com']) assert.ok(storeWriteOriginAllowed(o, fe), o)
  for (const o of ['https://evil.example', 'null', 'http://localhost.evil.com', 'https://voice-native.com.evil.io', 'https://evil.www.voice-native.com']) assert.ok(!storeWriteOriginAllowed(o, fe), o)
  const local = { hasToken: false, publicDeploy: false, forwarded: false, host: 'localhost:8741', remote: '127.0.0.1', origin: 'http://localhost:3000', contentType: 'application/json', frontendUrl: fe }
  assert.equal(storeWriteRefusal(local), null)
  assert.equal(storeWriteRefusal({ ...local, origin: 'https://evil.example' })?.status, 403, 'any website on a local agent with no token')
  assert.equal(storeWriteRefusal({ ...local, contentType: 'text/plain' })?.status, 415)
  assert.equal(storeWriteRefusal({ ...local, remote: '192.168.1.9' })?.status, 403, 'another machine on the LAN')
  assert.equal(storeWriteRefusal({ ...local, forwarded: true })?.status, 403, 'through a tunnel or proxy')
  assert.equal(storeWriteRefusal({ ...local, host: 'my-tunnel.example.com' })?.status, 403, 'reached by a public name')
  assert.equal(storeWriteRefusal({ ...local, publicDeploy: true })?.status, 403, 'a cloud machine needs the token')
  assert.equal(storeWriteRefusal({ ...local, hasToken: true, publicDeploy: true, forwarded: true, host: 'x.fly.dev', remote: '10.0.0.1', origin: 'https://evil.example' }), null, 'with a token, unauthorized() is the gate')
  assert.equal(storeWriteRefusal({ ...local, hasToken: true, contentType: '' })?.status, 415)
  // Reads (core prompts, skills, catalog) get the same who-may-ask rules, minus the JSON check.
  assert.equal(storeWriteRefusal({ ...local, read: true, contentType: '' }), null)
  assert.equal(storeWriteRefusal({ ...local, read: true, remote: '192.168.1.9' })?.status, 403, 'a LAN device cannot read prompts or skills')
  assert.equal(storeWriteRefusal({ ...local, read: true, origin: 'https://evil.example' })?.status, 403, 'another site cannot read them')
}

// A skill's display title is its first H1 outside fenced code, never a template heading inside a fence.
{
  const fenced = '## What to capture\n\n```md\n# User Context — {user name or handle}\n\nNotes.\n```\n\n## Rules\n'
  assert.deepEqual(skillHeading(fenced), {}, 'an H1 only inside a fence is no title')
  assert.deepEqual(skillHeading('~~~\n# Not this\n~~~\n# Skill: Meetings\n\nTakes notes.\n'), { title: 'Meetings', paragraph: 'Takes notes.' })
  assert.deepEqual(skillHeading('````md\n```\n# Still fenced\n```\n````\n# Real\n## Next\n'), { title: 'Real' }, 'a shorter inner fence does not close the outer one')
  assert.deepEqual(skillHeading('```js title\n# x\n```\n# Real\n'), { title: 'Real' })
  assert.deepEqual(skillHeading('#hashtag\n# Title\n'), { title: 'Title' }, '`#word` is not a heading')
  const userContext = readFileSync(join(import.meta.dirname, '..', '.claude', 'skills', 'user-context', 'SKILL.md'), 'utf-8')
  assert.equal(skillHeading(parseFrontMatter(userContext).body).title, undefined, 'the shipped user-context skill falls back to its folder name')
}

console.log('agent-store: all assertions passed')

// Boot copy of packaged core skills: only the allowlist, never overwrites, never resurrects a removed one.
{
  const root = mkdtempSync(join(tmpdir(), 'osb-core-skills-'))
  const pkg = join(root, 'pkg'), home = join(root, 'home'), marker = join(root, 'm', 'installed.json')
  for (const n of ['dispatch', 'meetings']) { mkdirSync(join(pkg, n), { recursive: true }); writeFileSync(join(pkg, n, 'SKILL.md'), `packaged ${n}`) }
  assert.deepEqual(installMissingCoreSkills(home, pkg, marker), ['dispatch'])
  assert.equal(readFileSync(join(home, 'dispatch', 'SKILL.md'), 'utf8'), 'packaged dispatch')
  assert.equal(existsSync(join(home, 'meetings')), false, 'other packaged skills are not copied')
  assert.deepEqual(installMissingCoreSkills(home, pkg, marker), [], 'second run is a no-op')
  rmSync(join(home, 'dispatch'), { recursive: true })
  assert.deepEqual(installMissingCoreSkills(home, pkg, marker), [], 'a deleted skill is not reinstalled')
  assert.equal(existsSync(join(home, 'dispatch')), false)
  const home2 = join(root, 'home2'), marker2 = join(root, 'm2.json')
  mkdirSync(join(home2, 'dispatch'), { recursive: true }); writeFileSync(join(home2, 'dispatch', 'SKILL.md'), 'my edited copy')
  assert.deepEqual(installMissingCoreSkills(home2, pkg, marker2), [])
  assert.equal(readFileSync(join(home2, 'dispatch', 'SKILL.md'), 'utf8'), 'my edited copy')
  rmSync(join(home2, 'dispatch'), { recursive: true })
  assert.deepEqual(installMissingCoreSkills(home2, pkg, marker2), [], 'a pre-existing copy the user later deletes stays deleted')
  assert.deepEqual(installMissingCoreSkills(join(root, 'new-home'), join(root, 'nope'), join(root, 'm3.json')), [])
  rmSync(root, { recursive: true, force: true })
  console.log('installMissingCoreSkills tests passed')
}
