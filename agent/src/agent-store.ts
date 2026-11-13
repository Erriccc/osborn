// Agent & skill store rules. Built-in (core) agents and shipped skills are
// maintained by Voice Native: users can view and fork them, never override,
// edit or remove them. A fork is a user-owned copy under a new name.
// The frontend reads every rule it shows (roles, models, limits) from here
// through /agents and agents_status; it keeps no copy.
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

export interface AgentDef { description: string; prompt: string; tools?: string[]; model?: string; grounded?: boolean }
/** The built-in agents (claude-llm.ts NAMED_AGENTS): each holds the role of its own name. */
export type CoreAgents = Record<string, { description: string; prompt: string; tools?: readonly string[]; model?: string; grounded?: boolean }>
export interface AgentListing {
  name: string
  description: string
  model?: string
  tools?: string[]
  core: boolean
  prompt?: string
  /** A user agent's origin, for people: the built-in it was forked from, or 'owner/repo @sha7' for a catalog install. */
  origin?: string
  role: Role
  /** The role's one-liner (for a built-in agent, its card text) and icon key. */
  summary: string
  icon: string
  behaviours: string[]
}

// ── Roles ────────────────────────────────────────────────────────────────────
// What an agent may do is decided by its ROLE, never its name, so a fork or an
// imported agent carries the behaviour of the role it holds. Core agents hold
// the role of the same name; a fork inherits its parent's; any other agent's is
// the one saved on it (a catalog draft gets one from its tools, see draftRole), else reader.

/** 'workspace': session workspace only. 'anywhere': any path, through the
 *  permission dialog. Extension rule: only matching files (fail closed). */
export type WriteRule =
  | 'workspace'
  | 'anywhere'
  | { extensions: RegExp; label: string; matchBasename?: boolean }

export const ROLE_NAMES = ['reader', 'researcher', 'reasoner', 'planner', 'writer', 'tester', 'steward', 'reviewer'] as const
export type Role = typeof ROLE_NAMES[number]
const isRole = (r: unknown): r is Role => typeof r === 'string' && (ROLE_NAMES as readonly string[]).includes(r)

interface RoleSpec {
  /** One line for people: the card text of the built-in agent of this role, and the role picker's hint. */
  summary: string
  /** Icon key; the frontend maps it to a glyph. */
  icon: string
  write: WriteRule
  /** A built-in agent of this role writes into .claude/skills/<name>/ without a dialog. */
  skillInstall?: boolean
  /** Its first edit of an existing file each turn is held once with a history reminder; its writes show in the live trace. */
  historyFirst?: boolean
  /** Its final message is parsed into a steward verdict card. */
  verdict?: boolean
  /** Verifier chain: who runs after it. The text pushed to the orchestrator when it
   *  finishes is a prompt: prompts/chain-after-<role>.md (getChainReminder). */
  chain?: Role[]
}

export const ROLES: Record<Role, RoleSpec> = {
  reader: { summary: 'Reads and reports. Writes notes in the session workspace only.', icon: 'robot', write: 'workspace' },
  researcher: {
    summary: 'Digs through your code and the web to gather facts; a reasoner checks them before they are used.',
    icon: 'search', write: 'workspace', chain: ['reasoner'],
  },
  reasoner: { summary: 'Thinks through hard problems, writes plans and gates research. Writes notes in the session workspace only.', icon: 'brain', write: 'workspace' },
  planner: {
    summary: 'Breaks a task into ordered steps; the steward checks the plan for things that already exist.',
    icon: 'list', write: 'workspace', chain: ['steward', 'writer'],
  },
  writer: {
    summary: 'Makes the code changes (each write goes through your permission settings); its work is tested, stewarded and reviewed.',
    icon: 'pen', write: 'anywhere', skillInstall: true, historyFirst: true, chain: ['tester', 'steward', 'reviewer'],
  },
  tester: { summary: 'Writes and runs tests to check the work holds up. May write test files only.', icon: 'test', write: { extensions: /\.(test|spec)\.[jt]sx?$/, label: 'test', matchBasename: true } },
  steward: {
    summary: 'Keeps the code lean: reuses what exists and makes sure a change breaks nothing that depends on it.',
    icon: 'shield', write: 'anywhere',  // refactors the writer's diff in place
    verdict: true,
  },
  reviewer: { summary: 'Reviews the final diff for problems before it ships. May write documentation files only.', icon: 'eye', write: { extensions: /\.(md|markdown|mdx|txt|rst|adoc)$/i, label: 'documentation' } },
}

