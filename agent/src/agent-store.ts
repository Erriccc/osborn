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
}

export const MAX_AGENT_PROMPT = 20000
const MODELS = new Set(['sonnet', 'opus', 'haiku', 'fable', 'inherit'])

export const storeName = (raw: unknown): string =>
  String(raw ?? '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-')

/** Validates user_agents rows. Disabled rows are dropped; a row named after a
 *  core agent is ignored (core agents cannot be overridden or removed). */
export function parseUserAgents(rows: unknown, core: Record<string, unknown>): { agents: Record<string, AgentDef>; forkedFrom: Record<string, string>; ignored: string[] } {
  const agents: Record<string, AgentDef> = {}
  const forkedFrom: Record<string, string> = {}
  const ignored: string[] = []
  for (const r of Array.isArray(rows) ? rows : []) {
    const name = storeName(r?.name)
    const description = String(r?.description || '').trim()
    const prompt = String(r?.prompt || '').trim()
    if (!name || r?.enabled === false) continue
    if (name in core) { ignored.push(name); continue }
    if (!description || !prompt || prompt.length > MAX_AGENT_PROMPT) continue
    const from = storeName(r.forkedFrom ?? r.forked_from)
    if (from) forkedFrom[name] = from
    agents[name] = {
      description,
      prompt,
      ...(Array.isArray(r.tools) && r.tools.length ? { tools: r.tools.map(String) } : {}),
      ...(r.model && (MODELS.has(r.model) || /^claude-/.test(r.model)) ? { model: String(r.model) } : {}),
    }
  }
  return { agents, forkedFrom, ignored }
}

/** Effective agent set: every core agent, plus user agents whose names are free. */
export function mergeAgents<T>(core: Record<string, T>, user: Record<string, T> | null | undefined): Record<string, T> {
  const out: Record<string, T> = { ...core }
  for (const [name, a] of Object.entries(user || {})) if (!(name in core)) out[name] = a
  return out
}

/** UI listing: core agents carry their prompt (for View and Fork). */
export function describeAgents(core: Record<string, any>, user: Record<string, AgentDef> | null | undefined, forkedFrom: Record<string, string> = {}, withPrompts = false): AgentListing[] {
  return Object.entries(mergeAgents<any>(core, user)).map(([name, a]) => {
    const isCore = name in core
    return {
      name, description: a.description, model: a.model, tools: a.tools, core: isCore,
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
