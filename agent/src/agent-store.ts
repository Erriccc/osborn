// Agent & skill store rules. Built-in (core) agents and shipped skills are
// maintained by Voice Native: users can view and fork them, never override,
// edit or remove them. A fork is a user-owned copy under a new name.
import { existsSync, readdirSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export interface AgentDef { description: string; prompt: string; tools?: string[]; model?: string }
export interface AgentListing {
  name: string
  description: string
  model?: string
  tools?: string[]
  core: boolean
  prompt?: string
  forkedFrom?: string
  role: Role
  behaviours: string[]
}

// ── Roles ────────────────────────────────────────────────────────────────────
// What an agent may do is decided by its ROLE, never its name, so a fork or an
// imported agent carries the behaviour of the role it holds. Core agents hold
// the role of the same name; a fork inherits its parent's; any other agent's is
// set by its owner or inferred from its tools.

/** 'workspace': session workspace only. 'anywhere': any path, through the
 *  permission dialog. Extension rule: only matching files (fail closed). */
export type WriteRule =
  | 'workspace'
  | 'anywhere'
  | { extensions: RegExp; label: string; matchBasename?: boolean }

export const ROLE_NAMES = ['reader', 'researcher', 'reasoner', 'planner', 'writer', 'tester', 'steward', 'reviewer'] as const
export type Role = typeof ROLE_NAMES[number]
export const isRole = (r: unknown): r is Role => typeof r === 'string' && (ROLE_NAMES as readonly string[]).includes(r)

export interface RoleSpec {
  /** One line for people choosing a role. */
  summary: string
  write: WriteRule
  /** Writes into .claude/skills/<name>/ are approved without a dialog. */
  skillInstall?: boolean
  /** Its first edit of an existing file each turn is held once with a history reminder; its writes show in the live trace. */
  historyFirst?: boolean
  /** Its final message is parsed into a steward verdict card. */
  verdict?: boolean
  /** Verifier chain: dispatched beside it (parallelAtStart) and run after it (next). The text pushed to the
   *  orchestrator when it finishes is a prompt: prompts/chain-after-<role>.md (getChainReminder). */
  chain?: { next: Role[]; parallelAtStart?: Role[] }
}

export const ROLES: Record<Role, RoleSpec> = {
  reader: { summary: 'Reads and reports. Writes only notes in the session workspace.', write: 'workspace' },
  researcher: {
    summary: 'Gathers facts from code and the web; a reasoner checks its findings before they are used.',
    write: 'workspace',
    chain: {
      next: ['reasoner'],
    },
  },
  reasoner: { summary: 'Thinks through hard problems and gates research. Does not edit files.', write: 'workspace' },
  planner: {
    summary: 'Writes a step plan; the steward checks it for things that already exist before the writer starts.',
    write: 'workspace',
    chain: {
      next: ['steward', 'writer'],
    },
  },
  writer: {
    summary: 'Changes code anywhere (you approve each write); its work is tested, stewarded and reviewed.',
    write: 'anywhere',
    skillInstall: true,
    historyFirst: true,
    chain: {
      next: ['tester', 'steward', 'reviewer'],
      parallelAtStart: ['tester'],
    },
  },
  tester: { summary: 'Writes and runs tests. May write test files only.', write: { extensions: /\.(test|spec)\.[jt]sx?$/, label: 'test', matchBasename: true } },
  steward: {
    summary: 'Guards against duplication and regressions; its verdict shows as a card in chat.',
    write: 'anywhere',  // refactors the writer's diff in place
    verdict: true,
  },
  reviewer: { summary: 'Reviews the final diff for a verdict. May write documentation files only.', write: { extensions: /\.(md|markdown|mdx|txt|rst|adoc)$/i, label: 'documentation' } },
}

/** The built-in agents and the role each holds. */
export const CORE_AGENT_ROLES: Record<string, Role> = {
  researcher: 'researcher', reasoner: 'reasoner', planner: 'planner', writer: 'writer',
  tester: 'tester', steward: 'steward', reviewer: 'reviewer',
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
/** An agent with no role set: one that can edit is a writer, anything else a reader. */
export const inferRole = (tools?: string[] | null): Role =>
  (tools || []).some((t) => EDIT_TOOLS.has(String(t).trim())) ? 'writer' : 'reader'

/** Role of a non-core agent: the one set on it, else its parent's, else inferred from its tools. */
export function resolveRole(a: { role?: unknown; forkedFrom?: string; tools?: string[] }): Role {
  if (isRole(a.role)) return a.role
  if (a.forkedFrom && Object.hasOwn(CORE_AGENT_ROLES, a.forkedFrom)) return CORE_AGENT_ROLES[a.forkedFrom]
  return inferRole(a.tools)
}

/** The acting agent's role (null = the main orchestrator, or an agent we do not know). */
export function roleOf(agentType: string | null | undefined, roles: Record<string, Role> = CORE_AGENT_ROLES): Role | null {
  if (!agentType) return null
  return (Object.hasOwn(roles, agentType) ? roles[agentType] : undefined) ?? (Object.hasOwn(CORE_AGENT_ROLES, agentType) ? CORE_AGENT_ROLES[agentType] : null)
}

/** What a role unlocks, in plain words for the store. */
export function roleBehaviours(role: Role, core = true): string[] {
  const r = ROLES[role]
  const out: string[] = []
  if (r.write === 'workspace') out.push('Writes only in the session workspace')
  else if (r.write === 'anywhere') out.push('Can edit files anywhere — you approve each write')
  else out.push(`Can write ${r.write.label} files only`)
  if (r.skillInstall && core) out.push('Installs skills without asking for each file')  // built-in agents only
  if (r.historyFirst) out.push("Checks a file's history before its first edit")
  if (r.verdict) out.push('Its verdict shows as a card in chat')
  if (r.chain?.parallelAtStart?.length) out.push(`Runs alongside the ${r.chain.parallelAtStart.join(', ')}`)
  if (r.chain) out.push(`When it finishes: ${r.chain.next.join(' → ')}`)
  return out
}

/** The automatic chains, e.g. ['writer', 'tester', 'steward', 'reviewer']. */
export const roleChains = (): Role[][] =>
  ROLE_NAMES.filter((r) => ROLES[r].chain).map((r) => [r, ...ROLES[r].chain!.next])

/** Role descriptions for the store's role picker and chain strip. */
export const describeRoles = () => ({
  roles: ROLE_NAMES.map((role) => ({ role, summary: ROLES[role].summary, behaviours: roleBehaviours(role) })),
  chains: roleChains(),
})

/** forked_from of an agent installed from a catalog: '<source>:<owner>/<repo>@<sha>/<path>'. */
export const CATALOG_ORIGIN = /^[a-z0-9-]+:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{7,40}\/[A-Za-z0-9_./-]{1,200}$/

export const MAX_AGENT_PROMPT = 20000
const MODELS = new Set(['sonnet', 'opus', 'haiku', 'fable', 'inherit'])
export const isAgentModel = (m: unknown): m is string => typeof m === 'string' && (MODELS.has(m) || /^claude-/.test(m))

export const storeName = (raw: unknown): string =>
  String(raw ?? '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-')

/** Validates user_agents rows. Disabled rows are dropped; a row named after a
 *  core agent is ignored (core agents cannot be overridden or removed). */
export function parseUserAgents(rows: unknown, core: Record<string, unknown>): { agents: Record<string, AgentDef>; forkedFrom: Record<string, string>; roles: Record<string, Role>; ignored: string[] } {
  const agents: Record<string, AgentDef> = {}
  const forkedFrom: Record<string, string> = {}
  const roles: Record<string, Role> = {}
  const ignored: string[] = []
  for (const r of Array.isArray(rows) ? rows : []) {
    const name = storeName(r?.name)
    const description = String(r?.description || '').trim()
    const prompt = String(r?.prompt || '').trim()
    if (!name || r?.enabled === false) continue
    if (name in core) { ignored.push(name); continue }
    if (!description || !prompt || prompt.length > MAX_AGENT_PROMPT) continue
    const rawFrom = String(r.forkedFrom ?? r.forked_from ?? '').trim()
    const from = CATALOG_ORIGIN.test(rawFrom) ? rawFrom : storeName(rawFrom)
    if (from) forkedFrom[name] = from
    const tools: string[] | undefined = Array.isArray(r.tools) && r.tools.length ? r.tools.map(String) : undefined
    roles[name] = resolveRole({ role: r.role, forkedFrom: from, tools })
    agents[name] = {
      description,
      prompt,
      ...(tools ? { tools } : {}),
      ...(isAgentModel(r.model) ? { model: r.model } : {}),
    }
  }
  return { agents, forkedFrom, roles, ignored }
}

/** Effective agent set: every core agent, plus user agents whose names are free. */
export function mergeAgents<T>(core: Record<string, T>, user: Record<string, T> | null | undefined): Record<string, T> {
  const out: Record<string, T> = { ...core }
  for (const [name, a] of Object.entries(user || {})) if (!(name in core)) out[name] = a
  return out
}

/** UI listing: core agents carry their prompt (for View and Fork). */
export function describeAgents(core: Record<string, any>, user: Record<string, AgentDef> | null | undefined, forkedFrom: Record<string, string> = {}, withPrompts = false, roles: Record<string, Role> = {}): AgentListing[] {
  return Object.entries(mergeAgents<any>(core, user)).map(([name, a]) => {
    const isCore = name in core
    const role = roleOf(name, roles) ?? resolveRole({ forkedFrom: forkedFrom[name], tools: a.tools })
    return {
      name, description: a.description, model: a.model, tools: a.tools, core: isCore, role, behaviours: roleBehaviours(role, isCore),
      ...(isCore && withPrompts ? { prompt: a.prompt } : {}),  // prompts are large: GET /agents only, never the data channel
      ...(!isCore && forkedFrom[name] ? { forkedFrom: forkedFrom[name] } : {}),
    }
  })
}

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

/** Copies a core skill folder to a new user-owned name. */
export function forkSkill(skillsDir: string, pkgSkillsDir: string, from: string, to: string): { ok: true } | { error: string } {
  const core = coreSkillNames(pkgSkillsDir)
  const src = storeName(from), dst = storeName(to)
  if (!core.has(src)) return { error: 'only built-in skills can be forked' }
  if (!dst || core.has(dst)) return { error: 'choose a new name that is not a built-in skill' }
  const dstDir = join(skillsDir, dst)
  if (existsSync(dstDir)) return { error: `a skill named ${dst} already exists` }
  const srcDir = existsSync(join(skillsDir, src, 'SKILL.md')) ? join(skillsDir, src) : join(pkgSkillsDir, src)
  cpSync(srcDir, dstDir, { recursive: true })
  const md = join(dstDir, 'SKILL.md')
  writeFileSync(md, readFileSync(md, 'utf-8').replace(/^name:\s*.*$/m, `name: ${dst}`), 'utf-8')
  writeFileSync(join(dstDir, FORK_MARKER), src, 'utf-8')
  return { ok: true }
}

export function removeUserSkill(skillsDir: string, pkgSkillsDir: string, name: string): { ok: true } | { error: string } {
  const folder = storeName(name)
  if (coreSkillNames(pkgSkillsDir).has(folder)) return { error: 'built-in skills cannot be removed' }
  const dir = join(skillsDir, folder)
  if (!folder || !existsSync(dir)) return { error: 'skill not found' }
  rmSync(dir, { recursive: true, force: true })
  return { ok: true }
}