/** Tools that edit files: the write gate covers each of them, and a catalog draft with one is a writer. */
export const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** The role a catalog agent's draft starts with: a writer if it can edit, else a reader.
 *  It is saved on the row, so the owner sees it and can change it. Never applied to saved rows. */
export const draftRole = (tools?: string[] | null): Role =>
  (tools || []).some((t) => EDIT_TOOLS.has(String(t).trim())) ? 'writer' : 'reader'

/** The role of a built-in agent (null for any other name). Own keys only. */
export const coreRole = (name: unknown, core: CoreAgents): Role | null =>
  typeof name === 'string' && Object.hasOwn(core, name) && isRole(name) ? name : null

/** Role of a saved user agent: the one set on it, else its built-in parent's, else reader (never inferred). */
const resolveRole = (a: { role?: unknown; forkedFrom?: string }, core: CoreAgents): Role =>
  isRole(a.role) ? a.role : coreRole(a.forkedFrom, core) ?? 'reader'

/** The acting agent's role (null = the main orchestrator, or an agent we do not know). */
export function roleOf(agentType: unknown, userRoles: Record<string, Role> | undefined, core: CoreAgents): Role | null {
  if (typeof agentType !== 'string' || !agentType) return null
  return userRoles && Object.hasOwn(userRoles, agentType) ? userRoles[agentType] : coreRole(agentType, core)
}

/** Skill folders are written without a dialog only by a BUILT-IN agent whose role installs skills. */
export const installsSkillsSilently = (role: Role | null, isCore: boolean) => !!(role && isCore && ROLES[role].skillInstall)

/** What a role unlocks, in plain words for the store. */
function roleBehaviours(role: Role, isCore: boolean): string[] {
  const r = ROLES[role]
  const out: string[] = []
  if (r.write === 'workspace') out.push('Writes only in the session workspace')
  else if (r.write === 'anywhere') out.push('Can edit files anywhere, through your permission settings')
  else out.push(`Can write ${r.write.label} files only`)
  if (installsSkillsSilently(role, isCore)) out.push('Installs skills without asking for each file')
  if (r.historyFirst) out.push("Checks a file's history before its first edit")
  if (r.verdict) out.push('Its verdict shows as a card in chat')
  if (r.chain) out.push(`When it finishes: ${r.chain.join(' → ')}`)
  return out
}

// ── Definitions shared with the frontend and the user_agents SQL checks ───────
// (migrations 004/015/016/017; agent/tests/user-agents-migrations.test.ts keeps them equal)

export const AGENT_MODELS = ['inherit', 'sonnet', 'opus', 'haiku', 'fable'] as const
export const isAgentModel = (m: unknown): m is string => typeof m === 'string' && ((AGENT_MODELS as readonly string[]).includes(m) || /^claude-/.test(m))
export const AGENT_LIMITS = { name: 40, description: 500, prompt: 20000 } as const

/** Roles, chains and the editor's rules for the store (served by /agents and agents_status). */
export const describeRoles = () => ({
  roles: ROLE_NAMES.map((role) => ({ role, summary: ROLES[role].summary, icon: ROLES[role].icon, behaviours: roleBehaviours(role, false) })),
  chains: ROLE_NAMES.filter((r) => ROLES[r].chain).map((r) => [r, ...ROLES[r].chain!]),
  models: AGENT_MODELS,
  limits: AGENT_LIMITS,
})

export const storeName = (raw: unknown): string =>
  String(raw ?? '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-')

// ── Catalog origins: forked_from of an agent installed from a store catalog ────
// '<source>:<owner>/<repo>@<sha>/<path>' (user_agents check, migration 016).

export const catalogOrigin = (e: { source: string; repo: string; sha: string; path: string }) => `${e.source}:${e.repo}@${e.sha}/${e.path}`
/** The same catalog file at any commit. */
export const unpinnedOrigin = (origin: string) => origin.replace(/@[0-9a-f]{7,40}\//, '/')
/** Where a user agent came from, for people: its built-in parent's name, or 'owner/repo @sha7'. */
const originLabel = (forkedFrom: string, core: CoreAgents): string | undefined => {
  if (coreRole(forkedFrom, core)) return forkedFrom
  const m = /^[^:]+:([^@]+)@([0-9a-f]{7})[0-9a-f]*\//.exec(forkedFrom)
  return m ? `${m[1]} @${m[2]}` : undefined
}

/** Validates user_agents rows. Disabled rows are skipped; every other dropped
 *  row is reported with its reason (a core name: core agents cannot be overridden). */
export function parseUserAgents(rows: unknown, core: CoreAgents): {
  agents: Record<string, AgentDef>; roles: Record<string, Role>; origins: Record<string, string>; dropped: { name: string; reason: string }[]
} {
  const agents: Record<string, AgentDef> = {}
  const roles: Record<string, Role> = {}
  const origins: Record<string, string> = {}
  const dropped: { name: string; reason: string }[] = []
  for (const r of Array.isArray(rows) ? rows : []) {
    const name = storeName(r?.name)
    const description = String(r?.description || '').trim()
    const prompt = String(r?.prompt || '').trim()
    if (r?.enabled === false) continue
    const reason = !name ? 'no name'
      : Object.hasOwn(core, name) ? 'is a core agent (fork it under a new name)'
      : name.length > AGENT_LIMITS.name ? `name longer than ${AGENT_LIMITS.name}`
      : !description ? 'no description'
      : description.length > AGENT_LIMITS.description ? `description longer than ${AGENT_LIMITS.description}`
      : !prompt ? 'no prompt'
      : prompt.length > AGENT_LIMITS.prompt ? `prompt longer than ${AGENT_LIMITS.prompt}`
      : ''
    if (reason) { dropped.push({ name: name || '(unnamed)', reason }); continue }
    const rawFrom = String(r.forkedFrom ?? r.forked_from ?? '').trim()
    const origin = originLabel(rawFrom, core)
    if (origin) origins[name] = origin
    // Only a built-in parent matters to the role and grounding; a catalog origin names none.
    const from = storeName(rawFrom)
    roles[name] = resolveRole({ role: r.role, forkedFrom: from }, core)
    const tools: string[] | undefined = Array.isArray(r.tools) && r.tools.length ? r.tools.map(String) : undefined
    agents[name] = {
      description,
      prompt,
      ...(tools ? { tools } : {}),
      ...(isAgentModel(r.model) ? { model: r.model } : {}),
      // A fork of a grounded built-in reads the session recall store like its parent (claude-llm applyGrounding).
      ...(coreRole(from, core) && core[from].grounded ? { grounded: true } : {}),
    }
  }
  return { agents, roles, origins, dropped }
}

/** Effective agent set: every core agent, plus user agents whose names are free. */
export function mergeAgents<T>(core: Record<string, T>, user: Record<string, T> | null | undefined): Record<string, T> {
  const out: Record<string, T> = { ...core }
  for (const [name, a] of Object.entries(user || {})) if (!Object.hasOwn(core, name)) out[name] = a
  return out
}

/** UI listing; withPrompts adds the core prompts (GET /agents only, never the data channel). */
export function describeAgents(core: CoreAgents, user: Record<string, AgentDef> | null | undefined, roles: Record<string, Role> = {}, withPrompts = false, origins: Record<string, string> = {}): AgentListing[] {
  return Object.entries(mergeAgents<any>(core, user)).map(([name, a]) => {
    const isCore = Object.hasOwn(core, name)
    const role = roleOf(name, roles, core) ?? 'reader'
    return {
      name, description: a.description, model: a.model, tools: a.tools ? [...a.tools] : undefined, core: isCore, role,
      summary: ROLES[role].summary, icon: ROLES[role].icon, behaviours: roleBehaviours(role, isCore),
      ...(isCore && withPrompts ? { prompt: a.prompt } : {}),
      ...(!isCore && Object.hasOwn(origins, name) ? { origin: origins[name] } : {}),
    }
  })
}

// ── Who may change the machine's skills (skills add/fork/remove, catalog install) ──

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/
const LOOPBACK_ADDR = /^(127\.|::1$|::ffff:127\.)/

/** Browser origins allowed to make store writes on a machine with no sync token: a local
 *  page, voice-native.com, or the frontend the agent is configured with. No Origin = not a
 *  browser cross-site request. Also decides which origin the write routes' CORS echoes. */
export function storeWriteOriginAllowed(origin: string | undefined, frontendUrl: string): boolean {
  if (!origin) return true
  let u: URL
  try { u = new URL(origin) } catch { return false }
  let configured = ''
  try { configured = new URL(frontendUrl).origin } catch { /* none configured */ }
  return LOOPBACK_HOST.test(u.host) || /^https:\/\/(www\.)?voice-native\.com$/.test(u.origin) || u.origin === configured
}

/** Refusal for a store write, or null. With a token, unauthorized() has already checked it;
 *  without one, only this machine's own pages may write, never a public or tunnelled
 *  address, and every write must be JSON (no other site's form or text/plain POST). */
export function storeWriteRefusal(r: {
  hasToken: boolean; publicDeploy: boolean; forwarded: boolean; host?: string; remote?: string
  origin?: string; contentType?: string; frontendUrl: string
}): { status: number; error: string } | null {
  if (!r.hasToken) {
    if (r.publicDeploy || r.forwarded || !LOOPBACK_HOST.test(r.host || '')) return { status: 403, error: 'this machine is reachable from outside: set OSBORN_SYNC_TOKEN to change skills' }
    if (!LOOPBACK_ADDR.test(r.remote || '')) return { status: 403, error: 'store changes need the sync token or a request from this machine' }
    if (!storeWriteOriginAllowed(r.origin, r.frontendUrl)) return { status: 403, error: 'store changes are refused from this site' }
  }
  if (!/^application\/json\b/i.test(r.contentType || '')) return { status: 415, error: 'send JSON (Content-Type: application/json)' }
  return null
}

// ── SKILL.md and agent .md front matter ───────────────────────────────────────

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/** YAML front matter + body. Front matter YAML rejects (an unquoted ': ' is common in
 *  descriptions) falls back to its top-level `key: value` lines. */
export function parseFrontMatter(md: string): { meta: Record<string, unknown>; body: string } {
  const m = FRONT_MATTER.exec(md)
  if (!m) return { meta: {}, body: md }
  let meta: Record<string, unknown> = {}
  try {
    const y = parseYaml(m[1])
    if (y && typeof y === 'object' && !Array.isArray(y)) meta = y as Record<string, unknown>
  } catch {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z0-9_-]+):[ \t]*(.+)$/.exec(line)
      if (kv) meta[kv[1]] = kv[2].trim().replace(/^(['"])(.*)\1$/, '$2')
    }
  }
  for (const [k, v] of Object.entries(meta)) if (typeof v === 'string') meta[k] = v.trim()
  return { meta, body: md.slice(m[0].length) }
}

// ── Skills ───────────────────────────────────────────────────────────────────

/** Folder names of the skills shipped with the package. */
export function coreSkillNames(pkgSkillsDir: string): Set<string> {
  try {
    return new Set(readdirSync(pkgSkillsDir).filter((n) => existsSync(join(pkgSkillsDir, n, 'SKILL.md'))))
  } catch { return new Set() }
}

const FORK_MARKER = '.forked-from'

export function skillForkedFrom(skillsDir: string, folder: string): string | undefined {
  try { return readFileSync(join(skillsDir, folder, FORK_MARKER), 'utf-8').trim() || undefined } catch { return undefined }
}

type SkillResult = { ok: true } | { error: string }

export function readUserSkill(skillsDir: string, name: unknown): { name: string; content: string } | { error: string } {
  const folder = storeName(name)
  const p = join(skillsDir, folder, 'SKILL.md')
  return folder && existsSync(p) ? { name: folder, content: readFileSync(p, 'utf-8') } : { error: 'skill not found' }
}

/** Writes a skill the user sent. A built-in name installs the packaged copy instead of the
 *  sent body (it lists as built in, so it must be the shipped one; the Browser Screen Recorder
 *  seed updates itself from the served copy); an installed built-in is never overwritten. */
export function addUserSkill(skillsDir: string, pkgSkillsDir: string, name: unknown, content: unknown): SkillResult {
  const folder = storeName(name)
  const md = String(content ?? '').trim()
  if (!folder || !md) return { error: 'Name and content are required' }
  const dir = join(skillsDir, folder)
  if (coreSkillNames(pkgSkillsDir).has(folder)) {
    if (existsSync(join(dir, 'SKILL.md'))) return { error: `${folder} is a built-in skill — fork it under a new name` }
    cpSync(join(pkgSkillsDir, folder), dir, { recursive: true })
    return { ok: true }
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), md, 'utf-8')
  return { ok: true }
}

/** Copies a core skill folder to a new user-owned name (front matter `name` renamed). */
export function forkSkill(skillsDir: string, pkgSkillsDir: string, from: unknown, to: unknown): SkillResult {
  const core = coreSkillNames(pkgSkillsDir)
  const src = storeName(from), dst = storeName(to)
  if (!core.has(src)) return { error: 'only built-in skills can be forked' }
  if (!dst || core.has(dst)) return { error: 'choose a new name that is not a built-in skill' }
  const dstDir = join(skillsDir, dst)
  if (existsSync(dstDir)) return { error: `a skill named ${dst} already exists` }
  const srcDir = existsSync(join(skillsDir, src, 'SKILL.md')) ? join(skillsDir, src) : join(pkgSkillsDir, src)
  cpSync(srcDir, dstDir, { recursive: true })
  const md = join(dstDir, 'SKILL.md')
  const text = readFileSync(md, 'utf-8')
  const fm = FRONT_MATTER.exec(text)
  const named = (block: string) => /^name:.*$/m.test(block) ? block.replace(/^name:.*$/m, `name: ${dst}`) : block.replace(/^---\r?\n/, `---\nname: ${dst}\n`)
  writeFileSync(md, fm ? named(fm[0]) + text.slice(fm[0].length) : `---\nname: ${dst}\n---\n${text}`, 'utf-8')
  writeFileSync(join(dstDir, FORK_MARKER), src, 'utf-8')
  return { ok: true }
}

export function removeUserSkill(skillsDir: string, pkgSkillsDir: string, name: unknown): SkillResult {
  const folder = storeName(name)
  if (coreSkillNames(pkgSkillsDir).has(folder)) return { error: 'built-in skills cannot be removed' }
  const dir = join(skillsDir, folder)
  if (!folder || !existsSync(dir)) return { error: 'skill not found' }
  rmSync(dir, { recursive: true, force: true })
  return { ok: true }
}
